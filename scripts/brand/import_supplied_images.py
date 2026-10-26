#!/usr/bin/env python3
"""Turn the user-supplied product images into final storefront WebP files and manifest entries.

Inputs (all under $WORK, nothing is downloaded):
  $WORK/z/*.jpg   12 images named <sku>-<slug>.jpg (AI-generated, supplied by the project owner); only used for the file name
  $WORK/zup/*.png the same 12, trimmed of their white canvas, downscaled 3x and upscaled 4x with Real-ESRGAN
  $WORK/up/*.png  35 catalogue-grid cells already upscaled 4x with Real-ESRGAN (scripts/brand/esrgan_upscale.py)
Output: services/store-assets/stores/<store>/images/products/<sku>.webp (1000x1250, overwritten in place, no backups)
and the matching manifest.json entries. Each SKU has a layout: 'crop' (4:5 crop around a focus point) or
'extend' (the whole picture kept, the studio background continued above and below), chosen by looking at it.
Usage: import_supplied_images.py   (env WORK = scratch directory)
"""
import datetime, hashlib, json, os, sys
from PIL import Image, ImageFilter

WORK = os.environ['WORK']
STORES = os.path.join(os.path.dirname(__file__), '..', '..', 'services', 'store-assets', 'stores')
SIZE = (1000, 1250)
LICENCE = 'AI-generated illustration, supplied by the project owner'

# sku: (layout, focus x, focus y, alt text)
ITEMS = json.load(open(os.path.join(os.path.dirname(__file__), 'supplied_images.json')))


def crop45(img, fx, fy):
    w, h = img.size
    if w / h > 0.8:  # too wide: cut the sides
        nw = round(h * 0.8); x = min(max(round(fx * w - nw / 2), 0), w - nw); img = img.crop((x, 0, x + nw, h))
    else:            # too tall: cut top and bottom
        nh = round(w / 0.8); y = min(max(round(fy * h - nh / 2), 0), h - nh); img = img.crop((0, y, w, y + nh))
    return img.resize(SIZE, Image.LANCZOS)


def extend45(img, fy):
    """Keep the whole picture at full width and continue its background above and below: the average colour of the
    outer rows, blurred sideways, faded into the picture over 36 px (no mirrored copies of the subject)."""
    w, h = img.size
    nh = round(SIZE[0] * h / w)
    body = img.resize((SIZE[0], nh), Image.LANCZOS)
    top = round((SIZE[1] - nh) * fy); bottom = SIZE[1] - nh - top
    canvas = Image.new('RGB', SIZE)

    def edge(y0):  # one blurred row of colour from 4 outer rows
        row = body.crop((0, y0, SIZE[0], y0 + 4)).resize((SIZE[0], 1), Image.BOX)
        return row.resize((6, 1), Image.BOX).resize((SIZE[0], 1), Image.BICUBIC)
    fade = 36  # the strips run under the fade zone, so the picture blends into the colour, not into black
    if top > 0: canvas.paste(edge(0).resize((SIZE[0], top + fade)), (0, 0))
    if bottom > 0: canvas.paste(edge(nh - 4).resize((SIZE[0], bottom + fade)), (0, SIZE[1] - bottom - fade))
    mask = Image.new('L', (SIZE[0], nh), 255)
    ramp = Image.linear_gradient('L').resize((SIZE[0], fade))
    if top > 0: mask.paste(ramp, (0, 0))
    if bottom > 0: mask.paste(ramp.transpose(Image.FLIP_TOP_BOTTOM), (0, nh - fade))
    canvas.paste(body, (0, top), mask)
    return canvas


def source_file(sku):
    z = [f for f in os.listdir(os.path.join(WORK, 'z')) if f.startswith(sku + '-')]
    if z: return os.path.join(WORK, 'zup', sku + '.png'), 'supplied pack (tatva_ridgeline_product_images.zip)', z[0]
    return os.path.join(WORK, 'up', sku + '.png'), 'supplied catalogue grid (Retail Product Catalog Grid.png)', None


def main():
    manifests = {}
    for sku, (layout, fx, fy, alt) in ITEMS.items():
        store = 'tatva' if sku.startswith('tat-') else 'ridgeline'
        src, origin, packfile = source_file(sku)
        raw = open(src, 'rb').read()
        img = Image.open(src).convert('RGB')
        if packfile is None: img = img.crop((8, 8, img.width - 8, img.height - 8))  # grid cells carry a 1-2 px grey border (x4 after upscaling)
        out = crop45(img, fx, fy) if layout == 'crop' else extend45(img, fy)
        path = os.path.join(STORES, store, 'images', 'products', sku + '.webp')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        out.save(path, 'WEBP', quality=92, method=6)
        Image.open(path).verify()
        mp = os.path.join(STORES, store, 'images', 'manifest.json')
        m = manifests.setdefault(store, (mp, json.load(open(mp))))[1]
        m[sku] = {
            'file': f'products/{sku}.webp', 'role': 'product', 'alt': alt, 'width': SIZE[0], 'height': SIZE[1], 'bytes': os.path.getsize(path),
            'source_repository': 'user-supplied (AI-generated)', 'source_title': packfile or 'Retail Product Catalog Grid.png (cell ' + sku.upper() + ')', 'creator': 'project owner (AI image generation)',
            'license': LICENCE, 'license_url': 'n/a (supplied by the project owner, see README-LICENSE.txt of the pack)',
            'source_page_url': origin, 'asset_url': 'local file supplied by the project owner', 'attribution': 'none required',
            'original_size': list(Image.open(src).size), 'original_sha256': hashlib.sha256(raw).hexdigest(),
            'modifications': ('white canvas and caption fragments trimmed, ' if packfile else 'cell cut from the grid, ') + ('downscaled 3x then ' if packfile else '') + '4x Real-ESRGAN upscale, ' + ('cropped to 4:5' if layout == 'crop' else 'background continued to 4:5') + ', resized to 1000x1250, converted to WebP',
            'representative_demo_image': True, 'status': 'supplied+validated', 'retrieved': datetime.date.today().isoformat()}
        print(f'{sku}: {layout} {Image.open(src).size} -> {store}/products/{sku}.webp {os.path.getsize(path) // 1024} KB')
    for mp, m in manifests.values():
        json.dump(dict(sorted(m.items())), open(mp, 'w'), indent=1, ensure_ascii=False)


if __name__ == '__main__':
    sys.exit(main())
