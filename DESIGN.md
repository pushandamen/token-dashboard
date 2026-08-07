---
version: 1
name: token-meter-design
description: >
  A near-black instrument panel where the period picker is the largest type on the page and the
  data has no colour at all — single-series charts are white strokes with a gradient fading to
  nothing, and hue appears in exactly one chart, the by-model ring, because that one has series
  to tell apart. Numbers carry the hierarchy: a metric's name and its figure sit on one line at
  the same size, one weight apart, with the trend filling the rest of the cell and no border
  around any of it. Nothing is boxed unless the box carries information.
---

# DESIGN.md — Token Meter

## 0. The brief — a gate, not a preamble

| Field | Value |
|---|---|
| **Subject** | A local meter for what Claude Code costs you, reading the transcripts on your own disk. |
| **Audience** | Claude Code users who suspect they are spending more than they think, and want the figure with its workings shown. |
| **The page's one job** | Say what the work cost, then let any part of that number be opened. |
| **Signature** | The period picker *is* the page title, at 30px, with every figure below it subordinate — and the cost figure set larger than the token counts, because money and volume are not peers. |
| **Reference** | `midday.ai` (dashboard, open source) + `adaline.ai` — extracted live, not from the library. |

**Check 1 — reference named and specific.** Passes, with a caveat the skill calls for: the Reference
here is two live URLs rather than an entry in `~/.claude/design-md/`. Midday's dashboard is open
source, so its tokens below are quoted from `packages/ui/src/globals.css` rather than inferred.
Adaline's marketing site was extracted at 1440×900 (785 elements, 187 declared custom properties).

**Check 2 — the signature is unstealable.** It half-fails, and that is the gate working. "The period
picker is the page title" is *Adaline's* move, borrowed deliberately: this is an acknowledged
reproduction, not an original identity. What does survive the competitor-swap is the pairing —
picker-as-title **plus** money outranking volume, which Adaline does not do because its metrics are
peers and Token Meter's are not. Recording this explicitly rather than quietly waiving it.

**What could not be reached.** Mobbin surfaced both apps' *logged-in dashboards*. Adaline's is behind
auth, so its dark palette is not in this file at all — every Adaline value here is from its light
marketing site, and the dark ramp comes from Midday.

## 1. Atmosphere dials

```yaml
density:  8   # cockpit-dense — 200-row tables, six metrics above the fold
variance: 3   # symmetric; a data grid that shifts alignment is a data grid you misread
motion:   3   # near-static. It refreshes every 30s while being read, so motion must not draw the eye
```

Density 8 would normally force monospace numerals. It does not here: Inter's `tnum` gives the
column-stable digits that rule is actually protecting, without a second family. See §3.

## 2. Tokens

```yaml
colors:
  # dark is the primary theme; light values in parentheses
  canvas:        "#0d0d0d"  # (#ffffff)  @declared midday --background 0 0% 5% / 0 0% 100%
  surface:       "#121212"  # (#ffffff)  @declared midday --card 0 0% 7%
  surface-sunk:  "#1c1c1c"  # (#f7f6f3)  @declared midday --muted / --card 45 18% 96%
  hairline:      "#1c1c1c"  # (#dbdad7)  @declared midday --border 0 0% 11% / 45 5% 85%
  hairline-firm: "#333333"  # (#c4c3bf)  @declared midday --chart-reference-line-stroke
  ink:           "#fafafa"  # (#121212)  @declared midday --foreground 0 0% 98% / 0 0% 7%
  ink-muted:     "#999999"  # (#3f3f3f)  @declared midday --chart-forecast-line
  ink-faint:     "#8a8a8a"  # (#616161)  @adjusted — see note
  data:          "#ffffff"  # (#000000)  @declared midday --chart-actual-line / --chart-bar-fill
  data-2:        "#999999"  # (#707070)  @declared midday --chart-line-secondary
  primary:       "#6dbe8b"  # (#256f46)  @guess — Midday's --accent is #1c1c1c, a neutral
  on-primary:    "#06120b"  # (#ffffff)  @guess
  negative:      "#ff383b"  # (#c4443c)  @declared midday --destructive 359 100% 61% (light @adjusted)
  positive:      "#6dbe8b"  # (#2a7e4f)  @guess — no counterpart in a monochrome system

# ink-faint @adjusted, not @declared: Midday's --muted-foreground #616161 measures
# 2.75:1 on its own --muted surface. Midday only ever puts it on axis labels; this app
# puts table headers and every explainer in it, so it is lightened to the first value
# clearing 4.5:1 (4.94:1 measured). The reference value would have been a WCAG failure.

typography:
  # Inter is a SUBSTITUTE and every line here is tagged accordingly. The real faces:
  # Midday runs Hedvig Letters Sans/Serif, Adaline runs Akkurat + Instrument Serif +
  # Newsreader. Hedvig ships ONE weight (a 400..700 Google Fonts request 400s) and has
  # no `tnum`; Akkurat is commercial. Neither is usable in a dashboard that separates
  # label from figure by weight and redraws numbers every 30 seconds.
  display:               # the period picker — the page's title
    fontFamily: "Inter"       # @guess (substitute; reference is Akkurat)
    fontSize: 30px            # @computed adaline 30px heading
    fontWeight: 400           # @computed adaline
    lineHeight: 1.08          # @computed adaline 1.16
    letterSpacing: -0.02em    # @computed adaline 30px / -0.6px
  heading:               # the lead metric's figure
    fontFamily: "Inter"       # @guess
    fontSize: 25px            # @guess — Token Meter's own step; no reference equivalent
    fontWeight: 400           # @computed adaline
    lineHeight: 1.1           # @guess
    letterSpacing: -0.032em   # @guess
  body:
    fontFamily: "Inter"       # @guess (substitute; reference is Hedvig Letters Sans)
    fontSize: 13px            # @guess — midday sets 14px; 13 fits the density
    fontWeight: 400           # @declared midday --font-weight-normal
    lineHeight: 1.5           # @computed midday 1.43 / adaline 1.44–1.5
    letterSpacing: 0em        # @computed midday body ls 0
  caption:               # axis labels, table headers, explainers
    fontFamily: "Inter"       # @guess
    fontSize: 11px            # @guess
    fontWeight: 400           # @computed
    lineHeight: 1.45          # @guess
    letterSpacing: 0em        # @computed

radius:
  sm: 4px      # @computed adaline (17 uses)
  md: 8px      # @declared midday --radius 0.5rem; adaline's most-used is 10px
  lg: 12px     # @declared adaline --radius-xl 0.75rem
  pill: 9999px # @computed midday (189 uses)

motion:
  state:  "150ms cubic-bezier(0.4, 0, 0.2, 1)"    # @computed midday — 236 of its transitions
  enter:  "240ms cubic-bezier(0.32, 0.72, 0, 1)"  # @computed adaline — its signature curve
  # reduced-motion collapses both to 0.01ms globally

spacing:
  # @guess unless noted — the template ships these as literals and tagging them
  # @computed would claim they came off the page when they did not.
  cell-gap:  "30px 42px"   # @guess — the metric grid's rhythm
  section:   38px          # @guess (adaline declares --space-section 6rem, for a marketing page)
  base:      4px           # @declared adaline --spacing 0.25rem
```

## 3. Rules that are not tokens

1. **No box unless the box is information.** Borders survive on table rows, the drill-down overlay
   and the sidebar seam. Numbers never get one.
2. **Hue appears in exactly one chart.** Single-series charts are `data`. `--cat-1..6` exist only
   for the by-model ring, and `--cat-1` is deliberately *not* `data` — a black first slice beside
   five coloured ones reads as a gap in the ring.
3. **Every changing number sets `tnum`.** The mono stack is for paths and code only, where it
   means "literal string", not "number".
4. **Three type steps, not two.** Picker 30px → lead figure 25px → cells 15px. Money outranks
   volume; Adaline weights its cells equally because its metrics are genuinely peers.
5. **A live update never moves what is being read.** While an overlay is open or a field has
   focus, the refresh defers and the pill reads "new data".
6. **Contrast is verified against the surface, not the canvas.** Every text/background pair clears
   4.5:1 on `surface-sunk`, the worst case in both themes. Measured off rendered pixels across all
   8 routes × 2 themes × 390px — currently 0 failures.
