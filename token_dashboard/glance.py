"""One JSON bundle for external glance panels.

The web UI has seven tabs; a glance panel wants one payload it can render in a
single fetch, without the HTTP server running. `build_glance` assembles today's
and all-time totals, a short daily series, the heaviest projects, and the top
tips — the same numbers `/api/overview`, `/api/daily`, `/api/projects` and
`/api/tips` serve, read straight from the SQLite cache.

Consumer: the ADA HUD's /tokens panel (`lib/tokens.ts` shells out to
`cli.py glance`). Exposed via the CLI rather than the server so the panel keeps
working when nothing is listening on 8080.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Union

from .db import (
    daily_token_breakdown,
    model_breakdown,
    overview_totals,
    project_summary,
    recent_sessions,
)
from .pricing import DEFAULT_PRICING, format_for_user, get_plan, load_pricing, total_cost
from .tips import all_tips

DAILY_DAYS = 14
TOP_PROJECTS = 5
TOP_TIPS = 3
RECENT_SESSIONS = 3


def _day_bounds(now: datetime) -> tuple:
    """UTC [midnight, next midnight) around `now` — the range `today` uses."""
    start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    return start.isoformat(), (start + timedelta(days=1)).isoformat()


def _totals(db_path, pricing: dict, since=None, until=None) -> dict:
    t = overview_totals(db_path, since, until)
    cache_create = t["cache_create_5m_tokens"] + t["cache_create_1h_tokens"]
    cost = total_cost(model_breakdown(db_path, since, until), pricing)
    return {
        "sessions": t["sessions"],
        "turns": t["turns"] or 0,
        "input_tokens": t["input_tokens"],
        "output_tokens": t["output_tokens"],
        "cache_read_tokens": t["cache_read_tokens"],
        "cache_create_tokens": cache_create,
        "billable_tokens": t["input_tokens"] + t["output_tokens"] + cache_create,
        "cost_usd": cost["usd"],
        "cost_estimated": cost["estimated"],
        "unpriced_models": cost["unpriced"],
    }


def build_glance(
    db_path: Union[str, Path],
    pricing_path: Union[str, Path, None] = None,
    now: Optional[datetime] = None,
) -> dict:
    """Assemble the glance bundle. `now` is injectable so tests can pin the day."""
    now = now or datetime.now(timezone.utc)
    pricing = load_pricing(pricing_path or DEFAULT_PRICING)
    plan = get_plan(db_path)
    day_start, day_end = _day_bounds(now)

    all_time = _totals(db_path, pricing)
    daily_since = (now - timedelta(days=DAILY_DAYS - 1)).strftime("%Y-%m-%d")

    tips = all_tips(db_path)
    projects = project_summary(db_path)[:TOP_PROJECTS]

    return {
        "generated_at": now.isoformat(),
        "plan": plan,
        "plan_label": pricing["plans"].get(plan, {}).get("label", plan),
        "cost_note": format_for_user(all_time["cost_usd"], plan, pricing)["subtitle"],
        "today": _totals(db_path, pricing, day_start, day_end),
        "all_time": all_time,
        "daily": daily_token_breakdown(db_path, since=daily_since),
        "projects": [
            {
                "project_name": p["project_name"],
                "project_slug": p["project_slug"],
                "sessions": p["sessions"],
                "billable_tokens": p["billable_tokens"] or 0,
                "cache_read_tokens": p["cache_read_tokens"] or 0,
            }
            for p in projects
        ],
        "tips_total": len(tips),
        "tips": [
            {"category": t["category"], "title": t["title"], "body": t["body"]}
            for t in tips[:TOP_TIPS]
        ],
        "recent_sessions": [
            {
                "session_id": s["session_id"],
                "project_name": s["project_name"],
                "ended": s["ended"],
                "turns": s["turns"] or 0,
                "tokens": s["tokens"] or 0,
            }
            for s in recent_sessions(db_path, limit=RECENT_SESSIONS)
        ],
    }
