"""Codex (OpenAI) rollout-log scanner.

Claude Code's transcripts record that a `codex exec` Bash call happened, not
what it cost — the tokens are spent inside a separate process. Codex keeps its
own logs at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, so skills that
delegate to it (`/grill-me-codex`, `/codex-review`, `/cloneify`) are only
visible if we read those too.

Three line types matter:
  session_meta  -> session_id, cwd, originator, start timestamp
  turn_context  -> model (e.g. gpt-5.5); repeated per turn
  event_msg     -> payload.type == "token_count", carrying a RUNNING TOTAL

`total_token_usage` is cumulative for the session, so the last one wins — do
not sum them. `input_tokens` includes `cached_input_tokens`, and
`output_tokens` includes `reasoning_output_tokens`; both are stored as
reported and split at pricing time.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional, Union

from .db import connect, slug_for_cwd

INSERT_CODEX = """
INSERT OR REPLACE INTO codex_sessions (
  session_id, path, cwd, project_slug, model, originator, started, ended, turns,
  input_tokens, cached_input_tokens, output_tokens, reasoning_tokens
) VALUES (
  :session_id, :path, :cwd, :project_slug, :model, :originator, :started, :ended, :turns,
  :input_tokens, :cached_input_tokens, :output_tokens, :reasoning_tokens
)
"""


def default_sessions_dir() -> Path:
    return Path.home() / ".codex" / "sessions"


def parse_rollout(path: Union[str, Path]) -> Optional[dict]:
    """Parse one rollout file into a session row, or None if it has no usage."""
    path = Path(path)
    session_id = model = cwd = originator = started = None
    ended = None
    turns = 0
    usage = None

    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue  # a partially-flushed final line; the rest still counts
            kind = rec.get("type")
            payload = rec.get("payload") or {}
            ts = rec.get("timestamp")
            if ts:
                ended = ts
                if started is None:
                    started = ts

            if kind == "session_meta":
                session_id = payload.get("session_id") or payload.get("id") or session_id
                cwd = payload.get("cwd") or cwd
                originator = payload.get("originator") or originator
            elif kind == "turn_context":
                model = payload.get("model") or model
                cwd = payload.get("cwd") or cwd
                turns += 1
            elif kind == "event_msg" and payload.get("type") == "token_count":
                total = (payload.get("info") or {}).get("total_token_usage")
                if total:
                    usage = total  # cumulative — keep the last, never sum

    if usage is None:
        return None
    if not session_id:
        session_id = path.stem  # rollout-<ts>-<uuid>; unique enough to key on

    return {
        "session_id": session_id,
        "path": str(path),
        "cwd": cwd,
        "project_slug": slug_for_cwd(cwd),
        "model": model,
        "originator": originator,
        "started": started,
        "ended": ended,
        "turns": turns,
        "input_tokens": int(usage.get("input_tokens") or 0),
        "cached_input_tokens": int(usage.get("cached_input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "reasoning_tokens": int(usage.get("reasoning_output_tokens") or 0),
    }


def scan_codex(sessions_dir: Union[str, Path, None], db_path) -> dict:
    """Walk the rollout logs and upsert one row per session.

    Full re-parse every time, unlike the Claude scanner's byte-offset resume:
    the usage figure is a running total that only means anything as the last
    one in the file, so there is no safe midpoint to resume from. Cheap in
    practice — these files are few and small next to the Claude transcripts.
    """
    root = Path(sessions_dir or default_sessions_dir())
    if not root.exists():
        return {"files": 0, "sessions": 0}

    rows = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            if not name.endswith(".jsonl"):
                continue
            row = parse_rollout(Path(dirpath) / name)
            if row:
                rows.append(row)

    if rows:
        with connect(db_path) as c:
            c.executemany(INSERT_CODEX, rows)
            c.commit()
    return {"files": len(rows), "sessions": len({r["session_id"] for r in rows})}


def codex_breakdown(db_path, since=None, until=None) -> list:
    """Per-model Codex usage, in the same shape `cost_for` expects.

    OpenAI reports `input_tokens` inclusive of the cached portion and bills the
    two at different rates, so the uncached remainder goes in `input_tokens`
    and the cached part in `cache_read_tokens` — the same slots the Claude side
    uses, so one pricing path covers both. There is no cache-write charge.
    """
    where, args = [], []
    if since:
        where.append("ended >= ?"); args.append(since)
    if until:
        where.append("ended < ?"); args.append(until)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    sql = f"""
      SELECT COALESCE(model, 'unknown') AS model,
             COUNT(*) AS sessions,
             COALESCE(SUM(turns), 0) AS turns,
             COALESCE(SUM(input_tokens), 0)        AS raw_input_tokens,
             COALESCE(SUM(cached_input_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(output_tokens), 0)       AS output_tokens,
             COALESCE(SUM(reasoning_tokens), 0)    AS reasoning_tokens
        FROM codex_sessions{clause}
       GROUP BY model
       ORDER BY (raw_input_tokens + output_tokens) DESC
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, args)]
    for r in rows:
        r["input_tokens"] = max(0, r.pop("raw_input_tokens") - r["cache_read_tokens"])
        r["cache_create_5m_tokens"] = 0
        r["cache_create_1h_tokens"] = 0
    return rows


def codex_totals(db_path, since=None, until=None) -> dict:
    """Roll `codex_breakdown` up into one set of figures."""
    rows = codex_breakdown(db_path, since, until)
    out = {
        "sessions": 0, "turns": 0, "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "reasoning_tokens": 0,
    }
    for r in rows:
        for k in out:
            out[k] += r.get(k, 0)
    out["billable_tokens"] = out["input_tokens"] + out["output_tokens"]
    out["models"] = sorted({r["model"] for r in rows})
    return out
