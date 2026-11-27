# DurableTorrent UI design

Reference: Anthropic's [`frontend-design` skill](https://github.com/anthropics/skills/tree/main/skills/frontend-design).

## Brief

**Subject.** A BitTorrent intake desk. The operator adds a torrent, watches a
swarm return pieces, and retrieves a verified file from R2.

**Audience.** Developers and operators who already understand info hashes,
trackers, piece sizes and object storage. They want signal, not a tutorial.

**Job.** Make the state of a transfer legible at a glance: what is verified,
what is missing, who is connected, what it will cost, and where the output is.

## Design plan

### Color

| Token | Value | Role |
|---|---|---|
| `--paper` | `#e4e9e4` | cool graph-paper field, not warm cream |
| `--ink` | `#102b2f` | deep petrol for type and rules |
| `--ink-2` | `#48615e` | secondary copy |
| `--signal` | `#dfa33a` | verified pieces and live status |
| `--verified` | `#2f7d64` | completed state |
| `--dark` | `#0b2024` | the piece map's instrument panel |
| `--danger` | `#a33a31` | errors and destructive actions |

The map is the only dark surface. Everything else sits directly on paper.

### Type

- **Display and numerals:** Iowan Old Style, with Palatino/Georgia fallbacks.
- **Body and controls:** Avenir Next, with Segoe UI/system-ui fallbacks.
- **Logs only:** SFMono/Consolas. Monospace is not used for labels.

One serif and one sans carry the page. The serif gives the tool an editorial,
instrument-like voice; the sans keeps forms and tables plain.

### Layout

A vertical step rail on the left for the workflow (start, watch, retrieve), and
a wide work area on the right. The piece map is the first thing in the work
area. Sections below it are separated by rules, not cards.

```
┌──────────────────────────────────────────────────────────────┐
│ DurableTorrent                                   API token  [save]│
├───────────────┬──────────────────────────────────────────────┤
│ 1 Start       │  transfer name                     ● status   │
│ 2 Watch       │  ┌────────────────────────────────────────┐  │
│ 3 Retrieve    │  │            piece map (dark)            │  │
│               │  └────────────────────────────────────────┘  │
│ Add a torrent │  verified | transferred | left                │
│ [ drop zone ] │  peers    | trackers    | stored              │
│ magnet        │  [pause] [refresh] [delete]                  │
│ trackers      │  files / trackers / estimated cost            │
│               │  R2 storage table                             │
│               │  activity log                                 │
└───────────────┴──────────────────────────────────────────────┘
```

Alignment is left throughout. Form controls are square; the primary action has
a single signal-colored bottom edge, the only decorative geometry on the page.

### Principles

- **One loud element.** The piece map owns the color and contrast. Stats,
  forms and tables stay quiet around it.
- **Structure is information.** The graph paper and the step rail describe a
  grid of pieces and a sequence of operations. They are not decoration.
- **Plain language.** "Start a transfer", "Pause transfer", "Download file".
  Sentence case everywhere.
- **No generated-page tells.** No warm cream plus terracotta, no near-black
  plus acid green, no identical rounded cards, no gradient washes, no
  all-caps eyebrow labels, no middle-dot meta strings.
- **Motion that answers an action.** The map gets a single slow scan while a
  transfer is active; it is disabled for `prefers-reduced-motion`.

## Piece map

The map is a canvas. Each cell is one piece. Missing pieces are a dark grid;
verified pieces fill with `--signal`. The canvas is redrawn from the hex
`verifiedBitmap` returned by `GET /api/torrents/:id?bits=1`, so it stays honest
for torrents with 4 pieces or 50,000. No per-cell DOM nodes.

## Accessibility

- Visible `:focus-visible` outline.
- Status text in an `aria-live` region.
- Errors use `role="alert"`.
- The canvas has a label and the readout repeats the numbers in text.
- Redraw and motion respect reduced-motion preferences.
- Color is never the only indicator: counts and status words are always shown.
