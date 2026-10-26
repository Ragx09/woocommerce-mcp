# Product Image Implementation — TATVA V1 (Open-License Image Sourcing)

Implement a complete, consistent product-image system for the TATVA V1 storefront using images sourced from legitimate open-license or public-domain image repositories.

## 1. Inspect the Existing Project First

Before making changes:

- Inspect the existing image handling, product schema, WooCommerce media integration, frontend asset conventions, and current product catalogue.
- Read `tatva-brand-and-products.md` and `v1-brand-ui-theme.md`.
- Identify the 16 catalogue products and their categories.
- Understand how product images are currently stored, referenced, imported, and displayed.
- Preserve the existing WooCommerce media workflow unless there is a clear technical reason to change it.
- Do not modify unrelated services or overwrite existing working functionality.

## 2. Use These Open-License Image Sources

Search the following sources for relevant, high-quality product and lifestyle photography.

### Primary sources

1. **Openverse** — https://openverse.org/
   - Search openly licensed and public-domain images.
   - API documentation: https://api.openverse.org/v1/
   - API reference: https://docs.openverse.org/api/
   - Prefer images with clearly documented commercial-use permissions.

2. **Wikimedia Commons** — https://commons.wikimedia.org/
   - Search for relevant products, traditional crafts, natural materials, plants, textiles, and decorative objects.
   - API documentation: https://www.mediawiki.org/wiki/API:Main_page
   - Verify the individual file's licensing and attribution requirements.

3. **Unsplash** — https://unsplash.com/
   - Useful for premium lifestyle photography, interiors, natural textures, and editorial backgrounds.
   - License: https://unsplash.com/license
   - API documentation: https://unsplash.com/documentation
   - If using the API, comply with its API guidelines and image attribution requirements.

4. **Pexels** — https://www.pexels.com/
   - Useful for lifestyle scenes, interiors, home decor, nature, and product-related photography.
   - License: https://www.pexels.com/license/
   - API documentation: https://www.pexels.com/api/documentation/

5. **Pixabay** — https://pixabay.com/
   - Useful for supplementary lifestyle and product imagery.
   - License: https://pixabay.com/service/license-summary/
   - API documentation: https://pixabay.com/api/docs/

Use these repositories as search sources, not as blanket permission to download every image. Verify each asset's applicable license, API requirements, attribution requirements, and commercial-use restrictions before downloading.

Do not scrape websites in violation of their terms. Prefer official APIs and documented download mechanisms.

## 3. Create a Dedicated Image Manifest

Create or update an image manifest covering every product in `tatva-brand-and-products.md`.

The manifest must contain at least:

- Product ID or SKU
- Exact product name
- Product category
- Local image path or WooCommerce media ID
- Original source page URL
- Direct asset URL, when available and permitted
- Source repository
- Creator or photographer, when available
- License name and license URL
- Attribution text, if required
- Image role: product, lifestyle, category, or homepage
- Image dimensions
- Download and validation status

Use the repository's established manifest format if one already exists. Otherwise, use a structured CSV or JSON file.

Every product must have an explicit mapping to its own appropriate image asset. Never associate an image with a product merely because the filename or category happens to match.

## 4. Source Separate Images for All 16 Products

Find and download relevant images for all 16 products listed in `tatva-brand-and-products.md`.

Requirements:

- Each product must have its own image mapping.
- Prefer a distinct, relevant image for every product.
- Avoid reusing a generic photograph across unrelated products.
- Search by the exact product name, its defining materials, its intended use, and appropriate descriptive keywords.
- If an exact product image is unavailable, select a visually relevant representative image only when it does not misrepresent the product.
- Mark representative imagery clearly as demo imagery.
- Never claim a generic image depicts the exact real product, manufacturer, or supplier.
- Do not invent supplier identities, materials, certifications, or product specifications based on an image.
- If no suitable, appropriately licensed image exists, record the product as missing rather than using an unrelated photograph.

## 5. Maintain the TATVA Visual Identity

Follow the visual direction in `v1-brand-ui-theme.md`.

Target photography style:

- Warm ivory and neutral backgrounds.
- Soft, natural daylight.
- Earthy, tactile materials and organic textures.
- Refined, premium editorial composition.
- Subtle forest-green accents.
- Minimal visual clutter.
- Consistent lighting and image quality.
- A cohesive, sustainable-lifestyle aesthetic.

Prefer images that naturally fit this visual direction. Do not apply aggressive filters or artificial edits that misrepresent products.

Where appropriate, use local image processing to standardize cropping, resolution, and file formats while preserving the original image's integrity.

## 6. Source Homepage and Category Imagery

Inspect `v1-brand-ui-theme.md` to identify all required homepage and category visuals.

Create appropriate mappings for:

- Homepage hero or lifestyle imagery.
- Category banners or category cards.
- Supporting editorial imagery.
- Any other image slots required by the existing V1 design.

Use images that fit the intended category and visual composition.

Keep homepage and category imagery separate from product-specific imagery unless the same asset is genuinely appropriate for both uses.

Track these assets in the manifest, including their source URLs and licenses.

## 7. Download and Store Images Locally

- Save approved images in the repository's established asset directory.
- Follow existing naming conventions where available.
- If no convention exists, use predictable filenames based on product SKU or a normalized product identifier.
- Avoid unstable temporary URLs, expiring links, hotlinking, and runtime dependence on third-party image hosts.
- Do not replace working WooCommerce media storage with a new mechanism without justification.
- If the established workflow requires WooCommerce-hosted media, use the existing media integration to upload the locally sourced images and associate the resulting media IDs with the correct products.
- Keep local source assets and manifest metadata available as appropriate for the repository's deployment workflow.
- Do not commit unnecessary duplicates or oversized original files if the project has an established optimization process.

Use reasonable image dimensions and formats. Prefer WebP or another format supported by the existing frontend, while retaining suitable source files and complying with source-license conditions.

## 8. Update Product and Frontend Image Integration

Update the existing implementation so that the correct images appear in:

- Product catalogue records.
- Product cards and product grids.
- Product detail pages.
- Category listings and banners.
- Homepage hero and lifestyle sections.
- Any other existing storefront component that displays product imagery.

Requirements:

- Keep image references connected to the corresponding product records.
- Preserve the existing product schema and WooCommerce integration wherever possible.
- Maintain the intended aspect ratio.
- Use appropriate `object-fit` and positioning for product images versus lifestyle photography.
- Add meaningful alt text describing the actual visible content.
- Avoid keyword stuffing in alt text.
- Ensure images do not distort, overflow, or break layouts on mobile.
- Add graceful fallbacks for missing or failed images.
- Avoid unnecessary layout shifts while images load.
- Preserve existing lazy-loading and responsive-image behaviour where appropriate.

Do not hardcode unrelated product images into shared components. Use the correct product-specific image reference.

## 9. Respect Licensing and Attribution

- Download only assets whose usage terms permit the intended use.
- Check the individual asset's license rather than relying solely on the repository's general description.
- Record source URLs and license details for every downloaded image.
- Preserve required attribution and notices.
- Check restrictions on commercial use, modification, redistribution, and use in product listings.
- Do not assume that an image is freely reusable merely because it appears in search results.
- Avoid images containing prominent third-party trademarks, identifiable products from other brands, or people where usage could imply an endorsement.
- Do not remove watermarks or bypass access controls.
- Do not copy third-party images without permission.

Clearly distinguish demo imagery from verified photographs of real supplier products.

## 10. Validation and Testing

After implementation:

- Verify that every one of the 16 catalogue products has a valid image mapping.
- Confirm that every referenced local asset exists.
- Check that downloaded files are valid image files and not HTML error pages.
- Verify that image URLs, source pages, and license records are present in the manifest.
- Check dimensions, file sizes, aspect ratios, and duplicate files.
- Confirm that product records point to the correct images.
- Test homepage, category, product-card, and product-detail image rendering.
- Test the existing WooCommerce media workflow if applicable.
- Run available project tests and build checks.
- Check desktop and mobile layouts.
- Identify broken references, missing files, invalid licenses, and products for which no suitable image could be found.

Do not report an image as successfully downloaded, licensed, uploaded, or validated unless that operation has actually succeeded.

## 11. Final Deliverables

When finished, report:

1. Files inspected and modified.
2. Number of product images successfully sourced and downloaded.
3. Number of homepage, lifestyle, and category images sourced.
4. Location of the image manifest.
5. Location of the downloaded assets.
6. WooCommerce media IDs or product-field mappings updated, where applicable.
7. Source repository and license information for the images.
8. Any required attribution.
9. Missing images and unresolved licensing issues.
10. Validation and test results.
11. Any remaining manual steps.

**Execution priority:** Inspect first, source and verify images second, download and map assets third, integrate into the storefront fourth, and validate everything last. Complete the work using the existing project architecture, and do not fabricate results for unfinished steps.

## 12. Owner-supplied images (2026-10-26)
The 12 products with no usable open-licence image and 35 wrong or weak ones were replaced by images the project owner supplied
(AI-generated illustrations: `tatva_ridgeline_product_images.zip` and `Retail Product Catalog Grid.png`). They are final (no backups).
Pipeline: `esrgan_upscale.py` (Real-ESRGAN x4plus, CPU), `import_supplied_images.py` + `supplied_images.json` (layout per SKU: 4:5 crop or
background continued to 4:5, 1000x1250 WebP, manifest entry). The manifest records the licence "AI-generated illustration, supplied by the
project owner"; they are demo imagery, not verified photographs, and AI-made label text can contain errors.
