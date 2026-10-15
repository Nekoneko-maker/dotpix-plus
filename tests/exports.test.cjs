const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);

function app(){
  const elements=new Map();
  const get=id=>{
    if(!elements.has(id)) elements.set(id,{
      value:id==='videoFormat'?'auto':id==='videoAudioMode'?'sr22':id==='videoCompareVolume'?'80':'',
      style:{},attributes:{},events:{},checked:false,
      classList:{toggle(){}},pause(){},load(){},scrollIntoView(){},
      removeAttribute(name){delete this[name];},
      setAttribute(name,value){this.attributes[name]=String(value);},
      addEventListener(name,handler){this.events[name]=handler;}
    });
    return elements.get(id);
  };
  const context={document:{getElementById:get,addEventListener(){},removeEventListener(){}},window:{addEventListener(){}},Blob,AbortController,DOMException,setTimeout,clearTimeout,cancelAnimationFrame(){},console};
  vm.createContext(context);
  vm.runInContext(script.slice(0,script.lastIndexOf('initCompactUI();')),context);
  return {context,get,run:code=>vm.runInContext(code,context)};
}

// Independent GIF decoder checks code-width transitions and dictionary clears.
function decodeLZW(bytes,minBits,size){
  const clear=1<<minBits,end=clear+1;
  let dictionary,bits,next,previous=null,position=0;
  const reset=()=>{dictionary=Array.from({length:clear},(_,i)=>[i]);bits=minBits+1;next=end+1;previous=null;};
  reset();
  const result=[];
  while(position+bits<=bytes.length*8){
    let code=0;
    for(let i=0;i<bits;i++,position++) code|=((bytes[position>>3]>>(position&7))&1)<<i;
    if(code===clear){reset();continue;}
    if(code===end) break;
    const entry=dictionary[code]||(code===next&&previous?[...previous,previous[0]]:null);
    assert(entry,'valid dictionary code');
    result.push(...entry);
    if(previous&&next<4096){
      dictionary[next++]=[...previous,entry[0]];
      if(next===(1<<bits)&&bits<12) bits++;
    }
    previous=entry;
  }
  assert.equal(result.length,size);
  return Uint8Array.from(result);
}

function frame(width,height,colors,offset=0){
  const pixels=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<width*height;i++) pixels.set([...colors[(i+offset)%colors.length],255],i*4);
  return {width,height,getContext:()=>({getImageData:()=>({data:pixels})})};
}

test('GIF LZW round trips all table sizes, dictionary growth, resets and final codes',()=>{
  const {context}=app();
  let seed=1;
  for(const minBits of [2,3,4,5,6,7,8]) for(const size of [1,2,254,255,256,257,4096,100000]){
    const input=Uint8Array.from({length:size},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed>>>16)% (1<<minBits);});
    const encoded=context.encodeGIFLZW(input,minBits);
    assert.deepEqual(decodeLZW(encoded,minBits,input.length),input,`bits=${minBits}, size=${size}`);
  }
});

test('GIF output contains a global palette, loop extension, every frame and correct delays',async()=>{
  const {context}=app(),colors=[[255,0,0],[0,255,0],[0,0,255]],frames=Array.from({length:12},(_,i)=>frame(17,9,colors,i));
  const canvas={width:34,height:18,getContext:()=>({})};
  const blob=await context.encodePixelAnimation(canvas,frames,12,1,'gif',colors,new AbortController().signal,()=>{});
  const bytes=Buffer.from(await blob.arrayBuffer());
  assert.equal(blob.type,'image/gif');assert.equal(bytes.subarray(0,6).toString(),'GIF89a');
  assert.equal(bytes.readUInt16LE(6),34);assert.equal(bytes.readUInt16LE(8),18);
  assert(bytes.includes(Buffer.from('NETSCAPE2.0')));
  let offset=13+3*(1<<((bytes[10]&7)+1)),count=0,time=0;
  while(bytes[offset]!==59){
    if(bytes[offset]===33){
      if(bytes[offset+1]===249) time+=bytes.readUInt16LE(offset+4);
      offset+=2;
      while(bytes[offset]) offset+=bytes[offset]+1;
      offset++;
    }else{
      assert.equal(bytes[offset],44);offset+=10;
      const minBits=bytes[offset++],blocks=[];
      while(bytes[offset]){const n=bytes[offset++];blocks.push(bytes.subarray(offset,offset+n));offset+=n;}
      offset++;
      const actual=decodeLZW(Buffer.concat(blocks),minBits,34*18);
      const expected=context.gifFrameIndices(frames[count],34,18,colors,new Map());
      assert.deepEqual(actual,Uint8Array.from(expected));count++;
    }
  }
  assert.equal(count,12);assert.equal(time,100);assert.equal(offset,bytes.length-1);
});

test('GIF reduces palettes above 256 colors and handles a single color',()=>{
  const {context}=app();
  assert.equal(context.makeGIFPalette([[1,2,3]]).length,1);
  assert(context.makeGIFPalette(Array.from({length:300},(_,i)=>[i%256,Math.floor(i/256)*255,0])).length<=256);
});

test('WebP chunks preserve padding and reject PNG fallback / malformed frames',async()=>{
  const {context}=app();
  const chunk=context.riffChunk('VP8 ',[new Uint8Array([1,2,3])]);
  const body=new Blob(['WEBP',chunk]),head=new Uint8Array([82,73,70,70,0,0,0,0]);
  context.putLE(head,4,body.size,4);
  const bytes=new Uint8Array(await new Blob([head,body]).arrayBuffer());
  const payload=context.webPFramePayload(bytes);
  assert.equal(payload.parts.length,1);assert.equal(payload.parts[0].length,12);assert.equal(payload.alpha,false);
  assert.throws(()=>context.webPFramePayload(new Uint8Array(12)),/WebP/);
  assert.throws(()=>context.webPFramePayload(bytes.subarray(0,bytes.length-2)),/WebP/);
});

test('animated WebP has the correct dimensions, loop and frame durations',async()=>{
  const {context}=app();
  const image=await context.riffChunk('VP8 ',[new Uint8Array([1,2,3])]).arrayBuffer();
  const body=new Blob(['WEBP',image]),head=new Uint8Array([82,73,70,70,0,0,0,0]);context.putLE(head,4,body.size,4);
  const still=new Blob([head,body],{type:'image/webp'});
  const canvas={width:17,height:9,getContext:()=>({fillRect(){},drawImage(){}}),toBlob(callback){callback(still);}};
  const blob=await context.encodePixelAnimation(canvas,[{},{}],12,2/12,'webp',[],new AbortController().signal,()=>{});
  const bytes=Buffer.from(await blob.arrayBuffer());
  assert.equal(blob.type,'image/webp');assert.equal(bytes.readUInt32LE(4),bytes.length-8);
  assert.equal(bytes[20],2);assert.equal(bytes.readUIntLE(24,3)+1,17);assert.equal(bytes.readUIntLE(27,3)+1,9);
  let frames=0,time=0;
  for(let offset=12;offset<bytes.length;){
    const name=bytes.subarray(offset,offset+4).toString(),length=bytes.readUInt32LE(offset+4);
    if(name==='ANMF'){
      assert.equal(bytes.readUIntLE(offset+14,3)+1,17);assert.equal(bytes.readUIntLE(offset+17,3)+1,9);
      time+=bytes.readUIntLE(offset+20,3);frames++;
    }
    offset+=8+length+(length%2);
  }
  assert.equal(frames,2);assert.equal(time,167);
});

test('animation cancellation rejects before producing output',async()=>{
  const {context}=app(),controller=new AbortController();controller.abort();
  await assert.rejects(context.encodePixelAnimation({width:1,height:1,getContext:()=>({})},[frame(1,1,[[0,0,0]])],12,1,'gif',[[0,0,0]],controller.signal,()=>{}),{name:'AbortError'});
});

test('WebP encoding rejects browser PNG fallback instead of renaming it',async()=>{
  const {context}=app();
  const canvas={width:1,height:1,getContext:()=>({fillRect(){},drawImage(){}}),toBlob(callback){callback(new Blob(['PNG'],{type:'image/png'}));}};
  await assert.rejects(context.encodePixelAnimation(canvas,[{}],12,1,'webp',[],new AbortController().signal,()=>{}),/WebP/);
});

test('explicit MP4 never falls back to mislabeled WebM',()=>{
  const {context}=app();
  assert.equal(context.selectVideoMime('auto',false),'');
  context.MediaRecorder={isTypeSupported:type=>type.startsWith('video/webm')};
  assert.equal(context.selectVideoMime('mp4',true),'');
  assert.match(context.selectVideoMime('auto',true),/^video\/webm/);
  context.MediaRecorder={isTypeSupported:type=>type==='video/mp4'};
  assert.equal(context.selectVideoMime('webm',false),'');assert.equal(context.selectVideoMime('mp4',true),'video/mp4');
});

test('animation format disables audio without changing saved preferences',()=>{
  const {get,run}=app();
  run('forceVideoAudioMono=true');get('videoFormat').value='gif';
  run('updateVideoAudioHint(false)');
  assert.equal(get('videoAudioMode').disabled,true);assert.equal(get('videoAudioMode').value,'sr22');assert.equal(get('videoAudioMono').checked,true);
  get('videoFormat').value='mp4';run('updateVideoAudioHint(false)');
  assert.equal(get('videoAudioMode').disabled,false);assert.equal(get('videoAudioMono').disabled,false);assert.equal(get('videoAudioMono').checked,true);
});

test('on-image comparison retains the master and seek bar without the redundant range',()=>{
  const {get,run}=app();
  assert(!html.includes('id="videoCompareRange"'));assert(html.includes('id="videoCompareTime"'));assert(html.includes('id="videoCompareVolume"'));
  run('setVideoCompareRatio(125)');assert.equal(get('videoCompareDivider').attributes['aria-valuenow'],'100');
  assert.equal(get('videoCompareProcessed').style.clipPath,'inset(0 0% 0 0)');
  run('setVideoCompareRatio(-10)');assert.equal(get('videoCompareRatio').textContent,'加工後 0%');
  run('initVideoComparison()');
  get('videoCompareDivider').events.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(get('videoCompareDivider').attributes['aria-valuenow'],'1');
});

test('master volume still controls both sides of the on-image crossfade',async()=>{
  const {context,get,run}=app();
  class Gain{
    constructor(){
      this.outputs=[];
      this.gain={value:1,cancelScheduledValues(){},setTargetAtTime(v){this.value=v;},setValueAtTime(v){this.value=v;},linearRampToValueAtTime(v){this.value=v;}};
    }
    connect(node){this.outputs.push(node);return node;}
  }
  class AudioContext{
    constructor(){this.destination={};this.currentTime=0;}
    createGain(){return new Gain();}
    createMediaElementSource(){return new Gain();}
    async resume(){}
  }
  context.window.AudioContext=AudioContext;
  await run("currentMedia='video';pixelVideoView='compare';pixelVideoResultAudio='sr22';ensureVideoCompareAudio()");
  const graph=run('videoCompareAudio');
  assert.deepEqual(graph.original.outputs,[graph.master]);assert.deepEqual(graph.processed.outputs,[graph.master]);
  for(const ratio of [0,50,100]) for(const level of [0,25,100]){
    get('videoCompareVolume').value=level;
    run(`setVideoCompareRatio(${ratio})`);
    assert.equal(graph.original.gain.value,1-ratio/100);assert.equal(graph.processed.gain.value,ratio/100);
    assert.equal(graph.master.gain.value,level/100);assert.equal(get('pixelVideoSource').muted,level===0);
    assert.equal(get('pixelVideoResult').muted,level===0);
  }
});

test('conversion routes GIF to animated preview, keeps video comparison for MP4 and releases frames',async()=>{
  const {context,get,run}=app();
  const canvases=[],colors=[[255,0,0],[0,0,255]];
  context.document.createElement=()=>{
    const canvas=frame(2,1,colors);
    canvas.getContext=()=>({getImageData:()=>({data:new Uint8ClampedArray([255,0,0,255,0,0,255,255])}),drawImage(){}});
    canvases.push(canvas);return canvas;
  };
  context.URL={createObjectURL:()=> 'blob:test',revokeObjectURL(){}};
  context.HTMLCanvasElement={prototype:{captureStream(){}}};
  context.MediaRecorder={isTypeSupported:()=>true};
  Object.assign(get('pixelVideoSource'),{videoWidth:4,videoHeight:2,duration:1});
  get('videoStart').value=0;get('videoEnd').value=1/3;get('videoFPS').value=6;get('videoDotSize').checked=true;
  run(`
    currentMedia='video';
    setVideoBusy=()=>{};
    seekPixelVideo=async()=>{};
    getSmallSize=()=>[2,1];
    selectProcessingPalette=()=>[[255,0,0],[0,0,255]];
    processOneImage=()=>({dot:document.createElement('canvas')});
    recordPixelFrames=async()=>new Blob(['mp4'],{type:'video/mp4'});
  `);
  get('videoFormat').value='gif';
  await run('runPixelVideo(false)');
  assert.match(get('videoStatus').textContent,/変換完了/);
  assert.equal(run('videoOutputKind'),'animation');assert.equal(run('pixelVideoResultAudio'),'none');
  assert.equal(get('pixelAnimationResult').hidden,false);assert.equal(get('pixelVideoResult').hidden,true);
  assert.equal(get('btnVideoCompare').disabled,true);assert.equal(get('videoSaveLink').download,'video_pixel_1x.gif');
  assert.equal(run('pixelVideoCompareFrames.length'),0);
  assert(canvases.every(c=>c.width===1&&c.height===1));
  get('videoFormat').value='mp4';get('videoAudioMode').value='none';
  await run('runPixelVideo(false)');
  assert.match(get('videoStatus').textContent,/変換完了/);
  assert.equal(run('videoOutputKind'),'video');assert.equal(run('pixelVideoCompareFrames.length'),2);
  assert.equal(get('pixelAnimationResult').hidden,true);assert.equal(get('pixelVideoResult').hidden,false);
  assert.equal(get('btnVideoCompare').disabled,false);assert.equal(get('videoSaveLink').download,'video_pixel_1x.mp4');
  run('clearVideoCompareFrames()');assert(canvases.every(c=>c.width===1&&c.height===1));
});
