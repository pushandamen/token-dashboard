"""What the optimizations actually saved.

Three things get conflated under "savings", and this module keeps them apart
because they are believable to very different degrees:

  1. **Cache savings** — arithmetic. Cache reads bill at a tenth of input, and
     writes bill at a premium. Real token counts, real rates, no counterfactual
     beyond "the same conversation without a cache", which in an agentic loop
     is exactly what you'd have paid. This is the only figure called *exact*.

  2. **Waste avoided vs. your own peak** — attributed. Compares the current
     7-day rate of a measurable waste pattern against the worst 7-day window in
     your history. Real measurements either side, but it assumes you'd still be
     at the peak rate, which nobody can prove.

  3. **Projection** — a forecast, labelled as one. Never added into a total.

The data cannot tell you *what* you changed — it has no record of you splitting
a file or rewriting a rule. What it can do is find the day a metric stepped
down and hand you the date, the size of the drop, and what it's worth per week;
you attach the name. Labels persist in `optimization_labels`.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Union

from .codex import codex_breakdown, codex_totals
from .db import connect, model_breakdown
from .pricing import DEFAULT_PRICING, cost_for, get_plan, load_pricing, total_cost

# Change-point detection. A split needs this many days of data either side, and
# the drop must be at least this large to be worth surfacing — below ~35% the
# detector mostly finds ordinary week-to-week variation in how much you worked.
WINDOW_DAYS = 7
MIN_SIDE_DAYS = 4
MIN_DROP = 0.35
TOP_TARGETS = 12          # files to run detection over, by read volume
DAYS_PER_YEAR = 365.25

# What counts as an oversized tool result. Claude Code truncates results at
# roughly 25k tokens, so a threshold at or above that can never fire — the
# largest result in a 129k-message history was 24,911. 5k is the knee: ~300
# calls, and every one of them is a full file where a range would have done.
OVERSIZED_RESULT = 5_000


# --- small helpers -----------------------------------------------------------

def _day(d: datetime) -> str:
    return d.strftime("%Y-%m-%d")


def _mean(xs) -> float:
    xs = list(xs)
    return sum(xs) / len(xs) if xs else 0.0


def _series_to_map(rows, key="day", val="v") -> dict:
    return {r[key]: r[val] for r in rows}


def _dense_days(series: dict, first: str, last: str) -> list:
    """Fill missing days with 0 — a day with no work is a real zero, not a gap."""
    out = []
    d = datetime.strptime(first, "%Y-%m-%d")
    end = datetime.strptime(last, "%Y-%m-%d")
    while d <= end:
        k = _day(d)
        out.append((k, float(series.get(k, 0))))
        d += timedelta(days=1)
    return out


def _blended_input_rate(db_path, pricing: dict) -> float:
    """One $/MTok input rate, weighted by how much each model was actually used.

    Waste metrics are counted in tokens without a model attached (a tool result
    is charged to whichever turn consumed it), so pricing them needs a single
    representative rate rather than a per-model one.
    """
    rows = model_breakdown(db_path)
    num = den = 0.0
    for r in rows:
        c = cost_for(r["model"], r, pricing)
        if c["usd"] is None:
            continue
        rates = pricing["models"].get(r["model"]) or pricing["tier_fallback"].get(
            _tier_of(r["model"], pricing), {})
        w = r["input_tokens"] + r["cache_read_tokens"]
        if w and rates:
            num += rates["input"] * w
            den += w
    return (num / den) if den else 5.0


def _tier_of(model: str, pricing: dict) -> Optional[str]:
    entry = pricing["models"].get(model)
    if entry:
        return entry.get("tier")
    from .pricing import _tier_from_name
    return _tier_from_name(model)


# --- 1. cache savings (exact) ------------------------------------------------

def cache_savings(db_path, pricing: dict, since=None, until=None) -> dict:
    """What prompt caching netted, priced per model against that model's rates.

    Net, not gross: reads are cheaper than input, but writes cost *more* than
    input (1.25x at 5 minutes, 2x at an hour), so the write premium is
    subtracted. A gross "look what caching saved" number that ignores what
    caching cost is marketing, not accounting.
    """
    saved = write_premium = 0.0
    read_tokens = write_tokens = 0
    for r in model_breakdown(db_path, since, until):
        rates = pricing["models"].get(r["model"])
        if rates is None:
            tier = _tier_of(r["model"], pricing)
            rates = pricing["tier_fallback"].get(tier) if tier else None
        if rates is None:
            continue
        saved += r["cache_read_tokens"] * (rates["input"] - rates["cache_read"]) / 1e6
        write_premium += (
            r["cache_create_5m_tokens"] * (rates["cache_create_5m"] - rates["input"])
            + r["cache_create_1h_tokens"] * (rates["cache_create_1h"] - rates["input"])
        ) / 1e6
        read_tokens += r["cache_read_tokens"]
        write_tokens += r["cache_create_5m_tokens"] + r["cache_create_1h_tokens"]

    total = read_tokens + write_tokens
    return {
        "read_tokens": read_tokens,
        "write_tokens": write_tokens,
        "hit_rate_pct": round(100.0 * read_tokens / total, 1) if total else None,
        "gross_saved_usd": round(saved, 2),
        "write_premium_usd": round(write_premium, 2),
        "net_saved_usd": round(saved - write_premium, 2),
        "basis": (
            "For each model: cache-read tokens x (its input rate - its cache-read rate), "
            "minus what the cache writes cost above plain input rate "
            "(1.25x at 5 minutes, 2x at an hour). Measured tokens, published rates, "
            "no estimate — the only assumption is that without a cache the same "
            "conversation would have re-sent the same prefix, which is what an "
            "agent loop does."
        ),
    }


# --- 2. waste metrics --------------------------------------------------------

def _daily_waste_series(db_path) -> dict:
    """Daily token series for each waste pattern we can measure exactly."""
    with connect(db_path) as c:
        oversized = [
            {"day": r["day"], "v": r["excess"]}
            for r in c.execute(f"""
              SELECT substr(timestamp, 1, 10) AS day,
                     SUM(result_tokens - {OVERSIZED_RESULT}) AS excess
                FROM tool_calls
               WHERE tool_name = '_tool_result' AND result_tokens > {OVERSIZED_RESULT}
               GROUP BY day
            """)
        ]
        rebuild = [
            {"day": r["day"], "v": r["v"]}
            for r in c.execute("""
              SELECT substr(timestamp, 1, 10) AS day,
                     COALESCE(SUM(cache_create_5m_tokens + cache_create_1h_tokens), 0) AS v
                FROM messages
               WHERE timestamp IS NOT NULL
               GROUP BY day
            """)
        ]
        # Re-reads of a file already read in the same session. Counted, not
        # tokenised: the read's own result size isn't attributable to the call.
        rereads = [
            {"day": r["day"], "v": r["v"]}
            for r in c.execute("""
              SELECT day, SUM(n - 1) AS v FROM (
                SELECT substr(timestamp, 1, 10) AS day, session_id, target, COUNT(*) AS n
                  FROM tool_calls
                 WHERE tool_name IN ('Read','Edit','Write') AND target IS NOT NULL
                 GROUP BY day, session_id, target
                 HAVING n > 1
              ) GROUP BY day
            """)
        ]
    return {
        "oversized_results": {
            "label": f"Tool results over {OVERSIZED_RESULT // 1000}k tokens",
            "unit": "tokens",
            "series": _series_to_map(oversized),
            "note": "Excess above the threshold, not the whole result.",
        },
        "cache_rebuild": {
            "label": "Context rebuilt into cache",
            "unit": "tokens",
            "series": _series_to_map(rebuild),
            "note": "Cache writes. Some is unavoidable; a spike means sessions kept resetting.",
        },
        "repeat_reads": {
            "label": "Repeat reads of a file in one session",
            "unit": "calls",
            "series": _series_to_map(rereads),
            "note": "Counted, not priced — a read's token cost isn't attributable to the call.",
        },
    }


def waste_vs_peak(db_path, pricing: dict, now: datetime) -> dict:
    """Current 7-day rate of each waste pattern against its worst 7-day window."""
    rate = _blended_input_rate(db_path, pricing)
    basis = (
        f"Each pattern's most recent 7 days against its worst 7 days, priced at "
        f"${rate:.2f}/MTok — the input rate you actually paid, weighted by how much "
        f"each model was used. Attributed, not exact: both ends are measured, but "
        f"it assumes you would otherwise still be running at the worst rate."
    )
    with connect(db_path) as c:
        span = c.execute(
            "SELECT MIN(substr(timestamp,1,10)) a, MAX(substr(timestamp,1,10)) b FROM messages"
        ).fetchone()
    if not span or not span["a"]:
        return {"items": [], "saved_usd_per_week": 0.0,
                "blended_input_rate": rate, "basis": basis}

    items = []
    saved_week = 0.0
    for key, meta in _daily_waste_series(db_path).items():
        days = _dense_days(meta["series"], span["a"], span["b"])
        if len(days) < WINDOW_DAYS * 2:
            continue
        windows = [
            (days[i][0], sum(v for _, v in days[i:i + WINDOW_DAYS]))
            for i in range(len(days) - WINDOW_DAYS + 1)
        ]
        peak_day, peak = max(windows, key=lambda w: w[1])
        current = windows[-1][1]
        delta = max(0.0, peak - current)
        usd = round(delta * rate / 1e6, 2) if meta["unit"] == "tokens" else None
        if usd:
            saved_week += usd
        items.append({
            "key": key,
            "label": meta["label"],
            "unit": meta["unit"],
            "note": meta["note"],
            "current_per_week": int(current),
            "peak_per_week": int(peak),
            "peak_window_start": peak_day,
            "reduction_pct": round(100.0 * delta / peak, 1) if peak else None,
            "saved_per_week": int(delta),
            "saved_usd_per_week": usd,
        })
    items.sort(key=lambda i: i["saved_usd_per_week"] or 0, reverse=True)
    return {
        "items": items,
        "saved_usd_per_week": round(saved_week, 2),
        "blended_input_rate": round(rate, 3),
        "basis": basis,
    }


# --- 3. change-point detection ----------------------------------------------

def _detect(days, min_drop=MIN_DROP) -> Optional[dict]:
    """Find the day a daily series stepped down and stayed down.

    Compares the mean of the `WINDOW_DAYS` before a candidate day against the
    mean of that day and the `WINDOW_DAYS - 1` after it, and keeps the biggest
    relative fall. Deliberately crude: with five weeks of data anything fancier
    would be fitting noise.
    """
    best = None
    for i in range(MIN_SIDE_DAYS, len(days) - MIN_SIDE_DAYS + 1):
        before = _mean(v for _, v in days[max(0, i - WINDOW_DAYS):i])
        after = _mean(v for _, v in days[i:i + WINDOW_DAYS])
        if before <= 0:
            continue
        drop = (before - after) / before
        if drop < min_drop:
            continue
        if best is None or drop > best["drop"]:
            best = {"day": days[i][0], "before": before, "after": after, "drop": drop}
    return best


def change_points(db_path, pricing: dict) -> list:
    """Dated step-downs, priced per week, ready for the human to name."""
    rate = _blended_input_rate(db_path, pricing)
    with connect(db_path) as c:
        span = c.execute(
            "SELECT MIN(substr(timestamp,1,10)) a, MAX(substr(timestamp,1,10)) b FROM messages"
        ).fetchone()
        if not span or not span["a"]:
            return []
        first, last = span["a"], span["b"]

        candidates = []

        # Per-file read volume — the clearest signal, and the one that maps
        # onto a change you actually made.
        top = [
            r["target"] for r in c.execute("""
              SELECT target, COUNT(*) n FROM tool_calls
               WHERE tool_name IN ('Read','Edit','Write') AND target IS NOT NULL
               GROUP BY target ORDER BY n DESC LIMIT ?
            """, (TOP_TARGETS,))
        ]
        for target in top:
            rows = [
                {"day": r["day"], "v": r["n"]}
                for r in c.execute("""
                  SELECT substr(timestamp,1,10) AS day, COUNT(*) n FROM tool_calls
                   WHERE tool_name IN ('Read','Edit','Write') AND target = ?
                   GROUP BY day
                """, (target,))
            ]
            candidates.append(("file", target, f"Reads of {target}", "calls",
                               True, _series_to_map(rows)))

        # Tokens per turn — did the work itself get leaner? Flagged not-summable:
        # it is already a per-turn rate, so multiplying it by seven would give
        # "tokens per turn per week", which is not a quantity of anything.
        rows = [
            {"day": r["day"], "v": (r["tok"] or 0) / r["turns"] if r["turns"] else 0}
            for r in c.execute("""
              SELECT substr(timestamp,1,10) AS day,
                     SUM(input_tokens + output_tokens
                         + cache_create_5m_tokens + cache_create_1h_tokens) AS tok,
                     SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns
                FROM messages WHERE timestamp IS NOT NULL GROUP BY day
            """)
        ]
        candidates.append(("metric", "tokens_per_turn", "Billable tokens per turn",
                           "tokens/turn", False, _series_to_map(rows)))

        for key, meta in _daily_waste_series(db_path).items():
            candidates.append(("metric", key, meta["label"], meta["unit"], True, meta["series"]))

        labels = {
            r["change_key"]: r["label"]
            for r in c.execute("SELECT change_key, label FROM optimization_labels")
        }

    out = []
    for kind, ident, label, unit, summable, series in candidates:
        days = _dense_days(series, first, last)
        if len(days) < MIN_SIDE_DAYS * 2:
            continue
        hit = _detect(days)
        if not hit:
            continue
        per_week = (hit["before"] - hit["after"]) * 7 if summable else None
        key = f"{kind}:{ident}@{hit['day']}"
        out.append({
            "key": key,
            "kind": kind,
            "metric": label,
            "unit": unit,
            "date": hit["day"],
            "before_per_day": round(hit["before"], 1),
            "after_per_day": round(hit["after"], 1),
            "drop_pct": round(100 * hit["drop"], 1),
            "saved_per_week": round(per_week, 1) if per_week is not None else None,
            "saved_usd_per_week": (
                round(per_week * rate / 1e6, 2) if per_week is not None and unit == "tokens" else None
            ),
            "label": labels.get(key),
        })
    out.sort(key=lambda c: (c["saved_usd_per_week"] or 0, c["drop_pct"]), reverse=True)
    return out


def set_label(db_path, change_key: str, label: str) -> None:
    """Name a detected change. An empty label clears it."""
    import time
    with connect(db_path) as c:
        if label.strip():
            c.execute(
                "INSERT OR REPLACE INTO optimization_labels (change_key, label, noted_at)"
                " VALUES (?, ?, ?)", (change_key, label.strip(), time.time()))
        else:
            c.execute("DELETE FROM optimization_labels WHERE change_key = ?", (change_key,))
        c.commit()


# --- 4. efficiency trend -----------------------------------------------------

def efficiency_trend(db_path) -> dict:
    """Weekly billable tokens per turn — a rate, so it never becomes a dollar total."""
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute("""
          SELECT strftime('%Y-W%W', timestamp) AS week,
                 MIN(substr(timestamp,1,10)) AS starting,
                 SUM(input_tokens + output_tokens
                     + cache_create_5m_tokens + cache_create_1h_tokens) AS tok,
                 SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns,
                 COUNT(DISTINCT session_id) AS sessions
            FROM messages WHERE timestamp IS NOT NULL
           GROUP BY week ORDER BY week ASC
        """)]
    series = [
        {
            "week": r["week"],
            "starting": r["starting"],
            "turns": r["turns"] or 0,
            "tokens_per_turn": round((r["tok"] or 0) / r["turns"]) if r["turns"] else None,
            "tokens_per_session": round((r["tok"] or 0) / r["sessions"]) if r["sessions"] else None,
        }
        for r in rows
    ]
    usable = [s for s in series if s["tokens_per_turn"]]
    change = None
    if len(usable) >= 2 and usable[0]["tokens_per_turn"]:
        change = round(
            100.0 * (usable[-1]["tokens_per_turn"] - usable[0]["tokens_per_turn"])
            / usable[0]["tokens_per_turn"], 1)
    return {
        "series": series,
        "first_tokens_per_turn": usable[0]["tokens_per_turn"] if usable else None,
        "latest_tokens_per_turn": usable[-1]["tokens_per_turn"] if usable else None,
        "change_pct": change,
    }


# --- 5. projection (forecast) ------------------------------------------------

def projection(db_path, pricing: dict, now: datetime, waste_usd_per_week: float) -> dict:
    since = _day(now - timedelta(days=7))
    recent = total_cost(model_breakdown(db_path, since=since), pricing)["usd"]
    at_peak = recent + waste_usd_per_week
    return {
        "is_forecast": True,
        "basis": (
            "The last 7 days of spend, held flat for a year. A forecast, not a "
            "measurement: it assumes next week looks like last week, which it will "
            "not. Useful for deciding whether an optimization is worth an afternoon, "
            "not for a budget."
        ),
        "last_7d_usd": round(recent, 2),
        "annual_run_rate_usd": round(recent * DAYS_PER_YEAR / 7, 2),
        "annual_at_peak_usd": round(at_peak * DAYS_PER_YEAR / 7, 2),
        "annual_avoided_usd": round(waste_usd_per_week * DAYS_PER_YEAR / 7, 2),
    }


# --- the bundle --------------------------------------------------------------

def build_savings(
    db_path: Union[str, Path],
    pricing_path: Union[str, Path, None] = None,
    now: Optional[datetime] = None,
) -> dict:
    now = now or datetime.now(timezone.utc)
    pricing = load_pricing(pricing_path or DEFAULT_PRICING)

    cache = cache_savings(db_path, pricing)
    waste = waste_vs_peak(db_path, pricing, now)
    spend = total_cost(model_breakdown(db_path), pricing)
    codex_spend = total_cost(codex_breakdown(db_path), pricing)

    # Weeks of history, so the per-week waste figure can be turned into a
    # to-date figure without pretending the whole history ran at peak.
    with connect(db_path) as c:
        span = c.execute(
            "SELECT MIN(substr(timestamp,1,10)) a, MAX(substr(timestamp,1,10)) b FROM messages"
        ).fetchone()
    weeks = 0.0
    if span and span["a"]:
        days = (datetime.strptime(span["b"], "%Y-%m-%d")
                - datetime.strptime(span["a"], "%Y-%m-%d")).days + 1
        weeks = days / 7.0

    waste_to_date = round(waste["saved_usd_per_week"] * weeks, 2)

    # The comparison that makes the cache figure mean anything. Paying X while
    # saving 6X reads as nonsense until you say what the alternative was:
    # without a cache, every cached read is full-price input and every cache
    # write is plain input too. That difference is exactly the net saving, so
    # the counterfactual bill is simply what you paid plus what you saved.
    total_spend = round(spend["usd"] + codex_spend["usd"], 2)
    without_caching = round(total_spend + cache["net_saved_usd"], 2)

    return {
        "generated_at": now.isoformat(),
        "plan": get_plan(db_path),
        "history": {
            "first_day": span["a"] if span else None,
            "last_day": span["b"] if span else None,
            "weeks": round(weeks, 1),
        },
        "spend": {
            "claude_usd": spend["usd"],
            "codex_usd": codex_spend["usd"],
            "total_usd": total_spend,
            "without_caching_usd": without_caching,
            "discount_pct": (
                round(100.0 * cache["net_saved_usd"] / without_caching, 1)
                if without_caching else None
            ),
            "unpriced_models": spend["unpriced"] + codex_spend["unpriced"],
        },
        "headline": {
            "exact_usd": cache["net_saved_usd"],
            "attributed_usd": waste_to_date,
            "total_usd": round(cache["net_saved_usd"] + waste_to_date, 2),
            "basis": (
                f"Net cache savings (exact) plus waste avoided against your own worst "
                f"week, carried across {round(weeks, 1)} weeks of history (attributed). "
                f"The forecast below is deliberately excluded — it has not happened yet."
            ),
        },
        "cache": cache,
        "waste": {**waste, "saved_usd_to_date": waste_to_date},
        "change_points": change_points(db_path, pricing),
        "efficiency": efficiency_trend(db_path),
        "projection": projection(db_path, pricing, now, waste["saved_usd_per_week"]),
        "codex": {**codex_totals(db_path), "cost_usd": codex_spend["usd"]},
    }
