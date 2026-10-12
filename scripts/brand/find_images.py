#!/usr/bin/env python3
"""Search open-licence image sources for one catalogue slot and build a numbered contact sheet.

Sources (docs/PRODUCT_IMAGES.md §2): the Openverse API (photographs only), restricted by default to its
curated providers with editorial-quality photography (WordPress Photo Directory, StockSnap, rawpixel;
Flickr as fallback), and optionally the Wikimedia Commons API (COMMONS=1).
Only CC0 and Public Domain images are kept: they need no attribution, so the storefront can use
them as product photos without a credits section (user decision 2026-10-12). Candidates are written as JSON next to the sheet so a pick can be downloaded later
with fetch_image.py. Nothing here is a licence decision on its own: the per-file licence recorded in
the manifest is the source of truth.

Usage: find_images.py <slot-key> <query> [<query> ...]   (env WORKDIR = scratch directory)
"""
import io, json, os, re, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor
import requests
from PIL import Image, ImageDraw, ImageFont

UA = {'User-Agent': 'tatva-demo-image-sourcing/0.1 (https://github.com/Ragx09/woocommerce-mcp)'}
WORK = os.environ.get('WORKDIR', '.')
MIN_SIDE = 700
OK_LICENCE = re.compile(r'^(cc0|pdm|public domain)', re.I)  # no-attribution licences only: the store shows no credits


def openverse(q):
    r = requests.get('https://api.openverse.org/v1/images/', headers=UA, timeout=30, params={
        'q': q, 'license': 'cc0,pdm', 'category': 'photograph',
        'page_size': 20, 'mature': 'false',
        **({} if os.environ.get('SOURCES') == 'all' else {'source': os.environ.get('SOURCES', 'wordpress,stocksnap,rawpixel,flickr')})})
    if r.status_code == 429:
        print('openverse: rate limited', file=sys.stderr); return []
    r.raise_for_status()
    out = []
    for it in r.json().get('results', []):
        w, h = it.get('width') or 0, it.get('height') or 0
        if min(w, h) < MIN_SIDE:
            continue
        out.append({
            'source': f"openverse/{it.get('provider')}", 'title': re.sub('<[^>]+>', '', it.get('title') or '').strip(),
            'creator': it.get('creator'), 'license': f"CC {it['license'].upper()} {it.get('license_version') or ''}".strip()
            if it['license'] not in ('cc0', 'pdm') else ('CC0 1.0' if it['license'] == 'cc0' else 'Public Domain Mark 1.0'),
            'license_url': it.get('license_url'), 'page_url': it.get('foreign_landing_url'), 'asset_url': it.get('url'),
            'thumb_url': it.get('thumbnail'), 'width': w, 'height': h, 'attribution': it.get('attribution')})
    return out


def commons(q):
    r = requests.get('https://commons.wikimedia.org/w/api.php', headers=UA, timeout=30, params={
        'action': 'query', 'format': 'json', 'generator': 'search', 'gsrsearch': f'{q} filetype:bitmap',
        'gsrnamespace': 6, 'gsrlimit': 20, 'prop': 'imageinfo', 'iiprop': 'url|size|extmetadata|mime',
        'iiurlwidth': 320})
    r.raise_for_status()
    out = []
    for p in (r.json().get('query', {}).get('pages', {}) or {}).values():
        ii = (p.get('imageinfo') or [{}])[0]
        md = ii.get('extmetadata', {})
        lic = md.get('LicenseShortName', {}).get('value', '')
        if not OK_LICENCE.match(lic.replace('Public domain', 'public domain')) or ii.get('mime') not in ('image/jpeg', 'image/png', 'image/webp'):
            continue
        if min(ii.get('width', 0), ii.get('height', 0)) < MIN_SIDE:
            continue
        artist = re.sub('<[^>]+>', '', md.get('Artist', {}).get('value', '')).strip()
        out.append({
            'source': 'wikimedia-commons', 'title': p['title'].removeprefix('File:'), 'creator': artist or None,
            'license': lic, 'license_url': md.get('LicenseUrl', {}).get('value'),
            'page_url': ii.get('descriptionurl'), 'asset_url': ii.get('url'), 'thumb_url': ii.get('thumburl'),
            'width': ii.get('width'), 'height': ii.get('height'),
            'attribution': None if md.get('AttributionRequired', {}).get('value') == 'false'
            else f"{p['title'].removeprefix('File:')} by {artist or 'unknown'}, {lic}"})
    return out


def sheet(key, cands):
    cell, cols = 260, 5
    rows = (len(cands) + cols - 1) // cols
    img = Image.new('RGB', (cols * cell, rows * (cell + 34)), 'white')
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 14)
    except OSError:
        font = ImageFont.load_default()
    def get(c):
        try:
            return requests.get(c['thumb_url'], headers=UA, timeout=30).content
        except requests.RequestException:
            return b''
    with ThreadPoolExecutor(8) as pool:
        thumbs = list(pool.map(get, cands))
    for i, c in enumerate(cands):
        x, y = (i % cols) * cell, (i // cols) * (cell + 34)
        try:
            t = Image.open(io.BytesIO(thumbs[i])).convert('RGB')
            t.thumbnail((cell - 8, cell - 8))
            img.paste(t, (x + 4, y + 4))
        except Exception as e:  # noqa: BLE001 — a broken thumbnail just leaves a blank cell
            d.text((x + 8, y + 8), f'thumb failed: {type(e).__name__}', fill='red', font=font)
        lic = c['license'].replace('Public Domain Mark', 'PDM')
        d.text((x + 4, y + cell), f"#{i} {lic[:14]} {c['width']}x{c['height']}", fill='black', font=font)
        d.text((x + 4, y + cell + 16), (c['title'] or '')[:30], fill='#555', font=font)
    path = os.path.join(WORK, 'sheets', f'{key}.jpg')
    img.save(path, quality=80)
    return path


def main():
    key, queries = sys.argv[1], sys.argv[2:]
    seen, cands = set(), []
    for q in queries:
        for fn in ((openverse, commons) if os.environ.get('COMMONS') == '1' else (openverse,)):
            try:
                for c in fn(q):
                    if c['asset_url'] not in seen:
                        seen.add(c['asset_url']); cands.append(c)
            except requests.RequestException as e:
                print(f'{fn.__name__}: {e}', file=sys.stderr)
            time.sleep(3.2)
    cands = cands[:15]
    with open(os.path.join(WORK, 'cand', f'{key}.json'), 'w') as f:
        json.dump(cands, f, indent=1)
    print(f'{key}: {len(cands)} candidates → {sheet(key, cands) if cands else "no sheet"}')


if __name__ == '__main__':
    main()
