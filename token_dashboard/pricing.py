"""Pricing table + plan-aware cost formatting."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional, Union

from .db import connect

DEFAULT_PRICING = Path(__file__).resolve().parent.parent / "pricing.json"


def load_pricing(path: Union[str, Path]) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


# Substring -> tier, for models with no exact entry. Ordered: the first match
# wins, so put anything that could contain another's name first. "gpt" is last
# because it's the loosest match.
_TIER_MARKERS = (
    ("fable", "fable"),
    ("mythos", "fable"),   # Mythos shares Fable's pricing
    ("opus", "opus"),
    ("sonnet", "sonnet"),
    ("haiku", "haiku"),
    ("gpt", "gpt"),
    ("codex", "gpt"),
)


def _tier_from_name(model: str) -> Optional[str]:
    m = (model or "").lower()
    for marker, tier in _TIER_MARKERS:
        if marker in m:
            return tier
    return None


def cost_for(model: str, usage: dict, pricing: dict) -> dict:
    """Return {usd, estimated, breakdown}. usd=None when no tier match."""
    rates = pricing["models"].get(model)
    estimated = False
    if rates is None:
        tier = _tier_from_name(model or "")
        if tier and tier in pricing["tier_fallback"]:
            rates = pricing["tier_fallback"][tier]
            estimated = True
        else:
            return {"usd": None, "estimated": True, "breakdown": {}}
    bd = {
        "input":           usage["input_tokens"]            * rates["input"]           / 1_000_000,
        "output":          usage["output_tokens"]           * rates["output"]          / 1_000_000,
        "cache_read":      usage["cache_read_tokens"]       * rates["cache_read"]      / 1_000_000,
        "cache_create_5m": usage["cache_create_5m_tokens"]  * rates["cache_create_5m"] / 1_000_000,
        "cache_create_1h": usage["cache_create_1h_tokens"]  * rates["cache_create_1h"] / 1_000_000,
    }
    return {"usd": round(sum(bd.values()), 6), "estimated": estimated, "breakdown": bd}


def total_cost(rows, pricing: dict) -> dict:
    """Sum cost over per-model usage rows, reporting what could NOT be priced.

    `cost_for` returns usd=None when a model matches no entry and no tier, and
    every caller used to just skip those rows — which is how claude-fable-5's
    32M tokens silently counted as $0 while the table still listed Opus at its
    4.1-era $15/$75. A total that quietly excludes a model is worse than one
    that's late, so the unpriced models come back with the number.
    """
    usd = 0.0
    estimated = False
    unpriced = []
    contributions = []
    for r in rows:
        c = cost_for(r["model"], r, pricing)
        if c["usd"] is not None:
            contributions.append({
                "model": r["model"],
                "usd": round(c["usd"], 4),
                "estimated": c["estimated"],
                "breakdown": {k: round(v, 4) for k, v in c["breakdown"].items()},
                "tokens": {
                    "input": r["input_tokens"],
                    "output": r["output_tokens"],
                    "cache_read": r["cache_read_tokens"],
                    "cache_create_5m": r["cache_create_5m_tokens"],
                    "cache_create_1h": r["cache_create_1h_tokens"],
                },
            })
        if c["usd"] is None:
            billable = (r["input_tokens"] + r["output_tokens"]
                        + r["cache_create_5m_tokens"] + r["cache_create_1h_tokens"])
            # Claude Code's `<synthetic>` messages carry no tokens at all. A model
            # with nothing to bill isn't a gap in the table — don't cry wolf.
            if billable or r["cache_read_tokens"]:
                unpriced.append({"model": r["model"], "billable_tokens": billable})
            continue
        usd += c["usd"]
        estimated = estimated or c["estimated"]
    unpriced.sort(key=lambda u: u["billable_tokens"], reverse=True)
    contributions.sort(key=lambda c: c["usd"], reverse=True)
    return {
        "usd": round(usd, 4),
        "estimated": estimated,
        "unpriced": unpriced,
        # Per-model workings, so the UI can show where a total came from rather
        # than asking anyone to trust it.
        "contributions": contributions,
        "basis": (
            "Each model's tokens x that model's rate from pricing.json, summed. "
            "Input, output, cache reads and cache writes are priced separately."
        ),
    }


def get_plan(db_path: Union[str, Path], default: str = "api") -> str:
    with connect(db_path) as c:
        row = c.execute("SELECT v FROM plan WHERE k='plan'").fetchone()
    return row["v"] if row else default


def set_plan(db_path: Union[str, Path], plan: str) -> None:
    with connect(db_path) as c:
        c.execute("INSERT OR REPLACE INTO plan (k, v) VALUES ('plan', ?)", (plan,))
        # Remember that a human actually chose, so the welcome modal doesn't
        # reappear in every new browser profile. It used to key off localStorage
        # alone, which made a first-run gate out of what is a one-time setting.
        c.execute("INSERT OR REPLACE INTO plan (k, v) VALUES ('plan_set', '1')")
        c.commit()


def plan_is_set(db_path: Union[str, Path]) -> bool:
    with connect(db_path) as c:
        return c.execute("SELECT 1 FROM plan WHERE k='plan_set'").fetchone() is not None


def format_for_user(api_cost_usd: float, plan: str, pricing: dict) -> dict:
    p = pricing["plans"].get(plan, pricing["plans"]["api"])
    if plan == "api" or p["monthly"] == 0:
        return {"display_usd": api_cost_usd, "subtitle": None, "subscription_usd": None}
    return {
        "display_usd":      api_cost_usd,
        "subtitle":         f"You pay ${p['monthly']}/mo on {p['label']}",
        "subscription_usd": p["monthly"],
    }
