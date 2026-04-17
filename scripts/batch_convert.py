#!/usr/bin/env python3
"""
DotPix+ Batch Converter
=======================
index.html の変換ロジック（CRTなし）を Python に移植したバッチ変換スクリプト。
依存: Pillow のみ  (pip install Pillow)

使用例:
  python batch_convert.py ./input ./output
  python batch_convert.py ./input ./output --dot-size 8 --colors 16
  python batch_convert.py ./input ./output --dot-count 48 --retro fc --retro-count 12
  python batch_convert.py face.png face_dot.png --mode B --edge-strength 60 --dither fs
  python batch_convert.py ./input ./output --scale 3
"""

import argparse
import math
import os
import random
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Error: Pillow が必要です。  pip install Pillow")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Retro palettes
# ---------------------------------------------------------------------------

FC_PALETTE = [
    (84,84,84),(0,30,116),(8,16,144),(48,0,136),(68,0,100),(92,0,48),(84,4,0),(60,24,0),
    (32,42,0),(8,58,0),(0,64,0),(0,60,0),(0,50,60),(0,0,0),
    (152,150,152),(8,76,196),(48,50,236),(92,30,228),(136,20,176),(160,20,100),(152,34,32),(120,60,0),
    (84,90,0),(40,114,0),(8,124,0),(0,118,40),(0,102,120),(44,44,44),
    (236,238,236),(76,154,236),(120,124,236),(176,98,236),(228,84,236),(236,88,180),(236,106,100),(212,136,32),
    (160,170,0),(116,196,0),(76,208,32),(56,204,108),(56,180,204),(60,60,60),
    (236,238,236),(168,204,236),(188,188,236),(212,178,236),(236,174,236),(236,174,212),(236,180,176),(228,196,144),
    (204,210,120),(180,222,120),(168,226,144),(152,226,180),(160,214,228),(160,162,160),
]

PCE_PALETTE = [
    (round(r/7*255), round(g/7*255), round(b/7*255))
    for r in range(8) for g in range(8) for b in range(8)
]

PC98_PALETTE = [
    (round(r/15*255), round(g/15*255), round(b/15*255))
    for r in range(16) for g in range(16) for b in range(16)
]

RETRO_PALETTES = {'fc': FC_PALETTE, 'pce': PCE_PALETTE, 'pc98': PC98_PALETTE}

# Bayer 4x4 matrix (ordered dithering)
BAYER4 = [
    [ 0, 8, 2,10],
    [12, 4,14, 6],
    [ 3,11, 1, 9],
    [15, 7,13, 5],
]


# ---------------------------------------------------------------------------
# Color quantization
# ---------------------------------------------------------------------------

def _dist_sq(a, b):
    return (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2


def quantize_kmeans(pixels, n, iters=12, max_sample=4096):
    """k-means 色量子化 (index.html の quantizeWithPriority に相当)"""
    total = len(pixels)
    if total == 0:
        return [(0, 0, 0)]
    n = max(2, n)

    step = max(1, math.ceil(total / max_sample))
    sample = [(pixels[i][0] << 16) | (pixels[i][1] << 8) | pixels[i][2]
              for i in range(0, total, step)]

    seen = set()
    clusters = []
    pool = list(set(sample))
    random.shuffle(pool)
    for k in pool:
        if len(clusters) >= n:
            break
        if k not in seen:
            seen.add(k)
            clusters.append([(k >> 16) & 255, (k >> 8) & 255, k & 255])

    for _ in range(iters):
        sums = [[0, 0, 0, 0] for _ in clusters]
        for k in sample:
            r, g, b = (k >> 16) & 255, (k >> 8) & 255, k & 255
            bi, bd = 0, float('inf')
            for j, c in enumerate(clusters):
                d = (r-c[0])**2 + (g-c[1])**2 + (b-c[2])**2
                if d < bd:
                    bd, bi = d, j
            s = sums[bi]
            s[0] += r; s[1] += g; s[2] += b; s[3] += 1
        for j, s in enumerate(sums):
            if s[3] > 0:
                clusters[j] = [round(s[0]/s[3]), round(s[1]/s[3]), round(s[2]/s[3])]

    return [tuple(c) for c in clusters]


def reduce_retro_kmeans(pixels, full_pal, n, bright_bias=0.0, iters=10, max_sample=4096):
    """レトロパレットから n 色を k-means で選択 (index.html の reduceRetroKMeans に相当)"""
    if n >= len(full_pal):
        return list(full_pal)

    step = max(1, math.ceil(len(pixels) / max_sample))
    sample = [pixels[i] for i in range(0, len(pixels), step)]

    scale = bright_bias * 3
    scores = [random.random() * math.exp(scale * (0.299*c[0] + 0.587*c[1] + 0.114*c[2]) / 255)
              for c in full_pal]
    sorted_idx = sorted(range(len(full_pal)), key=lambda i: scores[i], reverse=True)
    centers = [list(full_pal[i]) for i in sorted_idx[:n]]

    for _ in range(iters):
        sums = [[0, 0, 0, 0] for _ in centers]
        for px in sample:
            r, g, b = px[0], px[1], px[2]
            bi, bd = 0, float('inf')
            for j, c in enumerate(centers):
                d = (r-c[0])**2 + (g-c[1])**2 + (b-c[2])**2
                if d < bd:
                    bd, bi = d, j
            s = sums[bi]
            s[0] += r; s[1] += g; s[2] += b; s[3] += 1
        for j, s in enumerate(sums):
            if s[3] == 0:
                continue
            mr, mg, mb = s[0]/s[3], s[1]/s[3], s[2]/s[3]
            bi, bd = 0, float('inf')
            for k, c in enumerate(full_pal):
                d = (mr-c[0])**2 + (mg-c[1])**2 + (mb-c[2])**2
                if d < bd:
                    bd, bi = d, k
            centers[j] = list(full_pal[bi])

    seen = set(); result = []
    for c in centers:
        k = (c[0] << 16) | (c[1] << 8) | c[2]
        if k not in seen:
            seen.add(k)
            result.append(tuple(c))
    return result


def map_to_palette(pixels, palette):
    """各ピクセルを最近傍パレット色にスナップ (キャッシュ付き)"""
    cache = {}
    result = []
    for px in pixels:
        r, g, b = px[0], px[1], px[2]
        key = (r << 16) | (g << 8) | b
        if key not in cache:
            bi, bd = 0, float('inf')
            for j, c in enumerate(palette):
                d = (r-c[0])**2 + (g-c[1])**2 + (b-c[2])**2
                if d < bd:
                    bd, bi = d, j
            cache[key] = bi
        c = palette[cache[key]]
        result.append((c[0], c[1], c[2]))
    return result


# ---------------------------------------------------------------------------
# Dithering
# ---------------------------------------------------------------------------

def apply_ordered_dither(pixels, w, h, palette):
    """Bayer 4x4 ordered dithering"""
    spread = 24
    result = []
    for y in range(h):
        for x in range(w):
            t = (BAYER4[y % 4][x % 4] / 16 - 0.5) * spread
            px = pixels[y * w + x]
            r = max(0, min(255, px[0] + t))
            g = max(0, min(255, px[1] + t))
            b = max(0, min(255, px[2] + t))
            bi, bd = 0, float('inf')
            for j, c in enumerate(palette):
                d = (r-c[0])**2 + (g-c[1])**2 + (b-c[2])**2
                if d < bd:
                    bd, bi = d, j
            result.append(palette[bi])
    return result


def apply_floyd_steinberg(pixels, w, h, palette):
    """Floyd-Steinberg 誤差拡散ディザリング"""
    buf = [[float(px[0]), float(px[1]), float(px[2])] for px in pixels]
    result = list(pixels)
    for y in range(h):
        for x in range(w):
            i = y * w + x
            or_, og, ob = (max(0, min(255, buf[i][ch])) for ch in range(3))
            bi, bd = 0, float('inf')
            for j, c in enumerate(palette):
                d = (or_-c[0])**2 + (og-c[1])**2 + (ob-c[2])**2
                if d < bd:
                    bd, bi = d, j
            nr, ng, nb = palette[bi]
            result[i] = (nr, ng, nb)
            er, eg, eb = or_ - nr, og - ng, ob - nb
            for dx, dy, f in ((1,0,7/16), (-1,1,3/16), (0,1,5/16), (1,1,1/16)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    buf[j][0] += er * f
                    buf[j][1] += eg * f
                    buf[j][2] += eb * f
    return result


# ---------------------------------------------------------------------------
# Sobel edge detection + smart mode (Mode B)
# ---------------------------------------------------------------------------

def sobel_magnitude(pixels, w, h):
    """正規化済み Sobel エッジ強度マップを返す (index.html の sobelMagnitude に相当)"""
    gray = [0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2] for px in pixels]
    mag = [0.0] * (w * h)
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            gx = (
                -gray[(y-1)*w+(x-1)] + gray[(y-1)*w+(x+1)]
                - 2*gray[y*w+(x-1)] + 2*gray[y*w+(x+1)]
                - gray[(y+1)*w+(x-1)] + gray[(y+1)*w+(x+1)]
            )
            gy = (
                -gray[(y-1)*w+(x-1)] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+(x+1)]
                + gray[(y+1)*w+(x-1)] + 2*gray[(y+1)*w+x] + gray[(y+1)*w+(x+1)]
            )
            mag[y*w+x] = math.sqrt(gx*gx + gy*gy)
    max_m = max(mag) if mag else 0
    if max_m > 0:
        mag = [v / max_m for v in mag]
    return mag


def process_smart_mode(pixels_bi, pixels_nn, w, h, palette, edge_str, dither):
    """Mode B: エッジ強度でバイリニアとNNをブレンドしてからパレットにスナップ"""
    mag = sobel_magnitude(pixels_bi, w, h)
    blended = []
    for i in range(w * h):
        e = min(1.0, mag[i] * edge_str * 2.5)
        r = round(pixels_bi[i][0] * (1-e) + pixels_nn[i][0] * e)
        g = round(pixels_bi[i][1] * (1-e) + pixels_nn[i][1] * e)
        b = round(pixels_bi[i][2] * (1-e) + pixels_nn[i][2] * e)
        blended.append((r, g, b))

    if dither == 'none':
        return map_to_palette(blended, palette)
    elif dither == 'ordered':
        return apply_ordered_dither(blended, w, h, palette)
    else:  # fs
        return apply_floyd_steinberg(blended, w, h, palette)


# ---------------------------------------------------------------------------
# Size calculation
# ---------------------------------------------------------------------------

def get_small_size(img_w, img_h, dot_size, dot_count):
    if dot_count is not None:
        sw = max(4, dot_count)
        sh = max(1, round(sw * img_h / img_w))
    else:
        dot = max(2, dot_size)
        sw = max(1, math.ceil(img_w / dot))
        sh = max(1, math.ceil(img_h / dot))
    return sw, sh


# ---------------------------------------------------------------------------
# Main conversion
# ---------------------------------------------------------------------------

def convert_image(img, args):
    # RGBA → RGB (白背景合成)
    if img.mode == 'RGBA':
        bg = Image.new('RGB', img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        img = bg
    elif img.mode != 'RGB':
        img = img.convert('RGB')

    orig_w, orig_h = img.size
    sw, sh = get_small_size(orig_w, orig_h, args.dot_size, args.dot_count)

    # バイリニアでダウンサンプル
    small_bi = img.resize((sw, sh), Image.LANCZOS)
    pixels_bi = list(small_bi.getdata())

    # グレースケール変換
    if args.grayscale:
        pixels_bi = [
            (round(px[0]*0.299 + px[1]*0.587 + px[2]*0.114),) * 3
            for px in pixels_bi
        ]

    # パレット構築
    if args.retro != 'off':
        full_pal = RETRO_PALETTES[args.retro]
        n = max(2, args.retro_count if args.retro_count else 16)
        palette = reduce_retro_kmeans(pixels_bi, full_pal, n, args.retro_bright / 100)
    else:
        palette = quantize_kmeans(pixels_bi, args.colors)

    # ピクセル化
    if args.mode == 'A':
        out_pixels = map_to_palette(pixels_bi, palette)
    else:
        # Mode B: NN サンプルも用意してエッジブレンド
        small_nn = img.resize((sw, sh), Image.NEAREST)
        pixels_nn = list(small_nn.getdata())
        if args.grayscale:
            pixels_nn = [
                (round(px[0]*0.299 + px[1]*0.587 + px[2]*0.114),) * 3
                for px in pixels_nn
            ]
        out_pixels = process_smart_mode(
            pixels_bi, pixels_nn, sw, sh, palette,
            args.edge_strength / 100, args.dither,
        )

    small_out = Image.new('RGB', (sw, sh))
    small_out.putdata(out_pixels)

    # 倍率拡大（ニアレストネイバー）
    if args.scale > 1:
        result = small_out.resize((sw * args.scale, sh * args.scale), Image.NEAREST)
    else:
        result = small_out

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

SUPPORTED_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}


def build_parser():
    parser = argparse.ArgumentParser(
        description='DotPix+ バッチ変換 — ドット絵一括生成ツール',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument('input',  help='入力ファイルまたはディレクトリ')
    parser.add_argument('output', help='出力ファイルまたはディレクトリ')

    grp = parser.add_mutually_exclusive_group()
    grp.add_argument('--dot-size',  type=int, default=8,    metavar='N',
                     help='1ドットのpxサイズ (デフォルト: 8)')
    grp.add_argument('--dot-count', type=int, default=None, metavar='N',
                     help='横のドット数指定 (--dot-size より優先)')

    parser.add_argument('--colors',    type=int, default=16,  metavar='N',
                        help='カラー数 (デフォルト: 16)')
    parser.add_argument('--grayscale', action='store_true',
                        help='グレースケール変換')

    parser.add_argument('--mode', choices=['A', 'B'], default='A',
                        help='A=クラシック  B=スマート補完 (デフォルト: A)')
    parser.add_argument('--edge-strength', type=int, default=40, metavar='N',
                        help='エッジ強度 0-100 (Mode B のみ、デフォルト: 40)')
    parser.add_argument('--dither', choices=['none', 'ordered', 'fs'], default='none',
                        help='ディザリング none/ordered/fs (デフォルト: none)')

    parser.add_argument('--retro', choices=['off', 'fc', 'pce', 'pc98'], default='off',
                        help='レトロパレット (デフォルト: off)')
    parser.add_argument('--retro-count',  type=int, default=None, metavar='N',
                        help='レトロパレット使用色数')
    parser.add_argument('--retro-bright', type=int, default=0,    metavar='N',
                        help='明るさバイアス -100〜100 (デフォルト: 0)')

    parser.add_argument('--scale', type=int, default=1, metavar='N',
                        help='出力倍率・ニアレストネイバー拡大 (デフォルト: 1)')

    return parser


def main():
    args = build_parser().parse_args()

    input_path  = Path(args.input)
    output_path = Path(args.output)

    if input_path.is_file():
        files = [(input_path, output_path)]
    elif input_path.is_dir():
        output_path.mkdir(parents=True, exist_ok=True)
        files = [
            (f, output_path / (f.stem + '.png'))
            for f in sorted(input_path.iterdir())
            if f.suffix.lower() in SUPPORTED_EXTS
        ]
        if not files:
            print(f'対象ファイルなし: {input_path}')
            sys.exit(1)
    else:
        print(f'入力が見つかりません: {input_path}')
        sys.exit(1)

    total = len(files)
    for idx, (src, dst) in enumerate(files, 1):
        print(f'[{idx}/{total}] {src.name} ...', end=' ', flush=True)
        try:
            img    = Image.open(src)
            result = convert_image(img, args)
            dst.parent.mkdir(parents=True, exist_ok=True)
            result.save(dst, 'PNG')
            print(f'-> {dst.name}  ({result.size[0]}x{result.size[1]})')
        except Exception as exc:
            print(f'エラー: {exc}')

    print(f'\n完了: {total} ファイル処理しました')


if __name__ == '__main__':
    main()
