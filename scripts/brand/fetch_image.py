#!/usr/bin/env python3
"""Download one chosen candidate, validate it, crop/resize it and record it in the image manifest.

Usage: fetch_image.py <slot-key> <candidate-index> <role> [focus_x focus_y] [--alt "text"]
  role: product (4:5, 1000x1250) | editorial (3:2, 1800x1200) | tile (4:5 category tile, 900x1125)
  focus: 0..1 position of the crop centre (default 0.5 0.5)
Reads $WORKDIR/cand/<slot>.json (from find_images.py). Writes services/store-assets/images/<dir>/<file>.webp
and updates services/store-assets/images/manifest.json. The original download stays in $WORKDIR/dl.
Only cropping and resizing are applied (no filters), so the image is not misrepresented (PRODUCT_IMAGES.md §5).
"""
import argparse, datetime, hashlib, io, json, os, sys
import requests
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', '..', 'services', 'store-assets', 'images')
UA = {'User-Agent': 'tatva-demo-image-sourcing/0.1 (https://github.com/Ragx09/woocommerce-mcp)'}
SIZES = {'product': (1000, 1250), 'editorial': (1800, 1200), 'tile': (900, 1125)}  # tile: 4:5 category tiles


def crop(img, size, fx, fy, zoom=1.0):
    tw, th = size
    if zoom > 1:  # tighten around the focus point before the aspect crop
        w, h = img.size; zw, zh = round(w / zoom), round(h / zoom)
        x = min(max(round(fx * w - zw / 2), 0), w - zw); y = min(max(round(fy * h - zh / 2), 0), h - zh)
        img = img.crop((x, y, x + zw, y + zh)); fx = fy = 0.5
    w, h = img.size
    target = tw / th
    if w / h > target:  # too wide → cut the sides
        nw = round(h * target); x = min(max(round(fx * w - nw / 2), 0), w - nw)
        img = img.crop((x, 0, x + nw, h))
    else:               # too tall → cut top/bottom
        nh = round(w / target); y = min(max(round(fy * h - nh / 2), 0), h - nh)
        img = img.crop((0, y, w, y + nh))
    return img.resize(size, Image.LANCZOS) if img.size[0] > tw else img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('slot'); ap.add_argument('index', type=int); ap.add_argument('role', choices=SIZES)
    ap.add_argument('focus', nargs='*', type=float); ap.add_argument('--alt', required=True); ap.add_argument('--zoom', type=float, default=1.0)
    a = ap.parse_args()
    work = os.environ['WORKDIR']
    cand = json.load(open(os.path.join(work, 'cand', f'{a.slot}.json')))[a.index]
    r = requests.get(cand['asset_url'], headers=UA, timeout=120)
    r.raise_for_status()
    raw = r.content
    try:
        img = Image.open(io.BytesIO(raw)); img.verify(); img = Image.open(io.BytesIO(raw))
    except Exception as e:  # an HTML error page or a truncated file
        sys.exit(f'{a.slot}: not a valid image ({type(e).__name__}, {r.headers.get("content-type")})')
    os.makedirs(os.path.join(work, 'dl'), exist_ok=True)
    open(os.path.join(work, 'dl', f'{a.slot}{os.path.splitext(cand["asset_url"].split("?")[0])[1] or ".img"}'), 'wb').write(raw)
    fx, fy = (a.focus + [0.5, 0.5])[:2]
    out = crop(img.convert('RGB'), SIZES[a.role], fx, fy, a.zoom)
    sub = 'products' if a.role == 'product' else 'editorial'
    name = a.slot.removeprefix('ed-') + '.webp'
    path = os.path.join(ROOT, sub, name)
    out.save(path, 'WEBP', quality=80, method=6)
    check = Image.open(path); check.verify()
    mpath = os.path.join(ROOT, 'manifest.json')
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {}
    manifest[a.slot] = {
        'file': f'{sub}/{name}', 'role': a.role, 'alt': a.alt,
        'width': out.size[0], 'height': out.size[1], 'bytes': os.path.getsize(path),
        'source_repository': cand['source'], 'source_title': cand['title'], 'creator': cand['creator'],
        'license': cand['license'], 'license_url': cand['license_url'], 'source_page_url': cand['page_url'],
        'asset_url': cand['asset_url'], 'attribution': cand['attribution'],
        'original_size': [img.size[0], img.size[1]], 'original_sha256': hashlib.sha256(raw).hexdigest(),
        'modifications': (f'zoomed x{a.zoom}, ' if a.zoom > 1 else '') + f'cropped to {SIZES[a.role][0]}:{SIZES[a.role][1]} ratio, resized, converted to WebP',
        'representative_demo_image': True, 'status': 'downloaded+validated',
        'retrieved': datetime.date.today().isoformat()}
    json.dump(dict(sorted(manifest.items())), open(mpath, 'w'), indent=1, ensure_ascii=False)
    print(f"{a.slot}: {cand['license']} {img.size[0]}x{img.size[1]} → {sub}/{name} {out.size[0]}x{out.size[1]} {os.path.getsize(path)//1024} KB")


if __name__ == '__main__':
    main()
