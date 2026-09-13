# Premium desktop UI redesign

## Objective

Make Fluent Code feel like a considered desktop control surface for running coding agents: fast to
scan, visually calm at high information density, and consistent across every shipped route and
every supported appearance bundle. This is an implementation-and-design pass, not a new product
surface.

## Evidence

- The editable source is `design/pen/fluent-code.pen`; it currently holds twelve artboards and
  exports for each. The running frontend has additional spend, source-control, and catalog routes
  that need the same visual system.
- The existing designs have useful dense-terminal ingredients, but the application currently uses
  a broad top bar and generic card grid. It does not preserve the active work plane as the visual
  lead across routes.
- T3 Code's public source centralises visual geometry and semantic colours in CSS variables, and
  its installed desktop UI uses a narrow persistent rail, restrained borders, quiet empty space,
  and status colour sparingly. Fluent adopts those *interaction principles*, not T3's code, brand,
  or layouts. Sources: [T3 Code repository](https://github.com/pingdotgg/t3code),
  [its tokenised stylesheet](https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/web/src/index.css).
- The written Fluent brand contract remains binding: IBM Plex Mono-forward UI, Archivo display
  type, exact mark/palette, 12px cards, 8px controls, and Coral reserved for actions and warnings.

## Design decisions

1. Use a three-region desktop shell: a 220px persistent rail, a single scrolling work plane, and
   route-level coordination panels within the work plane. The rail replaces the page-wide primary
   nav; it makes the current tool and project target legible without taking height from terminals.
2. Centralise surface, border, focus, elevation, spacing, and data-viz tokens. Every mode and
   bundle receives the same semantic roles, so switching theme never leaves a light card or focus
   colour behind on a dark route.
3. Make hierarchy primarily through spatial regions and type, not decoration. Page titles use
   Archivo; table, terminal, provider, metric, and metadata values stay compact and tabular.
4. Treat cards as contained regions rather than a default layout. A card gets a quiet elevated
   edge; selectable rows and live activity get the interaction treatment. Coral never becomes a
   general chart or provider colour.
5. Retain the existing 12 artboards and extend the Pen document with a reusable app-shell/
   theme-contract board. It shows the concrete design rules that apply to the extra shipped
   routes, without pretending they are new product screens.

## Execution

1. Build the rail and responsive shell in `app/src/main.ts` and `app/styles.css`.
2. Replace the ad hoc colour primitives with complete semantic tokens for Fluent Dark, Fluent
   Light, Midnight, Ember, Nord, Paper, and both high-contrast bundles.
3. Rework the shared controls, cards, tables, metric blocks, terminal frame, and responsive
   behaviour so every current route inherits the premium system.
4. Add the Pen design-contract frame and variables; preserve the twelve original artboards.
5. Export and inspect representative dark, light, and high-contrast states; run frontend type
   checking and production build.

## Critique before execution

- A rail could make narrow screens cramped. The implementation collapses it into a horizontal,
  scrollable compact bar before content columns become too narrow.
- A fully manual restyle could produce a polished shell while leaving individual route density
  inconsistent. Shared `card`, `option-row`, `metrics`, `table`, and `toolbar` primitives are
  changed together and all routes are exercised through the build.
- Pencil's cloud API is unavailable (`fetch failed` even with the approved network path). The
  fallback is the installed Pen desktop editor plus direct editing of its documented JSON source;
  no separate local working copy becomes the source of truth.

## Completion record

Completed 2026-09-13.

- Added a compact, persistent workspace rail and strengthened the shared surface, focus, elevation,
  table, control, and responsive-shell styling.
- Added the source-of-truth Pen artboard `13 — Premium Shell & Theme Contract` and its exported
  preview at `design/previews/FCshell13.png`; updated the design index accordingly.
- Inspected the exported board in Pen and as a PNG at its native layout. The review covered the
  rail hierarchy, active-lane density, state contrast, and the dark, light, and high-contrast
  theme contract.

Verification completed:

- `pnpm check:frontend`
- `pnpm build:frontend`
- `pnpm test` — 200 passed, 0 failed, 0 cancelled (run with normal local IPC permission; the
  workspace sandbox blocks the Unix sockets used by the daemon fixture)
- `git diff --check`
