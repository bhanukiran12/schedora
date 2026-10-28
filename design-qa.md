# Authentication design QA — 2026-10-28

final result: passed

## Source and scope
User-selected screenshot and https://schedora.in/start. Reused the actual existing `/start` layout, Inter font, dark panel colour (#172c22), logos and product marks. The production reference was inspected; an unchanged local `/start` capture was used for stable desktop comparison. The selected page is a demo; the implementation is real auth, so copy, password, Google controls and legal notices intentionally differ.

## Comparison evidence
C:/Users/Nxtwave/Documents/ChatGPT/schedora/outputs/auth-redesign-2026-10-28/
- reference-start-desktop.png (1876 x 884)
- suite-signup-desktop.png (1861 x 877 captured content; nominal 1876 x 884 viewport, browser scrollbar/capture rounding)
- comparison-aligned.png (combined source and implementation at native scale, no stretching)
- forms-login-desktop.png
- forms-login-phone.png

## Required fidelity surfaces
- Typography: bundled Inter; original brand lockup, 48px desktop left headline and 34px auth heading. Smaller readable mobile headings.
- Spacing/layout: original .8fr/1.35fr columns and 432px form column; full-height left panel. Signup includes required real-auth controls and scrolls vertically when needed. Mobile compacts the brand panel and keeps controls in one column.
- Colours/tokens: selected dark green and white composition retained. Product primary controls retain their existing green/purple/orange identity.
- Image quality: original supplied source logos/marks and official Google icon; no substitute generated artwork.
- Copy/content: only the selected product appears for individual entry; Suite shows all three. No demo/sample-account language in real auth. Existing backend authentication remains connected.

## Functional and accessibility review
Responsive browser tests check login errors, signup, product context, return paths, sign-in/out, existing account and persisted setup journeys. Fields keep labels/autocomplete; errors use existing announced status handling. Manual keyboard-control check confirmed consent settings returns focus to the visible auth control. Responsive screenshots and automated overflow checks cover phone/tablet/desktop; no real screen-reader or human conversion study was performed. Google visual/URL checks use dummy local configuration only.

No unresolved P0/P1/P2 visual issues. Intentional difference: real signup has more controls than the demo and therefore requires vertical scrolling on smaller displays. Existing small dark-green Meet mark on the dark panel matches the source asset; optional future brand contrast polish is P3.


---

## Previous release QA (historical)

# Design QA — 24 October 2026

**Final result: passed** for the implemented Figma-inspired frontend scope at the observed browser viewport. Mobile device and 1440px viewport captures remain verification gaps, not claimed test results.

## Source and evidence

- Source: Figma `tF7dXunSUiPZw5m8atVGpn`, ten homepage, onboarding and workspace frames. Read high-fidelity design context for each frame before implementation. Figma node IDs changed during the session; the visual reference remains the captured baseline.
- Source workspace: `C:/Users/Nxtwave/Documents/ChatGPT/schedora/outputs/design/figma-workspace.png`, 1440 × 1137 pixels.
- Source homepage: `C:/Users/Nxtwave/Documents/ChatGPT/schedora/outputs/design/figma-home.png`, 734 × 3000 pixels, scaled from 1440 × 5890.
- Initial full workspace implementation: `C:/Users/Nxtwave/Documents/ChatGPT/schedora/outputs/design/workspace.png`, 926 × 2060 capture.
- Revised implementation: `C:/Users/Nxtwave/Documents/ChatGPT/schedora/outputs/design/workspace-final.png`, current viewport capture.
- Additional captures: `homepage.png`, `demo-meet.png`, `demo-forms.png`, `demo-flow.png`, `start-availability.png`, `demo-forms-edit-client-intake.png` in the same directory.
- Observed CSS viewport: 941 × 884; capture width excludes the native scrollbar. Source and implementation were opened together in one comparison input. The reference is wider, so columns and wrapping were assessed as responsive adaptations, not a pixel-identical comparison.

## Fidelity surfaces

- Typography: bundled licensed Inter variable font; source-inspired size/weight hierarchy, restrained display headings, compact data text. Browser confirmed Inter is active.
- Layout: 228px desktop sidebar, 76px workspace application bar, bordered white panels, 24px gaps and product-specific metrics/actions. At the observed narrower viewport, metrics and right panels reflow. Mobile breakpoints and touch targets are implemented; actual narrow-device captures were not available.
- Colour: source green #176b45, violet #6941d9, green canvas/tints and orange product identity. Muted text, form boundaries and orange text are deliberately darker than the source for readability. Existing theme support is retained.
- Assets: downloaded source PNG marks/SVG icons; no screenshot used as a runtime asset, no temporary Figma runtime URLs, no missing loaded images in the inspected screens. Logos retain their source aspect ratio. Inter license bundled.
- Copy: Book renamed Meet as already approved. Sample KPIs are derived from actual local preview records; no invented live usage metrics. Signup is explicitly a local introduction without credential collection; real signup stays on the existing account route. Calendar, mail and automation concepts are labelled simulations.

## Comparison history

1. Initial combined source/implementation review identified a sidebar stretching with long content and overly tall booking rows at the narrower desktop width (P2). Fixed sidebar with sticky 100vh scrolling and restored compact three-column booking rows at 761–1000px.
2. Revised capture confirms sticky navigation, readable rows, active Inter, zero horizontal document overflow and zero broken loaded images. The sidebar itself can scroll when its contents exceed the viewport, keeping utilities accessible.
3. Focused inspection covered logo geometry, application navigation, form/editor fields, booking rows and preview action states. Intentional differences: demo banner, derived counts, existing live navigation, source-inspired rather than pixel-identical responsive composition.

## Functional checks

- 22 workspace/onboarding routes opened without a page error.
- Complete local onboarding journey reached sharing.
- Event creation saved and persisted; question creation saved in the builder.
- Classic form submission reached confirmation and response inbox; related local workflow created a task.
- Booking date/time selection reached local confirmation.
- Workflow simulation created a local task; failed-run review/retry reduced the unresolved failures.
- Six main screens: no horizontal overflow or broken loaded images at the observed viewport; no browser error logs on the inspected demo screens.
- Five new model tests passed, including conflicts/buffers, invalid hours, storage recovery, workflow simulation and CSV formula safety. Full suite: 81 passed, one optional PostgreSQL test skipped. Syntax check: 87 files.

No actionable P0/P1/P2 issue remained in the inspected scope. Wider/narrower device captures and real backend integration are follow-up verification work. This is not an A–Z production-readiness claim.
