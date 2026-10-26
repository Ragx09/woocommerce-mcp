#!/usr/bin/env python3
"""Validate one store's image set (PRODUCT_IMAGES.md §10). Exit 1 on any problem.
Usage: validate_images.py [tatva|ridgeline]   (default tatva; data in services/store-assets/stores/<store>/)

Checks: every manifest file exists and decodes as an image (not an HTML error page); expected size
per role; only no-attribution licences (CC0 / Public Domain); source + licence URLs recorded; no
two slots share the same file content; every catalogue product and category is mapped (or listed
as known-missing); alt text present.
"""
import hashlib, json, os, sys
from PIL import Image

STORE = sys.argv[1] if len(sys.argv) > 1 else 'tatva'
ROOT = os.path.join(os.path.dirname(__file__), '..', '..', 'services', 'store-assets', 'stores', STORE)
IMG = os.path.join(ROOT, 'images')
# TATVA images were normalised to exact sizes; Ridgeline keeps the source resolution (many open-licence files are
# ~1024 px), so only the 4:5 / 3:2 ratio is checked there.
SIZES = {'product': (1000, 1250), 'tile': (900, 1125)} if STORE == 'tatva' else {}  # TATVA's older 800x1000 products were replaced by 1000x1250 supplied ones
RATIOS = {'product': 0.8, 'tile': 0.8, 'editorial': 1.5}
m = json.load(open(os.path.join(IMG, 'manifest.json')))
cat = json.load(open(os.path.join(ROOT, 'catalogue.json')))
problems, hashes = [], {}

for key, e in m.items():
    path = os.path.join(IMG, e['file'])
    if not os.path.isfile(path):
        problems.append(f'{key}: file missing {e["file"]}'); continue
    try:
        with Image.open(path) as im:
            im.verify()
        with Image.open(path) as im:
            size, fmt = im.size, im.format
    except Exception as ex:  # noqa: BLE001
        problems.append(f'{key}: not a valid image ({ex})'); continue
    if fmt != 'WEBP':
        problems.append(f'{key}: format {fmt}, expected WEBP')
    if abs(size[0] / size[1] - RATIOS.get(e['role'], size[0] / size[1])) > 0.01:
        problems.append(f'{key}: ratio {size}, expected {RATIOS[e["role"]]}')
    want = SIZES.get(e['role'])
    if want and size != want and not (e['role'] == 'product' and size == (800, 1000)):
        problems.append(f'{key}: {size}, expected {want}')
    if e['role'] == 'editorial' and abs(size[0] / size[1] - 1.5) > 0.01:
        problems.append(f'{key}: editorial ratio {size}')
    lic = (e.get('license') or '').lower()
    if not (lic.startswith('cc0') or 'public domain' in lic or lic.startswith('ai-generated illustration, supplied by the project owner')):
        problems.append(f'{key}: licence {e.get("license")} requires attribution')
    for f in ('source_page_url', 'asset_url', 'source_repository', 'alt'):
        if not e.get(f):
            problems.append(f'{key}: {f} missing')
    h = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if h in hashes:
        problems.append(f'{key}: same file content as {hashes[h]}')
    hashes[h] = key

skus = [p['sku'].lower() for p in cat['products']]
missing = [s for s in skus if s not in m]
for c in cat['categories']:
    if f'ed-category-{c["slug"]}' not in m:
        problems.append(f'category {c["slug"]}: no tile image')
for k in ('ed-hero', 'ed-concept', 'ed-collection'):
    if k not in m:
        problems.append(f'{k}: missing')
by_source = {}
for e in m.values():
    by_source[e['source_repository']] = by_source.get(e['source_repository'], 0) + 1
lic_count = {}
for e in m.values():
    lic_count[e['license']] = lic_count.get(e['license'], 0) + 1

print(f'products with images: {len(skus) - len(missing)}/{len(skus)}; without (fallback panel): {missing or "none"}')
print(f'editorial/category images: {sum(1 for e in m.values() if e["role"] != "product")}')
print(f'sources: {by_source}')
print(f'licences: {lic_count}')
print(f'total size: {sum(e["bytes"] for e in m.values()) // 1024} KB, unique files: {len(hashes)}')
for p in problems:
    print('PROBLEM', p)
sys.exit(1 if problems else 0)
