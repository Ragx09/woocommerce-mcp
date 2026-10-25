# store-assets — what a store is made of

Everything a storefront needs besides WordPress and WooCommerce themselves, shipped as the `store-assets` image
(D-016) and copied into each store by its wp-init Job. **Shared** parts are code; **store data** lives in one folder
per store, so adding or changing a store never touches another store's files.

| Path | Shared or per store | What |
|---|---|---|
| `theme/tatva/` | shared | The block theme every store uses (TATVA design system). No store's products, images or logos: it reads the store's name, tagline and niche from WordPress and its files from `assets/stores/<store>/` (copied in by the Dockerfile). |
| `import/import-catalogue.php` | shared | Idempotent importer: categories, brands, collections, products, images, pages, favicon. |
| `stores/tatva/` | **TATVA** (the default store, `store.<domain>`) | `catalogue.json` (50 products), `images/` (products, editorial, `manifest.json` with licence per file), `brand/` (wordmark, favicon), `niches/` (catalogues for created stores of the stationery, tea-coffee, home-ceramics and bags niches, generated from TATVA's catalogue by `scripts/brand/build_niche_catalogues.py`; they reuse TATVA's images). |
| `stores/ridgeline/` | **Ridgeline** (bike niche, `ridgeline.store.<domain>`) | `catalogue.json` (50 products from `brand/ridgeline/`), `images/` (products, editorial, `manifest.json`), `brand/` (logo, mark, favicon — original, BON-17), `theme/` (Ridgeline wp-admin colour scheme and login page CSS). |

Brand source material (briefs, logo sources) is in `brand/tatva/` and `brand/ridgeline/` at the repository root.
Which store folder a store uses: niche `""` and stationery/tea-coffee/home-ceramics/bags → `tatva`, `bike` → `ridgeline`,
`custom` → no catalogue (one category from the owner's text).

Checks: `python3 scripts/brand/validate_images.py tatva|ridgeline` (files decode, CC0/PD licence, source URLs, no
duplicates, every product mapped or listed as missing).
