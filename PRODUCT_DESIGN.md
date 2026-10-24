# Schedora product design specification
Version 1.0 · 24 October 2026 · Approved identity with proposed experience details

## Brand architecture
Schedora is the suite brand. Product names are Meet, Forms and Flow, each with a smaller “by Schedora” endorsement. Keep each product recognizable through its own symbol, palette and task-focused interface.

| Product | Approved symbol | Color family | Asset |
| --- | --- | --- | --- |
| Schedora | Ribbon S combining all three colors | Green, violet, amber | logo-schedora.png |
| Meet | Calendar and clock | Green | logo-meet.png |
| Forms | Three stacked fields | Violet | logo-forms.png |
| Flow | Connected node path | Amber | logo-flow.png |

These four transparent PNG files are the current implementation assets. Preserve artwork and aspect ratio; never show the full four-logo board as an individual logo. Existing raster output may need edge cleanup and professional vector masters before print use. Do not silently redesign it.

## Logo placement and layout
- Current compact symbol footprint: 28 × 28 CSS pixels with 20-pixel product wordmark. Endorsement: 10 pixels. Preserve the directly constrained image dimensions so missing styles cannot expose full intrinsic size.
- Place symbol and name side by side, vertically centered; reserve at least 8 pixels between them.
- Use each product's own logo in its header; use Schedora for suite, account and billing.
- Align desktop navigation and logo to the content container. Stack navigation below brand/theme controls on narrow screens.
- Keep card headings aligned, with equal logo footprints and consistent spacing.
- Shared content width: approximately 1060 pixels with responsive side gutters. No absolute positioning of the overall page shell.

## Palette and themes
The actual logo image colors are approved artwork and must remain unchanged. Interface tokens are separate and may be adjusted for contrast.

| UI role | Light | Dark |
| --- | --- | --- |
| Canvas | #F6F7F2 | #101D18 |
| Surface | #FFFFFF | #192B23 |
| Text | #182E28 | #EDF5ED |
| Secondary text | #53675E | #B3C8BA |
| Meet accent | #225C43 | #A6D5A8 |
| Forms accent | #6541A5 | #D4B9FF |
| Flow accent | #9A461D | #FFC49E |

Default to system preference; offer System, Light and Dark choices. Current preference is local to each origin. Do not recolor approved logo pixels for dark mode. Keep symbols readable through placement and surrounding surface.

## Typography and components
Use system sans-serif, readable body size around 16 pixels, restrained heading scale and generous line height. Round inputs, buttons and cards consistently. Use semantic headings and descriptive labels.
Primary buttons describe the next action: “Choose a time”, “Confirm appointment”, “Publish form” or “Enable flow”. Use one dominant call to action per screen. Preview actions explicitly say Preview or Simulate.

Required shared components: product header, product switcher, theme control, primary/secondary buttons, labeled inputs, inline validation, status/error region, empty state, loading state, consent controls, legal footer and custom 404.

## Suite homepage
Explain the family in one sentence. Main CTA opens Meet. Three product cards show their distinct symbols, purpose and availability. Never imply that local demos are connected production services.

## Meet experience
1. Host setup: event details → availability/timezone → calendar connection → publish link.
2. Public booking: event summary → date → available times → invitee details → server confirmation.
3. Confirmation: appointment reference, explicit date/time/timezone, location and cancellation/reschedule actions.
4. Host workspace: upcoming appointments, event types, availability and integrations.

Keep the event summary visible beside the picker on desktop and above it on mobile. Visually distinguish selected dates/slots, disabled slots and keyboard focus. A timezone change clears or recomputes selection before proceeding.

States: loading availability; no times; invalid fields; time no longer available; booking pending; confirmed; email pending/failed; canceled; expired management link. Offer a clear next action in every recoverable state.

## Forms experience
Builder: field list and settings beside a preview on desktop; a clear edit/preview switch on mobile.
Public form: title, context, visible required labels, accessible field errors and a single submit action.
Response inbox: submission timestamp, permitted field values, empty state and export controls.
Publishing and collecting responses remain separate from demo preview.

## Flow experience
Start with a readable vertical sequence: trigger → action → run result. Show connected services and whether the workflow is draft, enabled or paused.
Use a separate Simulate action that cannot send messages. Run history shows queued, running, succeeded, retrying and failed states. Retry controls require clear effects and duplicate prevention.

## Shared account and billing
Use Schedora branding and an explicit workspace selector. Present product access and Suite access in a comparison without invented prices. Explain pending, active, canceled and failed-payment status. Never rely on hidden navigation as authorization.

## Accessibility and responsive behavior
Use keyboard navigation, semantic controls, focus return after consent dismissal, and text status announcements. Decorative symbols have empty alt text because adjacent text identifies the product; standalone brand links need an accessible name.
Target at least 4.5:1 contrast for normal text and 3:1 for large text and essential UI boundaries. Status and selection must not depend on color alone.
Test 320–1280-pixel layouts, zoom, long labels, slow image loading, blocked storage, touch targets, and both themes. Avoid horizontal scrolling of the page.

## Content and trust
Use calm, direct language. Show what is saved, sent or simulated. Keep privacy, terms and cookie preferences accessible. Do not claim a booking, message or payment succeeded before the corresponding server operation is durable.

## Design implementation next steps
Consolidate legacy logo and sprite CSS into one brand component and stylesheet; remove superseded rules after checking consumers. The current app contains layered scripts/styles and needs browser verification. Maintain the approved appearance while simplifying ownership. Prepare vector logo masters and a raster social preview before marketing launch.

## Design acceptance checklist
- Four separate logo assets; no stretched or oversized intrinsic images.
- Correct product identity and endorsement on each route and subdomain.
- One clear primary action per task screen.
- Complete loading, error, empty and success states.
- Mobile, keyboard, contrast and theme checks recorded before release.
- All real-data operations visually distinct from previews.

