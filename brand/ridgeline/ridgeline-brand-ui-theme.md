# RIDGELINE --- Brand, UI & Theme Specification

> **Scope:** Visual identity, brand presentation, customer-facing
> WooCommerce storefront UI, page layouts, and interaction design.
> Product strategy and catalogue definition are specified separately in
> `ridgeline-brand-products.md`. This document does not prescribe
> backend architecture.

------------------------------------------------------------------------

## 1. Brand direction

### Brand name

**RIDGELINE** --- proposed working name, subject to domain and trademark
checks.

### Concept

A premium, adventure-led shopping destination for motorcycle riders,
drivers, and travellers. The store brings riding gear, bike accessories,
car accessories, touring equipment, maintenance products, and
road-inspired lifestyle goods together in one cohesive shopping
experience.

### Positioning

**Built for Better Journeys.**

RIDGELINE should feel rugged and capable without being cluttered or
aggressively masculine. It combines adventure photography and road-trip
storytelling with a clean, practical shopping interface.

### Brand personality

-   Adventurous, capable, and independent.
-   Practical and trustworthy.
-   Premium but approachable.
-   Contemporary rather than retro-costume themed.
-   Clear about product specifications, fitment, safety, shipping, and
    returns.
-   Inspired by road trips, mountain routes, camping, touring, and
    everyday mobility.

### Voice and copy

Use concise, natural, confident language. Use emotional storytelling for
brand campaigns and factual, specific copy for product details.

Draft copy directions: - Hero headline: **Built for Better Journeys.** -
Supporting copy: *Gear, accessories, and essentials for your bike, your
car, and the road ahead.* - Riding category: *Find your next ride
essential.* - Touring collection: *Pack well. Ride farther.* - Car
category: *Practical upgrades for every drive.* - Brand section: *Good
gear makes the journey better.* - CTA: **Explore the Gear** / **Shop
Riding Gear** / **Shop Car Accessories**

These are proposed copy directions and can be refined during
implementation.

------------------------------------------------------------------------

## 2. Visual theme

### Colour palette

  -----------------------------------------------------------------------
  Token                   Suggested value         Use
  ----------------------- ----------------------- -----------------------
  Forest charcoal         `#202820`               Main header, dark
                                                  sections, footer, hero
                                                  overlays

  Warm ivory              `#F4F1E9`               Main page background
                                                  and editorial sections

  Sandstone               `#D9C8A1`               Secondary accents,
                                                  selected highlights,
                                                  subtle borders

  Trail rust              `#B75C3B`               Occasional CTA accent,
                                                  sale or campaign
                                                  highlights

  Slate                   `#333B43`               Secondary dark surfaces
                                                  and utility areas

  White                   `#FFFFFF`               Product cards and
                                                  high-contrast surfaces

  Body charcoal           `#252A27`               Main text on light
                                                  backgrounds

  Muted grey              `#737873`               Captions, metadata, and
                                                  supporting text
  -----------------------------------------------------------------------

Use forest charcoal and warm ivory as the main visual foundation. Use
sandstone for a warm outdoor feel and trail rust sparingly so important
actions remain clear. Maintain accessible text contrast; do not rely on
colour alone for status or errors.

### Typography

-   Use a bold, slightly condensed sans-serif for headings and
    navigation.
-   Use a highly legible sans-serif for product names, prices, filters,
    forms, and body copy.
-   Optional restrained display lettering may be used for campaign
    headlines, but readability takes priority.
-   Avoid excessive all-caps copy, distressed fonts, and overly
    decorative military-style lettering.
-   Use consistent typography tokens for display headings, section
    headings, body copy, labels, and metadata.

### Logo direction

Develop a simple wordmark for **RIDGELINE**, with an optional geometric
ridge or mountain-line symbol.

Requirements: - Readable at small sizes in the website header and mobile
menu. - Works in a single colour. - Works on both dark and light
backgrounds. - Avoid detailed illustrations that become illegible at
favicon size. - Use the tagline "RIDE · DRIVE · EXPLORE" as a secondary
lockup where space permits.

The logo should be original and should not imitate another outdoor,
automotive, or motorcycle brand.

### Photography and imagery

-   Use cinematic road-trip and adventure imagery for campaign areas.
-   Use clear, well-lit product photography on category, listing, and
    product-detail pages.
-   Keep product image ratios consistent within a collection.
-   Combine contextual imagery with straightforward product views;
    shoppers must be able to inspect the actual item.
-   Use real supplier or manufacturer imagery only where permitted.
-   Avoid implying that a product was tested in conditions or locations
    that have not been verified.
-   Do not use mountain imagery on every single section; include urban
    commuting, workshop, car-travel, and everyday-use contexts.

### Layout and components

-   Strong hierarchy, clean grids, and deliberate whitespace.
-   Dark navigation and campaign panels balanced with light shopping
    surfaces.
-   Restrained borders and consistent corner radii.
-   Product cards should focus on image, product name, brand, and price.
-   Subtle hover and focus states; motion should be brief and
    purposeful.
-   Mobile-first responsive layouts.
-   Accessible contrast, visible keyboard focus, descriptive labels, and
    useful error feedback.

------------------------------------------------------------------------

## 3. Storefront navigation

### Primary navigation

-   Home
-   Riding Gear
-   Bike Accessories
-   Car Accessories
-   Travel & Touring
-   Maintenance & Care
-   Lifestyle
-   Offers (only when real offers exist)

### Utility navigation

-   Search
-   Account
-   Wishlist (only if implemented)
-   Cart

Use compact dropdowns or mega menus on desktop if they improve category
discovery. On mobile, use a simple menu with clear category groupings
and persistent access to search and cart.

Do not add menu items that lead to empty categories or unimplemented
features.

------------------------------------------------------------------------

## 4. Homepage layout

The homepage should follow the visual direction of a premium adventure
outfitter: a dark header, cinematic road imagery, strong headline, warm
neutral shopping sections, image-led categories, and carefully selected
products.

### Section order

1.  **Announcement bar --- optional**
    -   Only show a real shipping, launch, or service message.
    -   Do not invent free-shipping thresholds or delivery promises.
2.  **Header**
    -   RIDGELINE wordmark and optional mountain-line symbol.
    -   Main category navigation.
    -   Search, account, and cart.
    -   Sticky behaviour only if it does not crowd mobile content.
3.  **Hero**
    -   Wide cinematic motorcycle or road-trip image.
    -   Headline: "Built for Better Journeys."
    -   Short copy about gear for bikes, cars, and travel.
    -   Primary CTA: "Shop Riding Gear."
    -   Secondary CTA: "Explore Car Accessories."
    -   Use legible text overlays and a mobile-specific crop.
4.  **Shop by category**
    -   Riding Gear & Protection.
    -   Motorcycle Accessories.
    -   Car Accessories.
    -   Travel & Touring.
    -   Maintenance & Care.
    -   Lifestyle & Everyday Carry.
    -   Electronics & Connectivity.
    -   Show categories that contain products; avoid empty category
        tiles.
5.  **Featured products**
    -   Product image, name, brand, price, and optional wishlist action.
    -   Keep labels restrained.
    -   Do not show fabricated ratings or discount badges.
6.  **Shop by journey / curated collections**
    -   The Everyday Rider.
    -   Weekend Escape.
    -   Long-Distance Touring.
    -   Car Trip Essentials.
    -   Keep It Running.
    -   The RIDGELINE Edit.
    -   Each collection should have a short explanation and relevant
        products.
7.  **Rider and driver essentials**
    -   A compact section that helps shoppers find useful everyday
        products.
    -   Link to category pages rather than duplicating a huge product
        grid.
8.  **Why shop RIDGELINE**
    -   Use factual points only, such as clear product information,
        fitment guidance where available, or responsive support if those
        services are actually provided.
    -   Do not claim "authorised products," "verified safety," or
        "hassle-free returns" unless the operating model supports it.
9.  **Journal / road notes --- optional**
    -   Road-trip preparation, product-care guides, fitment explainers,
        and gear checklists.
    -   Include only if content will be maintained.
10. **Newsletter --- optional**
    -   Explain what subscribers will receive.
    -   Include only if the signup and consent flow work.
11. **Footer**
    -   About RIDGELINE.
    -   Contact and support.
    -   Shipping and returns.
    -   Warranty information where applicable.
    -   Privacy, terms, and other required policies.
    -   Social links only for active profiles.

------------------------------------------------------------------------

## 5. Required page designs

### Shop / product listing

-   Page title and concise introduction.
-   Search and useful filters.
-   Filters may include category, brand, price, availability, and
    product attributes.
-   Vehicle compatibility filters only where the underlying product data
    supports them.
-   Sort options with understandable labels.
-   Consistent product grid and image ratio.
-   Clear empty state when no products match.
-   Mobile filters should be easy to open, review, apply, and clear.

### Category page

-   Category name, short introduction, and relevant hero image if
    useful.
-   Subcategory links for large categories.
-   Product grid with filters and sorting.
-   Relevant advice or fitment notes where helpful.
-   Do not use the same generic description for every category.

### Product detail

-   Product gallery with consistent image handling.
-   Product name, brand, price, and stock availability.
-   Clear short description and full description.
-   Variants such as size or colour when available.
-   Relevant specifications: materials, dimensions, capacity, contents,
    installation, and care.
-   Compatibility / fitment details for vehicle-specific products.
-   Safety certifications only when verified.
-   Add-to-cart action with clear feedback.
-   Shipping, returns, and warranty details only when known.
-   Related products or relevant accessories.
-   No external-store redirect as the primary purchase path.

### Brand / manufacturer page

-   Brand name and approved visual identity.
-   Concise description based on verified information.
-   Products available through RIDGELINE.
-   Manufacturer or origin information only when confirmed.
-   Do not imply official partnership or authorisation without evidence.

### Search results

-   Search term shown clearly.
-   Useful product results with consistent cards.
-   Suggestions for categories if no exact match is found.
-   A helpful no-results state with a way to clear or broaden the
    search.

### Cart and checkout

-   Clear line items, quantities, prices, and order total.
-   Obvious edit and remove controls.
-   Clear validation and error states.
-   Display only configured payment methods.
-   Show shipping charges and delivery estimates only when the shipping
    configuration supports them.
-   Reassuring but factual checkout language.
-   Make mobile checkout straightforward.

### About RIDGELINE

-   Explain the riding, driving, and travel focus.
-   Describe how products are selected.
-   Explain the difference between RIDGELINE-labelled items and
    third-party brands where applicable.
-   Avoid invented founder stories, testing claims, and unsupported
    sustainability claims.
-   Provide clear routes back to shopping.

------------------------------------------------------------------------

## 6. Product and collection card rules

### Product cards

Show, in order of importance: 1. Product image. 2. Product name. 3.
Brand / manufacturer label. 4. Price. 5. Optional variant hint or
wishlist action.

Use sale prices only when real. Avoid cluttering cards with multiple
badges. Ratings and review counts should appear only when genuine review
data exists.

### Collection cards

Show: 1. Relevant journey or use-case image. 2. Collection title. 3.
One-line explanation. 4. "Explore collection" action.

Collections should help shoppers choose by intended use---commuting,
touring, car travel, maintenance---not just by marketing theme.

### Trust and safety information

-   Make fitment information easy to find.
-   Keep sizing guides close to size selection.
-   Display verified certifications and manufacturer details clearly.
-   Never use an icon or badge to imply certification without evidence.
-   Do not invent warranty, shipping, or return benefits.

------------------------------------------------------------------------

## 7. Interaction and states

Design and document:

-   Default, hover, focus, active, disabled, and loading states.
-   Search with no results.
-   Filters with no matching products.
-   Out-of-stock products.
-   Product variants that are unavailable.
-   Add-to-cart confirmation and cart errors.
-   Missing product imagery.
-   Compatibility information that is unknown or incomplete.
-   Mobile navigation and filter behaviour.
-   Checkout validation and payment failure feedback.
-   Clear confirmation for actions that change cart quantities or remove
    items.

Use motion sparingly. Do not make essential information dependent on
hover.

------------------------------------------------------------------------

## 8. Responsive behaviour and accessibility

-   Design for small mobile screens first, then tablet and desktop.
-   Keep navigation, search, and cart accessible on mobile.
-   Use large enough tap targets for filters, variant selectors, and
    cart actions.
-   Keep product titles and prices readable without excessive
    truncation.
-   Ensure hero text remains legible on different image crops.
-   Provide descriptive alt text for meaningful product images.
-   Use visible keyboard focus and labelled form controls.
-   Pair colour-based status with text or icons.
-   Respect reduced-motion preferences where supported.

------------------------------------------------------------------------

## 9. V1 visual boundaries

### In scope

-   One customer-facing WooCommerce storefront.
-   Multiple third-party brands within one store.
-   Product discovery by category, brand, and supported attributes.
-   Product detail pages with variants and compatibility information
    where relevant.
-   Curated collections and journey-based merchandising.
-   Cart and checkout UI.
-   Responsive mobile and desktop presentation.
-   A coherent RIDGELINE visual identity.

### Not implied by this UI specification

-   A multi-vendor marketplace with seller accounts.
-   Seller-specific dashboards, commissions, or payouts.
-   Automatic supplier stock synchronisation unless separately
    implemented.
-   Vehicle-fitment data that has not been supplied.
-   Product certification verification as an automated service.
-   A live shipping, payment, warranty, or returns integration merely
    because the UI contains a placeholder for it.
-   A separate dashboard for provisioning multiple WooCommerce stores.

------------------------------------------------------------------------

## 10. Design acceptance checklist

-   [ ] The store consistently uses RIDGELINE, subject to name
    clearance.
-   [ ] "Ride. Drive. Explore." is used as the primary brand line.
-   [ ] The homepage communicates riding, driving, and travel in a few
    seconds.
-   [ ] Motorcycle, car, and travel categories are equally easy to find.
-   [ ] The theme uses forest charcoal, warm ivory, sandstone, and
    restrained trail-rust accents.
-   [ ] Product cards prioritise imagery, product name, brand, and
    price.
-   [ ] Product pages surface specifications and fitment details where
    relevant.
-   [ ] Safety and certification claims are factual and substantiated.
-   [ ] Search, filters, cart, and checkout have clear feedback and
    error states.
-   [ ] Mobile layouts are deliberately designed, not merely compressed
    desktop layouts.
-   [ ] Contrast, focus states, labels, and feedback are accessible.
-   [ ] No fake reviews, scarcity, offers, or service promises appear.
-   [ ] The storefront feels premium and adventurous without becoming
    visually cluttered.
