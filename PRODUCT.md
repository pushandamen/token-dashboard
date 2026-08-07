# Token Meter — Product Context

## Register

**product** — design serves the product. This is a local dashboard: an app shell with a
sidebar, eight routes, data tables, drill-down overlays and a settings page. There is no
marketing surface, no hero, no landing page. Nothing here is trying to sell the tool.

## Users & Purpose

**Who.** Claude Code users who want to know what their usage actually costs. Primarily the
author, running it on `127.0.0.1`; secondarily anyone who clones the fork and runs it against
their own `~/.claude/projects`. It is intended to be shared properly, which means a stranger
with an empty database has to be able to open it and understand what they are looking at.

**The job.** Answer three questions, in this order:

1. Was this worth it? → the cost figure, against what the plan costs.
2. Where did it go? → by project, by model, by day, by tool, by skill.
3. What should I do about it? → the "Worth fixing" list and the Savings tab.

**Context of use.** Sat next to a terminal, glanced at between tasks, on a desktop display.
Read far more often than interacted with. It refreshes itself every 30 seconds, so it is
frequently *looked at* while something else is happening — which is why an update must never
yank content out from under a read.

**Primary task per screen.** Overview: read one number and see whether it is rising. Activity:
find the expensive thing. Savings: understand why the number is lower than the sticker price.
Settings: correct a price or change the billing mode.

## Brand & Personality

**Instrument, quiet, exact.** It is a meter. A meter does not have opinions, does not
celebrate, and does not decorate. Three words: *measured, plain, unhurried.*

The tone in copy is plain and specific, and it says what a number excludes as readily as what
it includes. Several explanations exist purely to admit a limit ("there is no *remaining*
figure here on purpose — your cap is never written to disk"). That candour is the personality.

## Anti-references

Things this must not become, each rejected for a reason already lived through:

- **The SaaS KPI grid.** Seven identically-sized cards with icon, label and number. Ranking
  nothing is what the previous design did, and it is why it was hard to read.
- **The hero-metric template.** Big number, small label, supporting stats, gradient accent.
- **Boxes as the default container.** Borders are information, not decoration. They survive on
  table rows, the overlay and the sidebar seam. Numbers do not get boxes.
- **Colour as decoration.** One data hue. Categorical colours appear only where more than one
  series shares a chart. No two series in one legend may share a hex.
- **Celebration.** No confetti, no "great job", no green upward arrow implying spending more is
  an achievement. On a cost dashboard, up is usually bad.

## Strategic design principles

1. **One hero number per page**, at a size nothing competes with. Everything else is supporting
   evidence. Money outranks volume: the cost figure is set larger than token counts, because
   `$8,821` and `215.7M` are not peers.
2. **Never invent a number.** No "remaining" percentage, because the cap is not on disk. No
   prorated plan price. No priced rate metric. Where a figure cannot be derived honestly, the
   page says so instead.
3. **A figure that can be opened, opens.** Every headline number has a drill-down that
   reconciles with it. `tools/audit_data.py` enforces that arithmetic.
4. **Live updates defer to the reader.** While an overlay is open or a field has focus, a scan
   waits and the pill says "new data". Yanking a breakdown out mid-read is worse than a few
   seconds of stale.
5. **Fully local.** No telemetry, no CDN, no network call for user data. The typeface is
   bundled for this reason.
6. **Two projects must never render as one name.** Identical labels with different values make
   every other figure on the page look approximate.

## Accessibility

Bar for this project: **contrast and keyboard.** Every text/background pair meets 4.5:1 (3:1
for large text), and everything actionable is reachable and operable from the keyboard with a
visible focus state. Full screen-reader semantics and live-region announcements are explicitly
out of scope for now, as is i18n — the tool is English-only and single-user per install.

Reduced motion is honoured globally.

## Reference

The visual system is derived from two shipped dashboards: **Adaline**'s project view and
**Midday**'s financial overview. The reasoning behind every borrowed decision, and the one
deliberate departure, is documented in the header comment of `web/style.css`.
