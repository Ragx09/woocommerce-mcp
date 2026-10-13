# brand/

Source material for the storefront brand (Phase 9 in `TASKS.md`, BRD-01…07). The current working concept is **TATVA**. It may still change (D-015), so tasks link to the concept docs rather than repeating them.

| Material | Where | Used by |
|---|---|---|
| Brand, positioning, voice, categories, proposed catalogue | [`docs/tatva-brand-and-products.md`](../docs/tatva-brand-and-products.md) | BRD-01, BRD-05 |
| Visual identity, UI and theme spec | [`docs/v1-brand-ui-theme.md`](../docs/v1-brand-ui-theme.md) | BRD-02, BRD-03, BRD-04 |
| Product image sourcing (open licence) | [`docs/PRODUCT_IMAGES.md`](../docs/PRODUCT_IMAGES.md) | BRD-05 |
| Multi-store dashboard look (bonus, after E2E-14) | [`docs/v2-bonus-multi-store-ui-theme.md`](../docs/v2-bonus-multi-store-ui-theme.md) | bonus only |
| `logo/`: SVG logo, favicon, site icon | here | BRD-02 |
| `products/`: product images (with licence/attribution) | here | BRD-05 |

**How it fits into the code:** see [`INTEGRATION_GUIDE.md`](INTEGRATION_GUIDE.md). It covers the surfaces themed, what's still missing, and what breaks.

## Implementation (Phase 9, 2026-10-12)
| What | Where |
|---|---|
| Theme (`tatva`, child of Twenty Twenty-Five) | `services/store-assets/theme/tatva/` |
| Catalogue (50 products, 5 categories, 9 placeholder brands) | `services/store-assets/catalogue/catalogue.json` |
| Product, category and editorial images (CC0 / Public Domain, WebP) | `services/store-assets/images/` |
| Image records (source, creator, licence, URLs, checksum, alt) | `services/store-assets/images/manifest.json` |
| Importer (idempotent, run by wp-init) | `services/store-assets/import/import-catalogue.php` |
| Image tools: search, fetch/crop, validate | `scripts/brand/` |
| Logo, site icon | `brand/logo/` |
| wp-admin colour scheme and login page (BRD-08) | `services/store-assets/theme/tatva/inc/admin.php`, `assets/css/admin-colors.css`, `assets/css/login.css`; check: `scripts/admin-screens.sh` |
| Screenshots | `docs/evidence/brd-07-*.jpg`, `docs/evidence/brd-08-*.jpg` |
