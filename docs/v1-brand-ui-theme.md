# V1 — Brand, UI & Theme Specification

> Scope: visual identity, brand presentation, storefront UI, page layouts, interaction design, and theme only. This document deliberately excludes backend architecture and implementation details.

## 1. Brand direction

### Working name
**Brand** is a temporary placeholder. Do not treat it as the final public name, logo, or trademark.

### Concept
A premium, editorial shopping destination that brings distinctive Indian brands and products together in one carefully presented storefront. Customers can browse by category, discover featured brands, read brand stories, and shop products without being redirected to another website.

### Positioning
**Distinctive finds from brands worth discovering.**

The experience should feel considered and trustworthy rather than crowded, discount-led, or like a generic product directory.

### Brand personality
- Thoughtful and selective
- Contemporary, warm, and understated
- Curious about design, craft, usefulness, and responsible choices
- Approachable rather than exclusive or overly luxurious
- Clear and honest about product details and brand claims

### Voice and copy
Use concise, human language. Prefer specific descriptions over exaggerated marketing claims.

Example directions:
- Hero headline: **Discover something different.**
- Supporting copy: *Explore distinctive products from independent and established Indian brands, thoughtfully brought together in one place.*
- Category introduction: *Good things for the way you live.*
- Brand section: *Meet the makers and ideas behind the products.*
- Concept-page heading: *A more thoughtful way to discover brands.*

These are draft examples, not locked copy.

## 2. Visual theme

### Colour palette

| Token | Suggested value | Use |
|---|---|---|
| Warm ivory | `#F8F6F0` | Main page background |
| Forest green | `#173D35` | Primary brand colour, prominent actions |
| Soft sage | `#A6B7A0` | Secondary accents and subtle highlights |
| Sand | `#E8DCC9` | Editorial panels and warm surfaces |
| Charcoal | `#252A27` | Main text |
| Muted grey | `#737873` | Supporting text, metadata and captions |
| White | `#FFFFFF` | Product cards and contrast surfaces |

Use green deliberately rather than everywhere. Keep text contrast strong and reserve accent colours for meaningful actions or states.

### Typography
- Use an editorial serif for selected large headlines if it pairs well with the interface.
- Use a highly legible sans-serif for navigation, product names, prices, filters, forms, and body text.
- Establish a consistent scale for display headings, section headings, body copy, labels, and metadata.
- Avoid overly decorative fonts and excessive all-caps text.

### Photography and imagery
- Use large, high-quality product and lifestyle photography with natural light and tactile materials.
- Keep product-image crops and card ratios consistent within each collection.
- Use real brand/product imagery where permission and availability allow.
- Do not invent sustainability, origin, handmade, or other product claims.
- Avoid generic stock imagery that makes every brand feel identical.
- Give each brand room for its own visual character while keeping the overall storefront cohesive.

### Layout and components
- Generous whitespace and a clear visual hierarchy.
- Restrained borders and soft corner radii; avoid making every element a pill or rounded card.
- A consistent grid, spacing scale, image ratio, and button system.
- Subtle hover and focus states; motion should be brief and purposeful.
- Responsive layouts designed for mobile first as well as desktop.
- Accessible contrast, visible keyboard focus, descriptive labels, and clear form feedback.

## 3. Storefront navigation

Primary navigation:
- Home
- Shop
- Brands
- Categories
- About / Our Concept

Utility navigation:
- Search
- Account
- Cart

Keep the navigation compact. On smaller screens, use a clear mobile menu and preserve quick access to search and cart.

## 4. Homepage layout

Follow the supplied visual reference broadly: warm neutral background, forest-green details, editorial imagery, image-led categories, featured brands, product cards, and a concept/story section.

### Section order

1. **Header**
   - Temporary wordmark at left
   - Primary navigation
   - Search, account, and cart actions
2. **Editorial hero**
   - Headline: “Discover something different.”
   - Short explanation of the curated multi-brand concept
   - Primary CTA: “Explore the collection”
   - Large lifestyle/product image
3. **Curation principles**
   - A small number of concise points, such as distinctive design, useful products, and thoughtful discovery
   - Only make claims that the store can substantiate
4. **Shop by category**
   - Image-led tiles
   - Example categories: Fashion, Home & Living, Beauty & Personal Care, Food & Beverages, Books & Stationery, Electronics & Gadgets, Art & Accessories
   - Show only categories that actually contain products
5. **Featured brands**
   - Consistent brand cards with logo or image, short description, and “Explore brand” action
6. **Featured products**
   - Product image, product name, brand name, price, and optional wishlist action
   - Avoid cluttering cards with too many badges
7. **Curated collection**
   - An editorially named collection with a short explanation and a product selection
8. **Our concept**
   - Briefly explain why the store brings these brands together and how curation works
   - Link to the full concept page
9. **Footer**
   - About, contact, help, policies, social links, and newsletter only if those functions exist

## 5. Required page designs

### Shop / product listing
- Page title and short introduction
- Search and useful filters
- Filters may include category, brand, price range, and relevant product attributes
- Sort options with understandable labels
- Product grid with consistent card dimensions
- Clear empty state when no products match
- Mobile filters should be easy to open, review, and clear

### Brand directory
- Introductory statement about discovering brands
- Search or alphabetic/category filtering if the number of brands warrants it
- Brand cards with visual identity, concise description, and “Explore brand”
- No false implication that a brand officially partners with the store

### Individual brand page
- Brand name and approved logo or visual
- Short brand introduction and story
- Relevant products from that brand
- Optional verified details such as location, founding story, materials, or values
- Consistent structure across brands, with enough flexibility for distinct photography and tone

### Product detail
- Product gallery
- Product name, brand attribution, price, and availability
- Clear product description, variants, and relevant specifications
- Add-to-cart action and understandable feedback
- Delivery/returns information only when known and applicable
- Related products or more from the same brand
- No external-store redirect as the main shopping path

### Cart and checkout
- Clear line items, quantities, prices, and order total
- Obvious edit/remove controls
- Clear validation and error states
- Reassuring but factual checkout language
- Do not display payment methods or delivery promises that are not configured

### Our concept page
- The reason this store exists
- What “curated” means in practice
- How brands and products are selected
- The values guiding selection, stated without unsupported claims
- A route back to shop, categories, and brands

## 6. Product and brand card rules

### Product cards
Show, in this order of importance:
1. Product image
2. Product name
3. Brand name
4. Price
5. Optional secondary action, such as wishlist

Use sale prices only when real. Avoid fabricated review counts, ratings, stock warnings, or urgency labels.

### Brand cards
Show:
1. Brand mark or suitable image
2. Brand name
3. One-line description
4. “Explore brand” action

Do not make logos compete with product imagery. Maintain consistent card spacing and image treatment.

## 7. Interaction and states

Design and document:
- Default, hover, focus, active, disabled, and loading states
- Search with no results
- Filters with no matching products
- Out-of-stock products
- Add-to-cart confirmation and cart errors
- Missing product imagery
- Mobile navigation and filter behaviour
- Checkout validation and failure feedback

Use motion sparingly. Do not make essential information depend on hover.

## 8. V1 visual boundaries

In scope:
- One coherent storefront
- Multiple brands displayed within the same store
- Brand directory and individual brand pages
- Product discovery by category and brand
- Editorial collections and concept storytelling
- Shopping UI with a consistent visual language

Not part of the V1 UI:
- Seller registration or seller dashboards
- Seller-specific product management
- Marketplace commission screens
- Seller payout or dispute dashboards
- Links that send customers away to a brand's own store as the normal purchase journey

## 9. Design acceptance checklist

- [ ] The storefront follows the reference image's warm, premium, editorial direction.
- [ ] Customers can understand the concept from the homepage.
- [ ] Shop, category, brand, and product pages feel like one coherent experience.
- [ ] Brand identity is visible without overwhelming product discovery.
- [ ] Customers can browse and purchase within the same storefront.
- [ ] Mobile layouts are deliberate, not merely compressed desktop layouts.
- [ ] Text contrast, focus states, labels, and feedback are accessible.
- [ ] All brand and product claims are accurate and substantiated.
- [ ] “Brand” remains a placeholder until a final name and identity are approved.
