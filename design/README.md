# Fluent Code design source

[`pen/fluent-code.pen`](pen/fluent-code.pen) is the editable source of truth. It contains the twelve current product artboards. `previews/` contains a PNG export for every artboard; filenames use Pen frame IDs so exports remain traceable to their editable source.

| Screen | Pen ID | Preview |
| --- | --- | --- |
| 1 — Launch Splash | `pRRkh` | `previews/pRRkh.png` |
| 2 — Provider Auth | `VjRP6` | `previews/VjRP6.png` |
| 3 — Active Session | `RkZKx` | `previews/RkZKx.png` |
| 4 — Session List | `rYrrq` | `previews/rYrrq.png` |
| 5 — Remote Server | `AFx7k` | `previews/AFx7k.png` |
| 6 — Parallel Orchestration | `VdcJ5` | `previews/VdcJ5.png` |
| 7 — Design Workspace | `L4V1al` | `previews/L4V1al.png` |
| 8 — Preview & Visual Check | `NKnBc` | `previews/NKnBc.png` |
| 9 — New Session | `q8LpEE` | `previews/q8LpEE.png` |
| 10 — Claude Code Credentials | `htKKf` | `previews/htKKf.png` |
| 11 — Usage Observatory | `hNqHb` | `previews/hNqHb.png` |
| 12 — Themes & Appearance | `qLHqC` | `previews/qLHqC.png` |
| 13 — Premium Shell & Theme Contract | `Y0000` | `previews/FCshell13.png` |

## Implementation notes

- Usage interfaces are graph-first: use traces, sparklines, token flow, model legends, precise mono values, and compact tables. Reserve bars for capacity limits such as context, disk, and monthly budget.
- Token totals must make main-agent and subagent consumption explicit. Show prompt, completion, cache, burn rate, quota/reset state, and cost separately where space allows.
- Themes have a strict two-level model: first choose appearance mode (`System`, `Light`, or `Dark`), then choose a theme filtered to that mode. A light theme and a dark theme are independent complete bundles; never mix them into one gallery.
- In System mode, persist independent light and dark selections, e.g. `dark → Fluent Dark`, `light → Fluent Light`. Each bundle owns semantic colors, terminal ANSI colors, syntax colors, font size, and density.
- Fluent Dark is the default. Every Fluent theme retains the exact mark and reserves Coral for actions, active selection, warnings, and anomalies.
- Screen 13 is the shared implementation reference for all shipped routes, including Spend, Source
  Control, and Catalog which do not have standalone product artboards. It defines the persistent
  desktop rail, active-work-plane hierarchy, and the semantic roles that must remain complete in
  Fluent Dark, Fluent Light, and high-contrast modes. It supplements rather than replaces screens
  1–12.
