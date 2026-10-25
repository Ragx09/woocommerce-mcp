# Brand integration guide: storefront (TATVA, current working concept)

This guide explains how to turn a rough brand idea into the running store without breaking checkout, the MCP tools or the "same chart deploys locally and on the VPS" rule. It belongs to **Phase 9 (BRD-01…07)** in [`TASKS.md`](../../TASKS.md). The related decisions are D-015 (store concept: TATVA for now, may change) and D-016 (theme approach, still Proposed).

Design reference: [`brand/tatva/v1-brand-ui-theme.md`](../brand/tatva/v1-brand-ui-theme.md) (current). The earlier Urumi mockup `Urumi Curated Indian Marketplace Homepage.png` (outside the repo, `/mnt/c/Users/arcot/ragx/Woocommerce/`) is superseded; sections below that describe it are kept as layout inspiration.

---

## 1. How to use this guide

1. Fill in the templates in §4 and drop the files into `brand/`.
2. Each file unblocks one BRD task (table in §5).
3. Tasks are implemented one at a time with the normal per-task workflow from `CLAUDE.md`: test, record evidence, update docs, run `npm run tracker`.
4. Phase 9 is **P2**. It's the first thing cut if behind (`TASKS.md:18`), and it never delays P0 work.

You don't need everything at once. `BRAND.md` plus `products.csv` is enough to start BRD-01 and BRD-05.

---

## 2. Surfaces the brand takes over

There are 2 hosts and 3 surfaces.

| # | Surface | URL | Exists? | Where its look comes from | Task |
|---|---|---|---|---|---|
| 1 | **Storefront**: home, shop, category, brand, product, cart, checkout, my account, order received, About | `store.<domain>/…` | Yes (default WP block theme, unbranded) | The new theme (`theme.json` + templates) | BRD-03, 04, 06 |
| 2 | WooCommerce emails (order confirmation and similar) | Email | Yes (Woo defaults) | `woocommerce_email_*` options (base colour, header image, footer text) set by wp-init | Optional, BRD-06 |
| 3 | Team dashboard + chat | `app.<domain>/` | Not built (UI-01…20) | Optional: reuse the same tokens in `apps/dashboard` | Optional, Phase 6 |

**Not themed:**
- `app.<domain>/mcp` and `/api/*` (JSON and MCP only).
- wp-admin.
- `tracker/index.html`.

---

## 3. What we already have vs what's missing

### Already given by the mockup
- **Homepage layout, top to bottom:**
  1. Header: logo; Home / Shop / Brands / Categories / About; search, account and cart icons.
  2. Hero: "Discover India's Most Inspiring Brands", a search bar, and the script tagline "Real people. Real brands. Real India."
  3. Value-props strip.
  4. Shop by Category.
  5. Featured Brands.
  6. Featured Products, with a wishlist heart.
  7. "The concept" band (Urumi mockup wording: "Indian Brands. Global Dreams.") (Discover / Shop / Support / Be Part of a Bigger Story).
- **7 categories:** Fashion & Apparel, Home & Living, Beauty & Personal Care, Food & Beverages, Books & Stationery, Electronics & Gadgets, Art & Accessories.
- **7 featured brands:** MittiCrafters, FabIndia, The Souled Store, Paper Riot, Blue Tokai, Bira 91, The Minimalist.
- **6 featured products in ₹:**

  | Product | Brand | Price |
  |---|---|---|
  | Handcrafted Ceramic Mug | MittiCrafters | 1,299 |
  | Block Print Cotton Kurta | FabIndia | 2,499 |
  | Single Origin Coffee | Blue Tokai | 599 |
  | Leather Card Holder | The Minimalist | 1,499 |
  | Recycled Paper Journal | Paper Riot | 349 |
  | Wireless Earbuds | Bira 91 | 2,999 |

- **Colour mood:** forest green, warm cream, terracotta/clay, dark ink. There's a serif display font and a clean sans body font.

### Still missing (blocks the tasks below)

| Missing | Why it matters | Put it in | Unblocks |
|---|---|---|---|
| Logo as **SVG** (wordmark + mark), favicon | The mockup logo is raster and can't be cut out cleanly | `brand/tatva/logo/` | BRD-02 |
| **Exact hex values and font names** (with licence) | Without them, colours are guessed from a PNG | `brand/palette.md` | BRD-02 → 03 |
| **Full catalogue**: ~50 products (proposed, `brand/tatva/tatva-brand-and-products.md` §6) | The mockup has 6; every category needs products | `brand/products/products.csv` | BRD-05 |
| **Separate images** for products, categories and brand logos | Mockup images are part of one composite PNG. You need separate files that are licensed, self-made or AI-generated. | `brand/products/images/`, `brand/categories/`, `brand/brands/` | BRD-05, 04 |
| **Other page designs**: product page, shop/category listing, brand page, cart/checkout look, About copy, footer, **mobile** | The mockup only shows the desktop homepage | `brand/theme/` | BRD-03 (currently **Blocked** on this), BRD-04 |
| **Real vs fictional brand names** | FabIndia, Bira 91 and the others are trademarks (D-015). Deciding now avoids redoing the catalogue at REL-16/17. | Note in `brand/BRAND.md` | BRD-01 |
| Chat persona (name, voice) | Optional, for the dashboard chat agent (UI-14) | `brand/BRAND.md` | UI-14 |

If a page design is missing, the fallback is to derive it from the homepage style. That's acceptable, but write it down as an assumption.

---

## 4. Fill-in templates

Copy each block into its own file and replace the `…`.

### 4.1 `brand/BRAND.md` (BRD-01)

```markdown
# TATVA — brand brief (working; see brand/tatva/tatva-brand-and-products.md)
- **One-liner:** …
- **Audience:** …
- **Value proposition:** …
- **Tagline:** Real people. Real brands. Real India.
- **Hero heading / sub-text:** …
- **Tone of voice (3 words + do/don't):** …
- **Currency / country / timezone:** INR (₹) / IN:<state code> / Asia/Kolkata
- **Brand names:** real (local demo only, review before REL-16) | fictional
- **Categories (7):** Fashion & Apparel, Home & Living, …
- **Featured brands:** name — one-line description — city
- **Value props (4):** Support Indian Startups — Help small businesses grow; …
- **About page copy:** …
- **Footer:** columns, links, social, copyright line
- **Chat persona (optional):** name, voice, what it must never do
```

### 4.2 `brand/palette.md` (BRD-02)

Every text/background pair must reach WCAG AA (≥ 4.5:1, TC-BRD-02-1).

```markdown
| Token        | Hex     | Use                        | Contrast vs --bg |
|--------------|---------|----------------------------|------------------|
| --brand      | #…      | buttons, links, accents    | …                |
| --brand-ink  | #…      | text on --brand            | … (vs --brand)   |
| --bg         | #…      | page background (cream)    | —                |
| --surface    | #…      | cards                      | —                |
| --accent     | #…      | terracotta highlights      | …                |
| --ink        | #…      | body text                  | …                |
| --muted      | #…      | secondary text             | …                |
| --err        | #…      | errors / declined          | …                |

Fonts: display = … (licence: …), body = … (licence: …)
Radii: card …px, button …px. Shadow: …
```

### 4.3 `brand/tatva/logo/`

`logo.svg` (wordmark), `mark.svg` (icon only), `favicon.ico`, `site-icon-512.png`. Check it's readable at 32 px and on light and dark backgrounds.

### 4.4 `brand/theme/`

Copy the homepage mockup here. Add screenshots or mockups for:
- Product page.
- Shop/category listing.
- Brand page.
- Cart and checkout.
- Mobile homepage (≤ 400 px).

Also add a `notes.md` covering spacing, radii, shadows, icon set and hover states.

### 4.5 `brand/products/products.csv` (BRD-05)

```csv
sku,name,brand,category,price_inr,featured,short_description,description,image
URU-MUG-001,Handcrafted Ceramic Mug,MittiCrafters,Home & Living,1299,yes,"Hand-thrown in Jaipur","…",URU-MUG-001.webp
```

- **SKU** is the idempotency key. Never reuse or change one.
- **Images** go in `brand/products/images/<sku>.webp`: square, about 1200 px, under 200 KB.
- **Categories and brands:** one image per category in `brand/categories/<slug>.webp`, one logo per brand in `brand/brands/<slug>.svg|png`.

---

## 5. How each input reaches the code

| Task | Input (`brand/`) | Output in the repo | Mechanism |
|---|---|---|---|
| BRD-01 | `BRAND.md` | the same file, reviewed | User approval (TC-BRD-01-1) |
| BRD-02 | `logo/`, `palette.md` | Logo files are final; contrast table filled | Contrast check |
| BRD-03 | `palette.md`, `theme/` | `charts/platform/files/theme/` (`theme.json`, `style.css`) | All colours, fonts, spacing and radii are tokens in `theme.json`. No raw hex anywhere else (TC-BRD-03-1). D-016 is decided here: child of the default block theme vs a custom block theme. |
| BRD-04 | `theme/`, `BRAND.md` | Block templates and patterns (header, hero, value props, category grid, brand grid, featured products, concept band, footer) + About page | |
| BRD-05 | `products.csv`, images | `charts/platform/files/catalogue/products.json` + a wp-init step | Create categories, then Brands (Woo's built-in taxonomy), then products. **Upsert by SKU.** This replaces the inline seed at `wp-init.sh:51-55`, which only runs when the store has zero products. |
| BRD-06 | everything above | Chart templates + wp-init steps, toggled by `store.brand.enabled` | ConfigMap → copied by the wp-init Job → `wp theme activate`, plus `wp option update` for site_icon, custom_logo, menus, page_on_front and the email colours. Images go through an init container or a custom image, because a ConfigMap is limited to 1 MiB (D-016). |
| BRD-07 | — | `docs/evidence/brd-07-*.png` | Screenshots + full checkout and MCP regression |

### Store identity values

These live in `charts/platform/values.yaml:33-39`. Today they are `title: Urumi Demo Store`, `currency: USD`, `timezone: UTC`, `country: "US:CA"`. Change them to:

```yaml
init:
  title: TATVA
  currency: INR
  timezone: Asia/Kolkata
  country: "IN:KA"      # pick the state code
```

`wp core install --title` (`wp-init.sh:15`) only runs on the **first** install. Add `wp option update blogname` and `blogdescription` to wp-init so existing clusters pick up the change too.

### What stays the same on purpose
- **Payment method: Cash on delivery (`cod`) only.** `tests/e2e/checkout.mjs` depends on it.
- **MCP slug `woo` and the tool names `woo__*`.** They're part of the gateway contract (`docs/MCP_DESIGN.md`). Tool descriptions in `services/woo-mcp/src/tools.ts` stay generic.
- **Infra names:** the hosts `store` and `app`, the namespaces `store` and `platform`, the release `platform` and the cluster `mcp`.

---

## 6. Things that break, and the fixes

| What | Where | Fix |
|---|---|---|
| Default product slug `urumi-mug` | `tests/e2e/checkout.mjs:7` | Change the default to a new catalogue slug, or always pass `PRODUCT_SLUG` |
| Old product names | `services/woo-mcp/test/int/woo.int.test.ts:33` | Assert on a few SKUs or names from the new catalogue |
| Orders filtered with `/Urumi/` on item names | `services/woo-mcp/test/int/woo.int.test.ts:55` | The new product names won't contain "Urumi". Filter on the new names or on SKUs. |
| Prices assumed in USD | unit fixtures, `docs/DEMO_RUNBOOK.md:16` ("Demo Mug priced 12.50") | Update the demo prompt to a ₹ product; check TC-BRD-05-3 (₹ prices in `list_products`) |
| Checkout markup changes with the theme | `scripts/e2e-checkout.sh` | Run BRD-07 after every theme change. The payment method radios must stay visible. |
| Old content survives redeploys | the `wordpress-data` PVC has `resource-policy: keep` | For a true fresh test (TC-BRD-06-1): `scripts/down.sh`, delete the store PVCs, then `scripts/up.sh` |
| Seeded upstream display name | `services/gateway/src/upstreams/seed.ts` only sets the name on first seed | Not part of the brand. Leave it as "WooCommerce". |

**Don't edit** `problem-statement.md` (it's authoritative) or past evidence in `TASKS.md`. Record new decisions as a new `D-NNN`.

---

## 7. Order of work

```
BRD-01 BRAND.md ──► BRD-02 logo + palette ──► BRD-03 tokens/theme ──► BRD-04 layout + pay-page re-skin ─┐
        └────────► BRD-05 catalogue + images ──────────────────────────────► BRD-06 packaging ──────────┴─► BRD-07 verify
```

The smallest useful slice, if time is short:
1. BRD-01 plus the store identity values.
2. BRD-05 (₹ catalogue with images).
3. Palette tokens on the default theme and the payment page.

That's already a convincing demo without custom templates.

---

## 8. Verification checklist

- [ ] Fresh cluster: the homepage shows the current brand's logo, tagline, colours and every mockup section in order (TC-BRD-04-1, TC-BRD-06-1).
- [ ] Mobile (≤ 400 px): no horizontal scroll.
- [ ] Every category has products. Re-running wp-init leaves the counts unchanged (TC-BRD-05-1/2).
- [ ] Header search returns products (TC-BRD-04-2).
- [ ] `scripts/e2e-checkout.sh` gives PASS (cod). `scripts/woo-int.sh` all PASS (BRD-07).
- [ ] `woo__list_products` through the gateway returns ₹ prices (TC-BRD-05-3).
- [ ] Delete the wordpress pod: the store is still branded (TC-BRD-06-2).
- [ ] No secrets or real customer data in `brand/`. Trademark review noted for REL-16/17.
