# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

**Token Meter** — a local dashboard for tracking Claude Code token usage, costs, and session history. Reads the JSONL transcripts Claude Code writes to `~/.claude/projects/` and turns them into per-prompt cost analytics, tool/file heatmaps, subagent attribution, cache analytics, project comparisons, and a rule-based tips engine.

Inspired by [phuryn/claude-usage](https://github.com/phuryn/claude-usage) but diverges in UI (vanilla JS + ECharts, hash router, SSE refresh) and scope (expensive-prompt drill-down, skills view, tips engine, streaming-snapshot dedup). See `docs/inspiration.md` for the original's feature set and known limitations.

**The name is a display string only.** The repo, folder, Python package (`token_dashboard/`), DB filename and the ADA HUD's `/tokens` route all still say `token-dashboard`, deliberately — renaming those means touching the `ada-hud` repo and migrating or rescanning the database. Don't half-do it.

## Status

Working codebase. 149 Python unit tests (`python3 -m unittest discover tests`). Runs on macOS, Windows, and Linux.

## UI structure

Three tabs and a gear: **Overview**, **Activity**, **Savings**, ⚙ Settings. Activity hosts five views (Sessions / Prompts / Projects / Skills / Tools) behind a segmented switch, and Tips folded into Overview as the "Worth fixing" card — a suggestion on its own tab is a suggestion nobody navigates to. `web/routes/view-*.js` export `view(el)` and render *into* Activity; only `overview`, `activity`, `savings`, `settings` and `session-detail` are real routes with a `default` export. Legacy hashes redirect via `ALIASES` in `app.js`; keep them.

**Design system: instrument panel** (the reference is Modal / Adaline / LangSmith — see the header comment in `web/style.css`). The rules that matter when adding anything:

- **One hero number per page.** Everything else is supporting evidence at a smaller size. Seven identically-sized KPI cards is what this replaced.
- **Colour means exactly one thing.** `--accent` is brand and interaction only and is never used for data; `--tok-*` identify a token series; `--pos`/`--neg` are direction; `--cat-1..6` are categorical and mean nothing but "a different one". Charts use `--cat-*`. They exist because `--accent` and `--tok-input` resolve to the same hex in dark, which put two identical colours in one donut legend.
- **Charts read their colours from CSS custom properties** via `charts.js`'s `theme()`. Never hardcode a hex in a chart — light and dark both break. A theme switch re-renders the route, which is what recolours them.
- **Every changing number is tabular monospace.** `.num`, `.stat-value`, `.hero-value` handle this.
- **Truncate chart category labels at the call site**, not with `axisLabel.width` — that fights `containLabel` and clips the first character.

**The hero is the cost; the plan multiple is its subtitle.** `heroModel()` leads with the dollar figure — it's what the page is a breakdown of, and every other number is a share of it — and adds *"85× your $100/mo Max plan"* underneath to say what that means on a subscription (same shape as ROAS). The multiple is dropped on `api` billing and on "all time", where there's no defensible denominator; if you add a range, make sure it has one. This was tried the other way round, with the multiple as the headline, and the dollars read as missing.

**Every tab updates live.** A route may export `live(root)` to patch its numbers in place (Overview does; charts go through `charts.patch()`, never `mount()`, or the entry animation restarts and the page flinches). Routes without one are re-mounted with the scroll position held. Updates *defer* — pill goes to "new data" — while an overlay is open or a field has focus, and land the moment either clears; yanking a breakdown out mid-read, or clobbering a half-typed label, is worse than a few seconds of stale.

**SSE fans out to every client.** `publish()` writes to one queue per subscriber. It used to be a single shared `EVENTS` queue, which whichever handler reached first would drain — so two tabs stole each other's events and one tab plus any other listener meant the tab silently stopped updating. Tests cover the fan-out and the unsubscribe-on-error path.

**The plan price is never prorated; the work is.** Dividing a $100/mo subscription across a 7- or 90-day window invents prices nobody pays ("$23.33 plan", "$300 plan") and reads as though the fee scales with the window. `heroModel()` scales the *work* to a monthly rate and leaves the fee at its real $100.

**Static assets are served `no-store`.** With no cache headers the browser applies its own heuristic and cheerfully serves a stale ES module after an edit — which presents as "the fix didn't work". Everything is local disk over loopback, so there is nothing to save by caching. Tested.

**Blur covers project names, not just prompts.** This vault has client work in it, so a screenshot leaking a client's directory name is the actual risk. `.blur-sensitive` goes on project names, tip titles and bodies (which carry absolute paths), and prompt text.

**Every drill-down is the shared overlay in `web/overlay.js`.** One implementation, so Overview and Savings cannot drift apart, and the breakdown gets the screen instead of being injected part-way down a page that already carries six cards. `overlayShell()` renders the chrome; `sortable()` and `seg()` live there too. Card builders return `{amount, body}`, not a whole element.

**Overview earns its cards.** Window strip, hero, six tiles, where-it-went, by-model, worth-fixing. Tools and recent sessions moved to Activity, where the tables already live — eleven boxes was too many to scan. Anything new needs to displace something.

**The current-window strip shows usage, never "remaining".** The cap isn't on disk — `/status` fetches it live from Anthropic and this app makes no network calls — so a percentage would be invented. `db.current_window` measures the half that can be measured.

**The savings drill-down returns everything and sorts on the client.** Both lists are a few thousand rows at most, so a `sort` round trip per click would be slower and would lose the scroll position inside the box. `sortable()` in `savings.js` is the shared helper; `PROMPT_POOL` in `server.py` is a safety ceiling, and when it binds the response sets `prompts_truncated` so the panel can say the list is partial rather than implying it's complete.

**Prompt cost is attributed by turn window, never by `parent_uuid`.** A prompt owns every assistant turn until the next typed prompt — that's what "what did this prompt cost" means, and it's the only way an agent run gets charged to the thing that started it. The `parent_uuid` chain cannot do it: 20,598 of 34,586 assistant rows in a real database point at a uuid that isn't stored, and the old join matched **257 of 34,586 turns** (0.7%) while looking like a complete ranking. `db.prompt_costs` is the replacement; the LEFT JOIN is deliberate so a prompt that set nothing off still appears at $0.

**`tools/audit_data.py` recomputes every figure a second way and exits non-zero on any disagreement.** Run it against a live server after touching a query, a fold or a pricing path. It covers overview totals vs raw SQL, every component endpoint summing back to the total, prompt attribution completeness, the savings drill-down reconciling with its headline, and each breakdown agreeing with the chart that opens it.

**Drill-downs must reconcile with the number they explain.** `/api/breakdown` (by day/model/tool) and `/api/savings/breakdown` (of spend/caching) exist so a figure can be opened. Two rules learned building them: price at the (bucket, model) grain and fold *after*, never before; and `_cache_saving` is **net of the cache-write premium**, because gross rows would sum to more than the headline they explain. `of=changes` returns 400 on purpose — the attributed saving is a rate against the user's own worst week and belongs to no prompt. A test enforces that.

## Fork

This is a fork of [nateherkai/token-dashboard](https://github.com/nateherkai/token-dashboard) (MIT), maintained under `code/personal/` in the Second Brain vault. `origin` is `pushandamen/token-dashboard`; `upstream` is the original, fetch-only (its push URL is deliberately broken). Pull their work with `git pull upstream main`.

Local additions so far:

- `glance` command + `token_dashboard/glance.py` — one JSON bundle for the ADA HUD.
- **Repriced.** `pricing.json` listed Opus at $15/$75 (Opus 4.1-era) and had no entry for Fable, Opus 5, Sonnet 5, or Opus 4.8. Worse, `claude-fable-5` matched no tier substring, so `cost_for` returned `None` and every caller skipped it — 32M tokens costed at $0. Now every model in use prices exactly, unpriced models are reported instead of dropped, and `tips.py` reads rates from the table instead of its own hardcoded literals.
- **Codex** (`token_dashboard/codex.py`) — reads `~/.codex/sessions/**/rollout-*.jsonl`, since Claude Code's transcripts don't record what a `codex exec` call spent.
- **Savings tab** (`token_dashboard/savings.py`, `web/routes/savings.js`) — exact vs. attributed vs. forecast, plus change-point detection the human labels.
- GitHub Actions CI running the unittest suite on 3.9 and 3.13.

## Architecture

- `cli.py` → `token_dashboard/scanner.py` → `~/.claude/token-dashboard.db` (SQLite)
- `token_dashboard/codex.py` reads Codex's own rollout logs into `codex_sessions`. Kept out of `messages` on purpose: that table's `(session_id, message_id)` dedup exists for Claude's streaming snapshots, whereas Codex writes a **cumulative running total** — so the last `token_count` event wins and summing them double-counts.
- `token_dashboard/savings.py` separates exact (cache arithmetic) from attributed (waste vs. your own peak) from forecast. Never add the forecast into a total, and never price a *rate* metric — multiplying tokens-per-turn by seven yields nothing real.
- `token_dashboard/server.py` exposes JSON APIs (`/api/*`) + SSE stream (`/api/stream`) + static frontend (`web/`)
- **A cost per bucket needs the bucket split by model first.** `db.py`'s `daily_model_breakdown` / `project_model_breakdown` return one row per (bucket, model); `server._attach_costs` prices each and sums. Summing a day's tokens and pricing the total once is wrong by roughly the Haiku↔Opus ratio. Buckets with nothing priceable get `0.0`, never `null` — a null draws as a gap in the trend line, which reads as "no activity" rather than "no price on file".
- `token_dashboard/glance.py` assembles one JSON bundle for external panels — `cli.py glance`, consumed by the ADA HUD's `/tokens` view. Reads SQLite directly; no server needed.
- `web/` is vanilla JS, no build step — hash router + ECharts

## Data source

Claude Code writes one JSONL file per session to `~/.claude/projects/<project-slug>/<session-id>.jsonl`. Each line is a message record; usage fields live at `message.usage` and model identifier at `message.model`. The scanner is incremental — it tracks each file's mtime and byte offset in the `files` table and only reads new bytes on subsequent scans.

## Conventions

- **Fully local.** No telemetry, no remote calls for user data. Tests run offline.
- **Stdlib only.** No `pip install`. If a new feature needs a third-party library, argue for it first — we're willing to pay ergonomics cost to keep install friction at zero.
- **SQLite parameter binding always.** Any f-string in a SQL statement must interpolate only internal, caller-controlled values (column names, placeholder lists). User-reachable values go through `?`.
- **Small files with clear responsibilities.** If a file grows past ~400 lines or accretes three distinct concerns, split it.
- **Streaming-snapshot dedup.** When adding scanner logic that joins the `messages` table, remember `(session_id, message_id)` is the dedup key, not `uuid`. See `scanner._evict_prior_snapshots` and the migration note in `db._migrate_add_message_id`.

## Customizing

Env vars: `PORT` (default 8080), `HOST` (default 127.0.0.1), `CLAUDE_PROJECTS_DIR`, `TOKEN_DASHBOARD_DB`. Pricing lives in `pricing.json`. See README.md § Environment variables for details.

## Known limitations

See `docs/KNOWN_LIMITATIONS.md`. Current summary: Skills `tokens_per_call` is populated only for skills installed under the three scanned roots (`~/.claude/skills/`, `~/.claude/scheduled-tasks/`, `~/.claude/plugins/`); project-local skills and subagent-dispatched skills show invocation counts but blank token counts.

## Verifying changes

```bash
python3 -m unittest discover tests        # all tests
python3 cli.py dashboard --no-open        # start the server
curl http://127.0.0.1:8080/api/overview   # sanity-check an endpoint
```
