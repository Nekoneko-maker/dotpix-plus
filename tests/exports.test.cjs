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
  const context={document:{getElementById:get,querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},removeEventListener(){}},window:{addEventListener(){},removeEventListener(){}},Blob,AbortController,DOMException,setTimeout,clearTimeout,cancelAnimationFrame(){},console};
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
  for(const axis of ['x','y']) for(const ratio of [0,50,100]) for(const level of [0,25,100]){
    run(`suppressAutoApply=true;setCompareAxis('${axis}')`);
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
  Object.assign(get('pixelVideoSource'),{videoWidth:4,videoHeight:2,duration:1,readyState:3});
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

test('comparison axis switches clipping, divider positions and pointer coordinate without reprocessing',()=>{
  const {context,get,run}=app();
  let processed=0;context.process=()=>processed++;
  get('pixelVideoResult').currentTime=2.5;
  run("suppressAutoApply=true;viewMode='slider';compareSliderPos=25;videoCompareRatio=75;setCompareAxis('y')");
  assert.equal(get('compareDirection').hidden,false);
  assert.equal(get('compareOverlay').style.clipPath,'inset(0 0 75% 0)');
  assert.equal(get('compareDivider').style.top,'calc(25% - 1px)');
  assert.equal(get('compareHandle').style.top,'25%');
  assert.equal(get('videoCompareDivider').style.top,'75%');
  assert.equal(get('videoCompareDivider').attributes['aria-orientation'],'vertical');
  assert.equal(get('videoCompareProcessed').style.clipPath,'inset(0 0 25% 0)');
  assert.equal(context.comparePointerPosition({clientX:150,clientY:30},{left:10,top:10,width:200,height:100}),20);
  run("setCompareAxis('x')");
  assert.equal(get('compareOverlay').style.clipPath,'inset(0 75% 0 0)');
  assert.equal(get('compareDivider').style.top,'0');assert.equal(get('compareHandle').style.top,'50%');
  assert.equal(get('videoCompareDivider').style.top,'0');assert.equal(get('videoCompareDivider').style.left,'75%');
  assert.equal(context.comparePointerPosition({clientX:150,clientY:30},{left:10,top:10,width:200,height:100}),70);
  assert.equal(processed,0);
  assert.equal(get('pixelVideoResult').currentTime,2.5);
  assert.equal(run('getSettingsPayload().compareAxis'),'x');
  run("setCompareAxis('y');initVideoComparison()");
  get('videoCompareDivider').events.keydown({key:'ArrowDown',preventDefault(){}});
  assert.equal(run('videoCompareRatio'),76);
});

test('direction controls only appear in an active image/video slider comparison',()=>{
  const {get,run}=app();
  for(const [media,view,videoView,hidden] of [['image','both','source',true],['image','slider','source',false],['video','slider','source',true],['video','both','compare',false]]){
    run(`currentMedia='${media}';viewMode='${view}';pixelVideoView='${videoView}';updateCompareDirectionUI()`);
    assert.equal(get('compareDirection').hidden,hidden);
  }
});

test('dot presets preserve color/dither/random preferences and process an image once',()=>{
  const {context,get,run}=app();
  const selected={dataset:{dotCount:'128'},setAttribute(name,value){this[name]=value;}};
  context.document.querySelectorAll=()=>[selected];
  let processed=0;
  context.process=()=>processed++;
  context.scheduleSettingsSave=()=>{};
  run("origImg={width:800,height:400};retroMode='pc98';ditherMode='fs';retroDeterministic=true;applyDotPreset('dotcount',128)");
  assert.equal(run('specMode'),'dotcount');assert.equal(get('dotCountNumInline').value,128);
  assert.deepEqual(Array.from(run('getSmallSize()')),[128,64]);
  assert.equal(run('retroMode'),'pc98');assert.equal(run('ditherMode'),'fs');assert.equal(run('retroDeterministic'),true);
  assert.equal(selected['aria-pressed'],'true');assert.equal(processed,1);
  run("currentMedia='video';applyDotPreset('dotsize',8)");
  assert.equal(processed,1);assert.equal(get('dotNumInline').value,8);
  assert.match(get('statusBox').textContent,/動画を変換/);
  assert.equal(run('getSettingsPayload().dotSize'),8);
});

test('SFC mode produces bounded unique RGB555 colors and reproducible optional output',()=>{
  const {context,run}=app();
  const levels=new Set(Array.from({length:32},(_,i)=>Math.round(i*255/31)));
  const pixels=new Uint8ClampedArray(1024*4);
  for(let i=0;i<1024;i++) pixels.set([i%256,(i*23)%256,(i*73)%256,255],i*4);
  run("suppressAutoApply=true;switchRetroMode('sfc')");
  assert.equal(run('getRetroPalette().length'),32768);
  for(const count of [2,32,256]){
    const colors=context.reduceRetroKMeans({data:pixels},run('getRetroPalette()'),count,0,10,true);
    assert(colors.length>0&&colors.length<=count);
    assert(colors.every(color=>color.every(value=>levels.has(value))));
    assert.equal(new Set(colors.map(c=>c.join(','))).size,colors.length);
    assert.deepEqual(colors,context.reduceRetroKMeans({data:pixels},run('getRetroPalette()'),count,0,10,true));
  }
  run("syncRetroCount('SFC',500)");assert.equal(run('retroCountVal.sfc'),256);
  assert.equal(run('getSettingsPayload().retroMode'),'sfc');
});

test('SFC preset sets palette and drawing options with only one image reprocess',()=>{
  const {context,get,run}=app();let processed=0;
  context.process=()=>processed++;
  context.scheduleSettingsSave=()=>{};
  run("origImg={width:100,height:100};dotCanvas={};applyPreset('sfc')");
  assert.equal(processed,1);assert.equal(run('retroMode'),'sfc');assert.equal(run('retroCountVal.sfc'),32);
  assert.equal(run('pixelMode'),'B');assert.equal(run('ditherMode'),'bayer');
  assert.equal(get('retroInfoSFC').style.display,'');assert.equal(get('retroInfoPC98').style.display,'none');
  assert.equal(get('crtAspect').checked,false);assert.equal(run('retroDeterministic'),false);
});

test('saved SFC count, dot settings and comparison direction restore; old settings default safely',()=>{
  const {context,get,run}=app();
  for(const fn of ['renderRow','updateCRTOverlay','updateExportSection','renderPriorityList','setExportScale','setExportAlg','switchTheme']) context[fn]=()=>{};
  context.scheduleSettingsSave=()=>{};
  run("applySettingsPayload({retroMode:'sfc',retroCount:{sfc:48},specMode:'dotcount',dotCount:128,compareAxis:'y',customMode:false})");
  assert.equal(run('retroMode'),'sfc');assert.equal(run('retroCountVal.sfc'),48);
  assert.equal(get('dotCountNumInline').value,128);assert.equal(run('compareAxis'),'y');
  assert.equal(run('getSettingsPayload().compareAxis'),'y');
  run("applySettingsPayload({retroMode:'fc',retroCount:{fc:12,pce:16,pc98:16},customMode:false})");
  assert.equal(run('retroMode'),'fc');assert.equal(run('retroCountVal.sfc'),32);assert.equal(run('compareAxis'),'x');
});

class Player{
  constructor(id){this.id=id;this.handlers=new Map();this.currentTime=0;this.duration=5;this.readyState=3;this.paused=true;this.seeking=false;this.ended=false;this.playbackRate=1;this.muted=false;this.volume=.8;this.src='blob:'+id;}
  addEventListener(name,handler,options){
    if(!this.handlers.has(name)) this.handlers.set(name,new Map());
    this.handlers.get(name).set(handler,options?.once);
  }
  removeEventListener(name,handler){this.handlers.get(name)?.delete(handler);}
  dispatch(name){for(const [handler,once] of [...(this.handlers.get(name)||[])]){if(once)this.removeEventListener(name,handler);handler();}}
  pause(){this.paused=true;}
  async play(){this.paused=false;this.ended=false;}
  load(){}
  removeAttribute(name){this[name]='';}
  cloneNode(){const fresh=new Player(this.id);fresh.src=this.src;return fresh;}
}

test('a matching currentTime still waits for an in-flight seek and can be aborted',async()=>{
  const {context}=app(),player=new Player('test');player.currentTime=2;player.seeking=true;
  const controller=new AbortController();let done=false;
  const task=context.seekPixelVideo(player,2,controller.signal).then(()=>{done=true;});
  await Promise.resolve();assert.equal(done,false);
  player.seeking=false;player.dispatch('seeked');await task;assert.equal(done,true);
  player.seeking=true;
  const cancelled=context.seekPixelVideo(player,2,controller.signal);
  controller.abort();await assert.rejects(cancelled,{name:'AbortError'});
  assert.equal(player.handlers.get('seeked').size,0);
});

function playbackApp(){
  const fixture=app(),players=new Map(['pixelVideoSource','pixelVideoResult'].map(id=>[id,new Player(id)]));
  const {context,run,get}=fixture;
  context.document.getElementById=id=>players.get(id)||get(id);
  context.requestAnimationFrame=()=>1;
  context.ensureVideoCompareAudio=async()=>{};
  context.seekPixelVideo=async(player,time)=>{player.currentTime=time;player.seeking=false;};
  context.startVideoCompareVisuals=()=>run('videoCompareVisual={revision:0,frameIndex:-1}');
  context.renderVideoComparePair=async()=>{};
  run("currentMedia='video';pixelVideoView='compare';pixelVideoResultRange={start:10,duration:5,fps:12}");
  players.get('pixelVideoSource').duration=30;
  return {...fixture,players};
}

test('20 repeated replays start both clocks at the selected beginning with fresh playback rates',async()=>{
  const {context,run,players,get}=playbackApp();
  const source=players.get('pixelVideoSource'),output=players.get('pixelVideoResult');
  for(let i=0;i<20;i++){
    output.currentTime=5;output.ended=true;source.currentTime=15;
    output.playbackRate=.75;source.playbackRate=1.05;
    await context.toggleVideoComparePlayback();
    assert.equal(output.currentTime,0);assert.equal(source.currentTime,10);
    assert.equal(output.playbackRate,1);assert.equal(source.playbackRate,1);
    assert.equal(output.paused,false);assert.equal(source.paused,false);
    assert.equal(get('videoComparePlay').textContent,'一時停止');
    run('pauseVideoComparison()');assert.equal(run('videoComparePlayback'),null);
  }
});

test('an aborted old start cannot pause a newer playback or replace its status',async()=>{
  const {context,run,players,get}=playbackApp();let rejectOld;
  context.ensureVideoCompareAudio=()=>new Promise((_,reject)=>{rejectOld=reject;});
  const old=context.toggleVideoComparePlayback();
  run('pauseVideoComparison()');
  context.ensureVideoCompareAudio=async()=>{};
  await context.toggleVideoComparePlayback();
  rejectOld(new Error('obsolete audio resume failure'));await old;
  assert.equal(players.get('pixelVideoResult').paused,false);
  assert.equal(get('videoComparePlay').textContent,'一時停止');
  assert.match(get('videoCompareStatus').textContent,/同期再生中/);
  run('pauseVideoComparison()');
});

test('comparison playback waits for both players and the visual before starting audio',async()=>{
  const {context,players,run}=playbackApp();let finishSeek,finishFrame;
  context.seekPixelVideo=async(player,time)=>{
    player.currentTime=time;
    if(player.id==='pixelVideoSource') await new Promise(resolve=>{finishSeek=resolve;});
  };
  context.renderVideoComparePair=()=>new Promise(resolve=>{finishFrame=resolve;});
  const task=context.toggleVideoComparePlayback();
  await new Promise(setImmediate);
  assert.equal(players.get('pixelVideoResult').paused,true);assert.equal(typeof finishSeek,'function');
  finishSeek();await new Promise(setImmediate);
  assert.equal(players.get('pixelVideoResult').paused,true);assert.equal(typeof finishFrame,'function');
  finishFrame();await task;
  assert.equal(players.get('pixelVideoResult').paused,false);
  run('pauseVideoComparison()');
});

test('replay seeks away from the ended frame before waiting for playable data',async()=>{
  const {context,players,run}=playbackApp(),output=players.get('pixelVideoResult');
  output.currentTime=5;output.ended=true;output.readyState=2;
  const task=context.toggleVideoComparePlayback();await new Promise(setImmediate);
  assert.equal(output.currentTime,0);assert.equal(output.paused,true);
  assert.equal(output.handlers.get('canplay').size,1);
  output.readyState=3;output.dispatch('canplay');await task;
  assert.equal(output.paused,false);run('pauseVideoComparison()');
});

test('a buffering event stops both players and cancels the active comparison session',async()=>{
  const {context,players,run,get}=playbackApp();
  const source=players.get('pixelVideoSource'),output=players.get('pixelVideoResult');
  context.bindVideoPlayerEvents(source);
  await context.toggleVideoComparePlayback();
  source.dispatch('waiting');
  assert.equal(source.paused,true);assert.equal(output.paused,true);assert.equal(run('videoComparePlayback'),null);
  assert.match(get('videoCompareStatus').textContent,/読み込み待ち/);
});

test('comparison presentation compensates reported latency without accumulating it',()=>{
  const {context,run,players}=playbackApp(),output=players.get('pixelVideoResult');
  output.currentTime=2;output.paused=false;
  run('videoCompareAudio={context:{state:"running",baseLatency:.02,outputLatency:.08}}');
  for(let i=0;i<20;i++) assert.equal(context.videoComparePresentationTime(),1.9);
  output.paused=true;assert.equal(context.videoComparePresentationTime(),2);
  output.paused=false;output.currentTime=.05;assert.equal(context.videoComparePresentationTime(),0);
  run('videoCompareAudio={context:{state:"running"}}');assert.equal(context.videoComparePresentationTime(),.05);
});

test('leaving Web Audio creates native players, restores volume/time and releases the context once',async()=>{
  const {context,run,players}=playbackApp();let closed=0,disconnected=0;
  const old=players.get('pixelVideoResult');old.currentTime=2.5;old.volume=.35;old.muted=true;
  for(const player of players.values()) player.replaceWith=fresh=>{players.set(player.id,fresh);};
  context.graph={context:{currentTime:0,close:async()=>{closed++;}},original:{disconnect(){disconnected++;}},processed:{disconnect(){disconnected++;}},master:{gain:{cancelScheduledValues(){},setValueAtTime(){}},disconnect(){disconnected++;}}};
  run('videoCompareAudio=graph;releaseVideoCompareAudio()');
  const fresh=players.get('pixelVideoResult');
  assert.notEqual(fresh,old);assert.equal(fresh.volume,.35);assert.equal(fresh.muted,true);assert.equal(fresh.playbackRate,1);
  fresh.dispatch('loadedmetadata');assert.equal(fresh.currentTime,2.5);
  assert.equal(run('videoCompareAudio'),null);assert.equal(closed,1);assert.equal(disconnected,3);
  context.releaseVideoCompareAudio();assert.equal(closed,1);
});

test('a decoder frame completing after a rewind cannot overwrite the new comparison',async()=>{
  const {context,run,get}=app();let finishSeek,commits=0;
  get('pixelVideoResult').readyState=3;
  Object.assign(get('pixelVideoSource'),{videoWidth:100,videoHeight:100});
  get('videoCompareOriginal').getContext=get('videoCompareProcessed').getContext=()=>({drawImage(){commits++;}});
  context.seekPixelVideo=()=>new Promise(resolve=>{finishSeek=resolve;});
  context.state={controller:new AbortController(),revision:0,frameIndex:-1,busy:false,ready:Promise.resolve(),buffer:{getContext:()=>({drawImage(){}})}};
  run("pixelVideoView='compare';pixelVideoResultRange={start:0,duration:5,fps:12};pixelVideoCompareFrames=Array(60).fill({});videoCompareVisual=state");
  const pending=context.renderVideoComparePair(3,context.state);
  await new Promise(setImmediate);run('invalidateVideoCompareFrame()');finishSeek();await pending;
  assert.equal(commits,0);assert.equal(context.state.busy,false);
  context.seekPixelVideo=async()=>{};
  await context.renderVideoComparePair(0,context.state);assert.equal(commits,2);assert.equal(context.state.frameIndex,0);
});

function visibilityApp(){
  const fixture=app(),events=new Player('document');
  fixture.context.document.hidden=false;
  fixture.context.document.addEventListener=events.addEventListener.bind(events);
  fixture.context.document.removeEventListener=events.removeEventListener.bind(events);
  return {...fixture,events,hide(hidden){fixture.context.document.hidden=hidden;events.dispatch('visibilitychange');}};
}

test('a hidden job waits, resumes on visibility and removes its listeners',async()=>{
  const {context,hide,events}=visibilityApp(),controller=new AbortController();
  hide(true);let done=false;
  const task=context.waitForVideoVisibility(controller.signal).then(()=>{done=true;});
  await Promise.resolve();assert.equal(done,false);
  hide(false);await task;assert.equal(done,true);
  assert.equal(events.handlers.get('visibilitychange').size,0);
});

test('hidden recording attempt is discarded, then retried without cancelling the full job',async()=>{
  const {context,hide}=visibilityApp(),controller=new AbortController();let attempts=0;
  const task=context.runVisibleVideoTask(signal=>{
    attempts++;
    if(attempts===2)return Promise.resolve('complete recording');
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('hidden','AbortError')),{once:true}));
  },controller.signal);
  await new Promise(setImmediate);hide(true);await new Promise(setImmediate);
  assert.equal(attempts,1);assert.equal(controller.signal.aborted,false);
  hide(false);assert.equal(await task,'complete recording');assert.equal(attempts,2);
});

test('rapid hide/show retries the step even when already visible when its rejection arrives',async()=>{
  const {context,hide}=visibilityApp();let attempts=0;
  const task=context.runVisibleVideoTask(signal=>{
    attempts++;
    if(attempts>1)return Promise.resolve('ok');
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('hidden','AbortError'))));
  },new AbortController().signal);
  await new Promise(setImmediate);hide(true);hide(false);
  assert.equal(await task,'ok');assert.equal(attempts,2);
});

test('manual cancel during hidden waiting rejects and releases event listeners',async()=>{
  const {context,hide,events}=visibilityApp(),controller=new AbortController();hide(true);
  let attempts=0;
  const task=context.runVisibleVideoTask(()=>{attempts++;},controller.signal);
  controller.abort();await assert.rejects(task,{name:'AbortError'});
  assert.equal(attempts,0);assert.equal(events.handlers.get('visibilitychange').size,0);
});

test('real export errors are not retried as background interruptions',async()=>{
  const {context}=visibilityApp();let attempts=0;
  await assert.rejects(context.runVisibleVideoTask(async()=>{attempts++;throw new Error('encoder failed');},new AbortController().signal),/encoder failed/);
  assert.equal(attempts,1);
});

test('job progress and cancellation stay outside the collapsed video settings and remain interactive',()=>{
  const {context,get}=app(),quick={id:'quick'},settings={id:'secVideo'},panel={id:'videoJobPanel'};
  context.document.querySelectorAll=selector=>selector==='.sidebar > *'?[quick,settings,panel]:[];
  context.document.querySelector=()=>get('main');
  context.setVideoBusy(true);
  assert.equal(quick.inert,true);assert.notEqual(panel.inert,true);
  assert.equal(get('videoCancelBtn').hidden,false);assert.equal(get('videoProgress').hidden,false);
  context.setVideoBusy(false);assert.equal(quick.inert,false);assert.equal(get('videoResumeBtn').hidden,true);
  assert(html.indexOf('id="videoJobPanel"')<html.indexOf('id="secVideo"'));
  assert.equal((html.match(/id="videoStatus"/g)||[]).length,1);
});

test('an interrupted recorder rejects its partial output and stops all capture tracks',async()=>{
  const {context}=app(),controller=new AbortController();let stopped=0;
  context.performance={now:()=>0};
  context.MediaRecorder=class{
    constructor(){this.state='inactive';}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.onstop();}
  };
  const canvas={width:2,height:2,getContext:()=>({clearRect(){},drawImage(){}}),captureStream:()=>({getTracks:()=>[{stop(){stopped++;}}]})};
  const task=context.recordPixelFrames(canvas,[{}],12,1,'video/webm',controller.signal,()=>{});
  controller.abort();await assert.rejects(task,{name:'AbortError'});assert.equal(stopped,1);
});

test('the explicit audio resume button can unlock a suspended export context',async()=>{
  const {context,run,get}=app();let unlock,calls=0;
  context.audioContextMock={state:'suspended',resume(){
    if(++calls===1)return new Promise(resolve=>{unlock=resolve;});
    this.state='running';unlock();return Promise.resolve();
  }};
  run('pixelVideoAudioContext=audioContextMock');
  const task=context.resumeVideoExportAudio(context.audioContextMock,new AbortController().signal);
  assert.equal(get('videoResumeBtn').hidden,false);
  context.resumeVideoJobAudio();await task;
  assert.equal(get('videoResumeBtn').hidden,true);assert.equal(calls,2);
});
