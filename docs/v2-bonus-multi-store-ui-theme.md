# V2 Bonus — Multi-Store Provisioning Dashboard: Brand, UI & Theme Proposal

> Scope: brand presentation, visual theme, dashboard UX, page layouts, and interaction states only. This proposal is based on the optional “multi-store provisioning” bonus in `problem-statement.md`. It does not specify backend implementation.

## 1. Does the marketplace idea match the bonus?

**No.** A multi-brand marketplace and the stated bonus are different concepts.

The bonus asks for a platform where a user can create and delete separate WooCommerce stores from a dashboard. Each store has its own status and URL, and the dashboard makes the stores easy to distinguish and manage.

Therefore, this V2 design is **not a seller marketplace UI**. It is a **multi-store management experience** layered around the WooCommerce hosting platform.

The existing premium storefront can remain the customer-facing design for each individual store. The bonus adds a separate dashboard experience for provisioning and managing multiple store instances.

## 2. Product concept and positioning

### Working name
Use **Brand** as a temporary placeholder for the storefront identity. Do not assume it is the final platform name. The dashboard may share the same provisional identity, but its visual language should prioritize clarity and operational confidence.

### Dashboard purpose
Help a user understand which stores they have, create another store, follow its setup progress, open a ready store, and safely delete a store when needed.

### Design principles
- Clear status before decoration
- One obvious primary action: “Create store”
- Store identity and URL are easy to scan
- Provisioning progress is understandable
- Destructive actions require deliberate confirmation
- Dense operational information stays readable
- The dashboard feels related to the storefront without copying the storefront's editorial layout everywhere

## 3. Shared visual theme

Keep the visual relationship with the storefront:
- Warm ivory backgrounds
- Forest-green primary actions
- Soft sage status-support surfaces
- Sand-toned secondary panels
- Charcoal text and muted grey metadata
- Consistent typography, spacing, iconography, borders, and focus states

Use a more restrained, utility-oriented dashboard layout. Product photography should not dominate this interface; store icons, compact previews, status indicators, and readable tables are more useful.

### Suggested tokens

| Token | Value | Usage |
|---|---|---|
| Warm ivory | `#F8F6F0` | Overall background |
| Forest green | `#173D35` | Primary buttons, selected navigation |
| Soft sage | `#A6B7A0` | Subtle positive/status surfaces |
| Sand | `#E8DCC9` | Secondary surfaces |
| Charcoal | `#252A27` | Primary text |
| Muted grey | `#737873` | Supporting text |
| White | `#FFFFFF` | Panels and tables |

Status colours should be distinct and paired with text or icons; never communicate status by colour alone.

## 4. Dashboard information architecture

Primary navigation:
- Overview
- Stores
- Activity / Events, if useful and supported
- Settings

User menu:
- Profile
- Sign out

Admin-only navigation may include team or platform settings if those are present in the implemented product. Do not add decorative navigation items that lead nowhere.

## 5. Stores overview page

### Page header
- Title: **Your stores**
- Supporting text: *Create and manage separate store environments from one place.*
- Primary button: **Create store**

### Summary area
Optional compact summary cards:
- Total stores
- Ready
- Provisioning
- Needs attention

Only show totals that can be computed from actual store records.

### Store list
Each row or card should show:
- Store name
- Status: Provisioning, Ready, or Failed
- Store URL when available
- Created time
- Primary contextual action

Suggested actions:
- **Provisioning:** View progress
- **Ready:** Open store; View details
- **Failed:** View reason; Retry if retry is supported
- **All states:** Delete, behind a confirmation flow

Use a table on desktop when several stores are expected. Use responsive cards on narrow screens.

### Empty state
Headline: **Create your first store**
Supporting text: *Each store gets its own storefront and can be managed independently.*
Action: **Create store**

Avoid fake sample stores in a real account. If the demo needs sample data, label it clearly as demo data.

## 6. Create-store flow

Use a focused, short form or stepper. Ask only for information the actual product supports.

Potential fields:
- Store display name
- Optional short identifier, if the product allows the user to choose one
- Optional store description or visual preset, only if these are real supported choices

Show the resulting URL or explain that it will be assigned during creation. Validate names and identifiers clearly before submission.

After creation, move to a progress view rather than leaving the user uncertain about whether anything happened.

## 7. Provisioning progress view

Make the status visible at the top:
- **Provisioning** — setup is in progress
- **Ready** — the store can be opened
- **Failed** — setup did not complete

Use a clear progress timeline, with only steps that the actual system can report. Possible presentation labels include:
1. Preparing store
2. Setting up store services
3. Configuring access
4. Registering store tools
5. Ready to open

These are UI labels for the bonus flow, not a claim about exact internal implementation. If only an overall status is available, show an indeterminate progress state rather than inventing step-level progress.

For failure:
- Use a clear “Store setup failed” heading
- Display the available reason in plain language
- Offer retry only if supported
- Keep the store record and its current state understandable

## 8. Store details page

Show:
- Store name and current status
- Store URL and a copy/open action
- Created time
- A concise store summary
- Relevant actions based on the store's current state

For a ready store, make **Open store** the primary action. Keep destructive actions visually separate from normal navigation.

If store-specific MCP tools are surfaced in the dashboard, present them as a clearly labelled status or connection section, without overwhelming the store-management page.

## 9. Delete-store confirmation

Deletion is destructive and should not be a one-click action from the main list.

Confirmation dialog:
- Title: **Delete this store?**
- Identify the exact store by name
- Explain that deletion removes that store from the user's managed stores
- State the data consequences accurately based on the product's actual retention and deletion behaviour
- Require an explicit confirmation action

Use a clear destructive button label such as **Delete store** and a secondary **Cancel** action. Do not claim that backups, data, or volumes are deleted unless the system actually guarantees it.

## 10. Visual relationship between storefront and dashboard

The customer storefront and the provisioning dashboard serve different jobs:

### Storefront
- Editorial and image-led
- Product discovery, categories, brands, and shopping
- Larger imagery and more expressive storytelling
- Consumer-friendly language

### Provisioning dashboard
- Task-oriented and information-dense
- Store list, status, URLs, progress, and actions
- Smaller visual elements and compact navigation
- Clear operational language and careful destructive-action patterns

They should share colour tokens, typography, icon style, spacing logic, and a restrained use of green. They should not be forced into identical layouts.

## 11. V2 UI scope

In scope for the bonus:
- Dashboard store list
- Create-store entry point and form
- Provisioning, ready, and failed states
- Store details and open-store action
- Delete confirmation
- Clear visual status and responsive layouts
- A consistent visual connection to the storefront theme

Not implied by this design:
- Independent seller accounts or a vendor marketplace
- Seller commissions or payouts
- A public directory of all provisioned stores
- A full analytics suite
- Unimplemented controls or fake progress indicators

## 12. UI acceptance checklist

- [ ] A user can quickly identify all their stores and each store's status.
- [ ] The “Create store” action is easy to find.
- [ ] Provisioning, ready, and failed states are visually and textually distinct.
- [ ] A ready store has an obvious way to open its storefront.
- [ ] Store URLs are readable and easy to copy.
- [ ] Deletion requires confirmation and identifies the target store.
- [ ] The dashboard works on desktop and mobile widths.
- [ ] Keyboard focus, labels, contrast, and error feedback are clear.
- [ ] Progress steps and failure details are based on actual available state.
- [ ] The dashboard shares the storefront theme without sacrificing operational clarity.

## 13. Relationship to V1

V1 defines the customer-facing storefront identity and shopping experience.

This bonus V2 adds a dashboard that manages multiple separate instances of that storefront. Each created store can use the same storefront design system while having its own store identity and URL.

This is a multi-store hosting/provisioning experience—not a multi-seller marketplace.
