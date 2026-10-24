# Schedora brand foundation

Promise: Make time for what matters.

## Locked direction

Approved product names: Meet, Forms, Flow. Each has its own symbol and a smaller “by Schedora” endorsement. Meet keeps the green calendar/clock, Forms the violet stacked fields, Flow the amber connected path. The master Schedora ribbon combines all three colors.

The site uses the exact approved image artwork in brand-board.png, displayed through four crop windows. Symbols, lettering, endorsement text and colors come directly from the supplied artwork. Preserve the ivory background and proportions; do not substitute hand-drawn SVG interpretations. This raster source is not a vector master.

Canonical product paths: /meet, /forms, /flow. Legacy /book and /form redirect to /meet and /forms. Production host routing supports meet.schedora.in, forms.schedora.in, flow.schedora.in; book.schedora.in is a compatibility host. DNS and certificates are not provisioned.

Forms and Flow are working products: forms are saved, published and collect responses; flows run real email and task actions. See README.md for scope.

Voice: calm, clear, welcoming. Use short action labels and plain language. Keep Book, Form, and Flow under the Schedora name.

## Palette

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | #F6F7F2 | #101D18 |
| Surface | #FFFFFF | #192B23 |
| Text | #182E28 | #EDF5ED |
| Secondary text | #53675E | #B3C8BA |
| Book / primary | #225C43 | #A6D5A8 |
| Form | #6541A5 | #D4B9FF |
| Flow | #9A461D | #FFC49E |

Colors are centralized as CSS custom properties in frontend/app.css. Keep product names visible alongside colors. Product accent variables inherit the current theme. Primary button text uses the on-primary token.

## Theme and interface

Default to the device theme. The header control cycles System → Light → Dark and remembers the choice in this browser where storage is available. Layout uses system fonts, rounded cards, generous spacing, visible keyboard focus, responsive product cards, and reduced-motion support.

The interface uses the four approved transparent logo files (frontend/logo-*.png) at a fixed 28 px footprint. Vector masters, a raster social image and a marketing asset pack remain future brand work. No external fonts or brand assets are required.
