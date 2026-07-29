"""Cross-check every figure the app shows against the database it reads.

Run with the dashboard already serving:  python3 tools/audit_data.py
Exits non-zero if any figure disagrees, so it can gate a release.

Each check recomputes a number a different way than the app does and compares.
Anything that disagrees is printed as FAIL with both values.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sqlite3
from token_dashboard.pricing import cost_for, load_pricing
from token_dashboard.server import PRICING_JSON

DB = os.environ.get("TOKEN_DASHBOARD_DB", os.path.expanduser("~/.claude/token-dashboard.db"))
API = "http://127.0.0.1:8080/api"
pricing = load_pricing(PRICING_JSON)
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

fails = []

# The database is written to while this runs — Claude Code appends as you work.
# Without a shared upper bound the API answers at T1 and the SQL at T2, and the
# difference reads as a data bug. Everything below is measured strictly before
# this cutoff, on both sides.
CUTOFF = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
UNTIL = "until=" + CUTOFF
BOUND = " AND timestamp < :cut"
CUT = {"cut": CUTOFF}


def get(p):
    return json.loads(urllib.request.urlopen(API + p).read())


def check(name, a, b, tol=0.02):
    """tol is relative; ints compare exactly when tol=0."""
    ok = (a == b) if tol == 0 else (abs(a - b) <= max(tol * max(abs(a), abs(b)), 0.01))
    print(("  ok   " if ok else "  FAIL ") + name)
    if not ok:
        print(f"         app={a!r}  recomputed={b!r}")
        fails.append(name)


TOKS = ["input_tokens", "output_tokens", "cache_read_tokens",
        "cache_create_5m_tokens", "cache_create_1h_tokens"]


def price(rows):
    total = 0.0
    for r in rows:
        v = cost_for(r["model"], {k: r[k] or 0 for k in TOKS}, pricing)["usd"]
        total += v or 0.0
    return total


print("\n=== /api/overview totals vs direct SQL (all time) ===")
ov = get("/overview?" + UNTIL)
row = c.execute("""SELECT COUNT(DISTINCT session_id) s,
    SUM(CASE WHEN type='user' AND prompt_text IS NOT NULL THEN 1 ELSE 0 END) t,
    SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_tokens) cr,
    SUM(cache_create_5m_tokens) c5, SUM(cache_create_1h_tokens) c1 FROM messages
    WHERE timestamp < :cut""", CUT).fetchone()
check("sessions", ov["sessions"], row["s"], 0)
check("prompts (turns)", ov["turns"], row["t"], 0)
check("input_tokens", ov["input_tokens"], row["i"], 0)
check("output_tokens", ov["output_tokens"], row["o"], 0)
check("cache_read_tokens", ov["cache_read_tokens"], row["cr"], 0)
check("cache_create_5m", ov["cache_create_5m_tokens"], row["c5"], 0)
check("cache_create_1h", ov["cache_create_1h_tokens"], row["c1"], 0)

per_model = [dict(r) for r in c.execute(
    f"""SELECT COALESCE(model,'unknown') model, {','.join('SUM(%s) %s' % (t, t) for t in TOKS)}
        FROM messages WHERE type='assistant'""" + BOUND + " GROUP BY model", CUT)]
check("cost_usd", ov["cost_usd"], price(per_model))

print("\n=== component endpoints sum to the same total ===")
daily = get("/daily?" + UNTIL)
check("sum(/daily cost) == overview cost", sum(d["cost_usd"] for d in daily), ov["cost_usd"])
check("sum(/daily input) == overview input",
      sum(d["input_tokens"] for d in daily), ov["input_tokens"], 0)
check("sum(/daily output) == overview output",
      sum(d["output_tokens"] for d in daily), ov["output_tokens"], 0)
check("sum(/daily cache_read) == overview cache_read",
      sum(d["cache_read_tokens"] for d in daily), ov["cache_read_tokens"], 0)

projects = get("/projects?" + UNTIL)
check("sum(/projects cost) == overview cost", sum(p["cost_usd"] for p in projects), ov["cost_usd"])
check("sum(/projects billable) == overview billable",
      sum(p["billable_tokens"] for p in projects),
      ov["input_tokens"] + ov["output_tokens"] + ov["cache_create_5m_tokens"] + ov["cache_create_1h_tokens"], 0)

bym = get("/by-model?" + UNTIL)
check("sum(/by-model cost) == overview cost", sum(m["cost_usd"] or 0 for m in bym), ov["cost_usd"])

print("\n=== /daily sessions + prompts columns ===")
d_sess = sum(d["sessions"] for d in daily)
sql_sess = c.execute("""SELECT SUM(n) FROM (SELECT COUNT(DISTINCT session_id) n
    FROM messages WHERE timestamp IS NOT NULL AND timestamp < :cut
     GROUP BY substr(timestamp,1,10))""", CUT).fetchone()[0]
check("sum(/daily sessions) == per-day distinct sessions", d_sess, sql_sess, 0)
print("         (note: a session spanning midnight counts in both days, by design)")
check("sum(/daily prompts) == overview prompts",
      sum(d["turns"] for d in daily), ov["turns"], 0)

print("\n=== prompt attribution (turn windows) ===")
pr = get("/savings/breakdown?of=spend")["prompts"]  # uncapped up to PROMPT_POOL
# The prompt endpoints have no `until`, so both sides are simply read late and
# compared with a tolerance for what arrived in between.
n_prompts = c.execute(
    "SELECT COUNT(*) FROM messages WHERE type='user' AND prompt_text IS NOT NULL").fetchone()[0]
check("every typed prompt is attributed", len(pr), n_prompts, 0.01)
assistant_turns = c.execute("SELECT COUNT(*) FROM messages WHERE type='assistant'").fetchone()[0]
attributed = sum(p["turns"] for p in pr)
print(f"  info  assistant turns={assistant_turns}  attributed to a prompt={attributed}"
      f"  orphaned={assistant_turns - attributed}")
print("         (orphans = turns before the first typed prompt of a session, e.g. a resumed session)")
check("sum(prompt cost) <= overview cost", 1 if sum(p["cost_usd"] for p in pr) <= ov["cost_usd"] * 1.001 else 0, 1, 0)

print("\n=== savings drill-down reconciles with its headline ===")
sv = get("/savings")
bd_c = get("/savings/breakdown?of=caching")
bd_s = get("/savings/breakdown?of=spend")
check("sessions caching total ~ headline exact", bd_c["session_total"], sv["headline"]["exact_usd"], 0.03)
check("sessions spend total ~ claude spend", bd_s["session_total"], sv["spend"]["claude_usd"], 0.03)
check("prompt count == session-side prompt count", len(bd_c["prompts"]), len(bd_s["prompts"]), 0)

print("\n=== tools & skills ===")
tools = get("/tools")
sql_tools = c.execute(
    "SELECT COUNT(*) FROM tool_calls WHERE tool_name != '_tool_result'").fetchone()[0]
check("sum(/tools calls) == tool_calls rows", sum(t["calls"] for t in tools), sql_tools, 0.01)
skills = get("/skills")
sql_skills = c.execute(
    "SELECT COUNT(*) FROM tool_calls WHERE tool_name='Skill' AND target IS NOT NULL AND target!=''").fetchone()[0]
check("sum(/skills invocations) == Skill calls", sum(s["invocations"] for s in skills), sql_skills, 0.01)

print("\n=== breakdown endpoints agree with the charts they open ===")
day = daily[len(daily) // 2]["day"]
bd = get("/breakdown?by=day&key=" + day)
check(f"day {day}: models cost == /daily cost",
      sum(m["cost_usd"] for m in bd["models"]), next(d["cost_usd"] for d in daily if d["day"] == day))
check(f"day {day}: projects cost == models cost",
      sum(p["cost_usd"] for p in bd["projects"]), sum(m["cost_usd"] for m in bd["models"]))

top_model = max(bym, key=lambda m: m["cost_usd"] or 0)["model"]
md = get("/breakdown?by=model&key=" + urllib.parse.quote(top_model))
check(f"model {top_model}: projects == days",
      sum(p["cost_usd"] for p in md["projects"]), sum(x["cost_usd"] for x in md["days"]))
check(f"model {top_model}: total == /by-model",
      sum(p["cost_usd"] for p in md["projects"]),
      next(m["cost_usd"] for m in bym if m["model"] == top_model))

top_tool = tools[0]["tool_name"]
td = get("/breakdown?by=tool&key=" + urllib.parse.quote(top_tool))
check(f"tool {top_tool}: projects == all-time total",
      sum(p["calls"] for p in td["projects"]), td["totals"]["calls"], 0)

print("\n" + ("ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILED: " + ", ".join(fails)))

sys.exit(1 if fails else 0)
