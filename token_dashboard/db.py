"""SQLite schema, connection, and shared query helpers."""
from __future__ import annotations

import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Union

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  mtime       REAL    NOT NULL,
  bytes_read  INTEGER NOT NULL,
  scanned_at  REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  uuid                    TEXT PRIMARY KEY,
  parent_uuid             TEXT,
  session_id              TEXT NOT NULL,
  project_slug            TEXT NOT NULL,
  cwd                     TEXT,
  git_branch              TEXT,
  cc_version              TEXT,
  entrypoint              TEXT,
  type                    TEXT NOT NULL,
  is_sidechain            INTEGER NOT NULL DEFAULT 0,
  agent_id                TEXT,
  timestamp               TEXT NOT NULL,
  model                   TEXT,
  stop_reason             TEXT,
  prompt_id               TEXT,
  message_id              TEXT,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_create_5m_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_create_1h_tokens  INTEGER NOT NULL DEFAULT 0,
  prompt_text             TEXT,
  prompt_chars            INTEGER,
  tool_calls_json         TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_project   ON messages(project_slug);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_model     ON messages(model);
CREATE INDEX IF NOT EXISTS idx_messages_msgid     ON messages(session_id, message_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uuid  TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  project_slug  TEXT    NOT NULL,
  tool_name     TEXT    NOT NULL,
  target        TEXT,
  result_tokens INTEGER,
  is_error      INTEGER NOT NULL DEFAULT 0,
  timestamp     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tools_name    ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_target  ON tool_calls(target);

-- Codex (OpenAI) sessions, from ~/.codex/sessions/**/rollout-*.jsonl. Kept in
-- their own table rather than folded into `messages`: that schema and its
-- (session_id, message_id) dedup key are shaped around Claude Code's streaming
-- snapshots, and Codex writes one cumulative running total instead. One row
-- per rollout file. `input_tokens` is inclusive of `cached_input_tokens`, and
-- `output_tokens` is inclusive of `reasoning_output_tokens` — both as OpenAI
-- reports them; split them at pricing time, not here.
CREATE TABLE IF NOT EXISTS codex_sessions (
  session_id             TEXT PRIMARY KEY,
  path                   TEXT NOT NULL,
  cwd                    TEXT,
  project_slug           TEXT NOT NULL,
  model                  TEXT,
  originator             TEXT,
  started                TEXT,
  ended                  TEXT,
  turns                  INTEGER NOT NULL DEFAULT 0,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_codex_ended   ON codex_sessions(ended);
CREATE INDEX IF NOT EXISTS idx_codex_project ON codex_sessions(project_slug);
CREATE INDEX IF NOT EXISTS idx_codex_model   ON codex_sessions(model);

CREATE TABLE IF NOT EXISTS plan (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS dismissed_tips (
  tip_key       TEXT PRIMARY KEY,
  dismissed_at  REAL NOT NULL
);

-- What the human calls a detected step-change. The scanner can see that reads
-- of a file fell off a cliff on the 26th; only the human knows that was
-- "split living-system.md out of CLAUDE.md". Keyed by the detector's stable
-- change key so a label survives rescans.
CREATE TABLE IF NOT EXISTS optimization_labels (
  change_key  TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  noted_at    REAL NOT NULL
);
"""


def default_db_path() -> Path:
    return Path.home() / ".claude" / "token-dashboard.db"


def init_db(path: Union[str, Path]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as c:
        _migrate_add_message_id(c)
        c.executescript(SCHEMA)


def _migrate_add_message_id(conn) -> None:
    """Add messages.message_id for streaming-snapshot dedup.

    Why: pre-migration rows were summed from all streaming snapshots (over-count).
    How to apply: if the old table exists without the column, add it and clear
    messages/tool_calls/files so the next scan replays JSONLs cleanly. Source
    of truth is on disk; rescanning is cheap.
    """
    has_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'"
    ).fetchone()
    if not has_table:
        return
    cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
    if "message_id" in cols:
        return
    conn.execute("ALTER TABLE messages ADD COLUMN message_id TEXT")
    conn.execute("DELETE FROM messages")
    conn.execute("DELETE FROM tool_calls")
    conn.execute("DELETE FROM files")
    conn.commit()


@contextmanager
def connect(path: Union[str, Path]):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def _range_clause(since, until, col: str = "timestamp"):
    where, args = [], []
    if since:
        where.append(f"{col} >= ?"); args.append(since)
    if until:
        where.append(f"{col} < ?"); args.append(until)
    return ((" AND " + " AND ".join(where)) if where else "", args)


def _encode_slug(path: str) -> str:
    """Claude Code's project-slug encoding: each of `:`, `\\`, `/`, space → one `-`."""
    return re.sub(r"[:\\/ ]", "-", path)


def _walk_to_root(cwd: str, slug: str) -> Optional[str]:
    """If any ancestor of cwd encodes to slug, return that ancestor's basename."""
    if not cwd or not slug:
        return None
    trimmed = cwd.rstrip("/\\")
    sep = "\\" if "\\" in trimmed else "/"
    parts = trimmed.split(sep)
    for i in range(len(parts), 0, -1):
        if _encode_slug(sep.join(parts[:i])) == slug:
            name = parts[i - 1]
            if name:
                return name
    return None


def slug_for_cwd(cwd: Optional[str]) -> str:
    """Project slug for a working directory, using Claude Code's own encoding.

    Claude Code derives its `~/.claude/projects/<slug>` directory names this
    way, so a Codex session run from the same directory lands on the same slug
    and the two sources line up per project for free.
    """
    return _encode_slug((cwd or "").rstrip("/\\"))


def project_name_for(cwd: Optional[str], fallback_slug: str) -> str:
    """Pretty project name from a single cwd + slug (best-effort).

    For the multi-cwd case, prefer `best_project_name`.
    """
    name = _walk_to_root(cwd or "", fallback_slug or "")
    if name:
        return name
    if cwd:
        trimmed = cwd.rstrip("/\\")
        sep = "\\" if "\\" in trimmed else "/"
        tail = trimmed.split(sep)[-1]
        if tail:
            return tail
    if fallback_slug:
        parts = [p for p in re.split(r"-+", fallback_slug) if p]
        if parts:
            return parts[-1]
    return fallback_slug or ""


def best_project_name(cwds, slug: str) -> str:
    """Pick a pretty name from a list of cwds.

    Prefer a cwd whose walk-up matches `slug` (a true descendant of the project
    root). If none match, fall back to `project_name_for` on the first cwd,
    then to the slug's last segment.
    """
    cwds = [c for c in (cwds or []) if c]
    for cwd in cwds:
        name = _walk_to_root(cwd, slug)
        if name:
            return name
    return project_name_for(cwds[0] if cwds else None, slug)


# A "turn" is a prompt YOU typed. Claude Code writes tool results as
# `type: "user"` rows too, so counting every user row inflates the figure by
# roughly 8x — 40,274 user rows in one real history, of which only 5,094 were
# actual prompts. `prompt_text` is populated only for the real ones, which is
# what `expensive_prompts` has always keyed off.
TURNS = "SUM(CASE WHEN type='user' AND prompt_text IS NOT NULL THEN 1 ELSE 0 END)"


def overview_totals(db_path, since=None, until=None) -> dict:
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT COUNT(DISTINCT session_id) AS sessions,
             SUM(CASE WHEN type='user' AND prompt_text IS NOT NULL THEN 1 ELSE 0 END) AS turns,
             COALESCE(SUM(input_tokens),0)            AS input_tokens,
             COALESCE(SUM(output_tokens),0)           AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages WHERE 1=1 {rng}
    """
    with connect(db_path) as c:
        return dict(c.execute(sql, args).fetchone())


def expensive_prompts(db_path, limit: int = 50, sort: str = "tokens") -> list:
    """User prompt joined with the immediately-following assistant turn's tokens.

    sort="tokens" (default) → largest billable first.
    sort="recent"           → newest first.
    """
    order = "u.timestamp DESC" if sort == "recent" else "billable_tokens DESC"
    sql = f"""
      SELECT u.uuid AS user_uuid, u.session_id, u.project_slug, u.timestamp,
             u.prompt_text, u.prompt_chars,
             a.uuid AS assistant_uuid, a.model,
             COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0)
               +COALESCE(a.cache_create_5m_tokens,0)+COALESCE(a.cache_create_1h_tokens,0) AS billable_tokens,
             COALESCE(a.cache_read_tokens,0) AS cache_read_tokens
        FROM messages u
        JOIN messages a ON a.parent_uuid = u.uuid AND a.type='assistant'
       WHERE u.type='user' AND u.prompt_text IS NOT NULL
       ORDER BY {order}
       LIMIT ?
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, (limit,))]


def project_summary(db_path, since=None, until=None) -> list:
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT project_slug,
             COUNT(DISTINCT session_id) AS sessions,
             SUM(CASE WHEN type='user' AND prompt_text IS NOT NULL THEN 1 ELSE 0 END) AS turns,
             COALESCE(SUM(input_tokens), 0)  AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             SUM(input_tokens)+SUM(output_tokens)
               +SUM(cache_create_5m_tokens)+SUM(cache_create_1h_tokens) AS billable_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens
        FROM messages m
       WHERE 1=1 {rng}
       GROUP BY project_slug
       ORDER BY billable_tokens DESC
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, args)]
        for r in rows:
            cwds = [row["cwd"] for row in c.execute(
                "SELECT DISTINCT cwd FROM messages WHERE project_slug=? AND cwd IS NOT NULL",
                (r["project_slug"],),
            )]
            r["project_name"] = best_project_name(cwds, r["project_slug"])
    return rows


def tool_token_breakdown(db_path, since=None, until=None) -> list:
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT tool_name,
             COUNT(*) AS calls,
             COALESCE(SUM(result_tokens),0) AS result_tokens
        FROM tool_calls
       WHERE tool_name != '_tool_result' {rng}
       GROUP BY tool_name
       ORDER BY calls DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, args)]


def recent_sessions(db_path, limit: int = 20, since=None, until=None) -> list:
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT session_id, project_slug,
             MIN(timestamp) AS started, MAX(timestamp) AS ended,
             SUM(CASE WHEN type='user' AND prompt_text IS NOT NULL THEN 1 ELSE 0 END) AS turns,
             SUM(input_tokens)+SUM(output_tokens) AS tokens
        FROM messages m
       WHERE 1=1 {rng}
       GROUP BY session_id
       ORDER BY ended DESC
       LIMIT ?
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, (*args, limit))]
        # Cache per-slug name lookups so we don't query once per session.
        slug_cache = {}
        for r in rows:
            slug = r["project_slug"]
            if slug not in slug_cache:
                cwds = [row["cwd"] for row in c.execute(
                    "SELECT DISTINCT cwd FROM messages WHERE project_slug=? AND cwd IS NOT NULL",
                    (slug,),
                )]
                slug_cache[slug] = best_project_name(cwds, slug)
            r["project_name"] = slug_cache[slug]
    return rows


def session_turns(db_path, session_id: str) -> list:
    sql = """
      SELECT uuid, parent_uuid, type, timestamp, model, is_sidechain, agent_id,
             input_tokens, output_tokens, cache_read_tokens,
             cache_create_5m_tokens, cache_create_1h_tokens,
             prompt_text, prompt_chars, tool_calls_json, project_slug, cwd
        FROM messages
       WHERE session_id = ?
       ORDER BY timestamp ASC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, (session_id,))]


def daily_token_breakdown(db_path, since=None, until=None) -> list:
    """One row per day: tokens, plus the session and prompt counts.

    The counts are here rather than in a second query because every stat tile on
    the overview draws a sparkline from this one response — a tile that shows a
    total with no trend under it, next to five that have one, reads as broken.
    """
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT substr(timestamp, 1, 10) AS day,
             COUNT(DISTINCT session_id) AS sessions,
             SUM(CASE WHEN type='user' AND prompt_text IS NOT NULL THEN 1 ELSE 0 END) AS turns,
             COALESCE(SUM(input_tokens),0)      AS input_tokens,
             COALESCE(SUM(output_tokens),0)     AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)
               + COALESCE(SUM(cache_create_1h_tokens),0) AS cache_create_tokens
        FROM messages
       WHERE timestamp IS NOT NULL {rng}
       GROUP BY day
       ORDER BY day ASC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, args)]


def skill_breakdown(db_path, since=None, until=None) -> list:
    """Per-skill invocation counts, distinct sessions, last-used timestamp.

    Token attribution per skill is not included: in Claude Code, a Skill's
    content is loaded via a system-reminder on the next turn, not as the
    tool_result body — so `result_tokens` on _tool_result rows reflects the
    activation ack (tiny), not the skill definition (which is what actually
    fills context). A future schema change (storing tool_use_id on the
    invocation row) could enable precise attribution; for now we only expose
    the reliable counts.
    """
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT target AS skill,
             COUNT(*) AS invocations,
             COUNT(DISTINCT session_id) AS sessions,
             MAX(timestamp) AS last_used
        FROM tool_calls
       WHERE tool_name = 'Skill' AND target IS NOT NULL AND target != '' {rng}
       GROUP BY target
       ORDER BY invocations DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, args)]


def model_breakdown(db_path, since=None, until=None) -> list:
    """Per-model token totals + turn count. Caller computes cost via pricing."""
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT COALESCE(model, 'unknown') AS model,
             COUNT(*) AS turns,
             COALESCE(SUM(input_tokens),0)            AS input_tokens,
             COALESCE(SUM(output_tokens),0)           AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages
       WHERE type = 'assistant' {rng}
       GROUP BY model
       ORDER BY (input_tokens + output_tokens + cache_create_5m_tokens + cache_create_1h_tokens) DESC
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, args)]


def _grouped_model_breakdown(db_path, key_col, key_alias, since, until, where) -> list:
    """Per-(something, model) token totals, shaped for `cost_for`.

    A day's tokens cannot be priced without the model split: a day of Haiku and
    a day of Opus with identical token counts are an order of magnitude apart.
    Same for a project. So anywhere a cost is wanted per bucket, the bucket has
    to be broken down by model first and summed after pricing.
    """
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT {key_col} AS {key_alias},
             COALESCE(model, 'unknown') AS model,
             COALESCE(SUM(input_tokens),0)            AS input_tokens,
             COALESCE(SUM(output_tokens),0)           AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
        FROM messages
       WHERE type = 'assistant' {where} {rng}
       GROUP BY {key_alias}, model
    """
    with connect(db_path) as c:
        return [dict(r) for r in c.execute(sql, args)]


_TOKEN_SUMS = """
             COALESCE(SUM(input_tokens),0)            AS input_tokens,
             COALESCE(SUM(output_tokens),0)           AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
             COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
             COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
"""


def _resolve_names(c, rows):
    """Fill project_name from the cwds seen for each slug, one query per slug."""
    cache = {}
    for r in rows:
        slug = r.get("project_slug")
        if slug is None:
            continue
        if slug not in cache:
            cwds = [row["cwd"] for row in c.execute(
                "SELECT DISTINCT cwd FROM messages WHERE project_slug=? AND cwd IS NOT NULL",
                (slug,),
            )]
            cache[slug] = best_project_name(cwds, slug)
        r["project_name"] = cache[slug]
    return rows


def day_detail(db_path, day: str) -> dict:
    """Everything that made one day cost what it did.

    The overview's cost line invites exactly one question — "why was that
    Tuesday $700?" — and until this existed the chart could not answer it.
    Model and project rows carry raw token columns so the caller can price them;
    tools and sessions are counts, which need no pricing.
    """
    like = day + "%"
    with connect(db_path) as c:
        models = [dict(r) for r in c.execute(f"""
            SELECT COALESCE(model,'unknown') AS model, COUNT(*) AS turns, {_TOKEN_SUMS}
              FROM messages
             WHERE type='assistant' AND timestamp LIKE ?
             GROUP BY model
        """, (like,))]
        # Split by model as well as project: a project's cost can't be derived
        # from its token total alone, since the rate depends on which model
        # spent them. The caller prices each row and folds them together.
        projects = [dict(r) for r in c.execute(f"""
            SELECT project_slug, COALESCE(model,'unknown') AS model, {_TOKEN_SUMS}
              FROM messages
             WHERE type='assistant' AND timestamp LIKE ?
             GROUP BY project_slug, model
        """, (like,))]
        _resolve_names(c, projects)
        tools = [dict(r) for r in c.execute("""
            SELECT tool_name, COUNT(*) AS calls,
                   COALESCE(SUM(result_tokens),0) AS result_tokens
              FROM tool_calls
             WHERE tool_name != '_tool_result' AND timestamp LIKE ?
             GROUP BY tool_name ORDER BY calls DESC LIMIT 8
        """, (like,))]
        sessions = [dict(r) for r in c.execute("""
            SELECT session_id, project_slug,
                   MIN(timestamp) AS started,
                   SUM(CASE WHEN type='user' AND prompt_text IS NOT NULL THEN 1 ELSE 0 END) AS turns,
                   COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0)
                     +COALESCE(SUM(cache_create_5m_tokens),0)
                     +COALESCE(SUM(cache_create_1h_tokens),0) AS billable_tokens
              FROM messages
             WHERE timestamp LIKE ?
             GROUP BY session_id
             ORDER BY billable_tokens DESC LIMIT 8
        """, (like,))]
        _resolve_names(c, sessions)
    return {"day": day, "models": models, "projects": projects,
            "tools": tools, "sessions": sessions}


def model_detail(db_path, model: str, since=None, until=None) -> dict:
    """One model's spend, split by project and by day."""
    rng, args = _range_clause(since, until)
    with connect(db_path) as c:
        projects = [dict(r) for r in c.execute(f"""
            SELECT project_slug, COALESCE(model,'unknown') AS model,
                   COUNT(*) AS turns, {_TOKEN_SUMS}
              FROM messages
             WHERE type='assistant' AND COALESCE(model,'unknown')=? {rng}
             GROUP BY project_slug
        """, (model, *args))]
        _resolve_names(c, projects)
        days = [dict(r) for r in c.execute(f"""
            SELECT substr(timestamp,1,10) AS day, COALESCE(model,'unknown') AS model,
                   COUNT(*) AS turns, {_TOKEN_SUMS}
              FROM messages
             WHERE type='assistant' AND COALESCE(model,'unknown')=?
               AND timestamp IS NOT NULL {rng}
             GROUP BY day ORDER BY day ASC
        """, (model, *args))]
    return {"model": model, "projects": projects, "days": days}


def tool_detail(db_path, tool: str, since=None, until=None) -> dict:
    """One tool's usage, split by project and by day. Calls, not cost.

    A tool call's token cost isn't recorded against the call, so pricing one
    would mean inventing a number — the same reason the savings page refuses to
    put a dollar figure on a file read.
    """
    rng, args = _range_clause(since, until)
    with connect(db_path) as c:
        projects = [dict(r) for r in c.execute(f"""
            SELECT project_slug, COUNT(*) AS calls,
                   COALESCE(SUM(result_tokens),0) AS result_tokens
              FROM tool_calls
             WHERE tool_name=? {rng}
             GROUP BY project_slug ORDER BY calls DESC LIMIT 10
        """, (tool, *args))]
        _resolve_names(c, projects)
        days = [dict(r) for r in c.execute(f"""
            SELECT substr(timestamp,1,10) AS day, COUNT(*) AS calls,
                   COALESCE(SUM(result_tokens),0) AS result_tokens
              FROM tool_calls
             WHERE tool_name=? AND timestamp IS NOT NULL {rng}
             GROUP BY day ORDER BY day ASC
        """, (tool, *args))]
        totals = dict(c.execute("""
            SELECT COUNT(*) AS calls,
                   COALESCE(SUM(result_tokens),0) AS result_tokens,
                   COUNT(DISTINCT session_id) AS sessions
              FROM tool_calls WHERE tool_name=?
        """, (tool,)).fetchone())
    return {"tool": tool, "projects": projects, "days": days, "totals": totals}


def session_model_rows(db_path, since=None, until=None) -> list:
    """(session, model) token sums — the grain a session's cost can be priced at.

    Returned for every session rather than a top-N, because "top" here means top
    by cost, and cost isn't known until after pricing. A few thousand rows is
    cheap; guessing the ranking beforehand is not.
    """
    rng, args = _range_clause(since, until)
    sql = f"""
      SELECT session_id, project_slug, COALESCE(model,'unknown') AS model,
             MIN(timestamp) AS started, {_TOKEN_SUMS}
        FROM messages
       WHERE type='assistant' {rng}
       GROUP BY session_id, model
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, args)]
        _resolve_names(c, rows)
    return rows


# Each stat tile on the overview can be opened. The value is a SQL expression
# and `rows` says which messages it is summed over — counting prompts over
# assistant rows, or output tokens over user rows, would both be nonsense.
METRICS = {
    "sessions":     {"expr": "COUNT(DISTINCT session_id)", "rows": "all",       "label": "sessions"},
    "turns":        {"expr": "COUNT(*)",                   "rows": "prompts",   "label": "prompts"},
    "input":        {"expr": "SUM(input_tokens)",          "rows": "assistant", "label": "input tokens"},
    "output":       {"expr": "SUM(output_tokens)",         "rows": "assistant", "label": "output tokens"},
    "cache_read":   {"expr": "SUM(cache_read_tokens)",     "rows": "assistant", "label": "cache read tokens"},
    "cache_create": {"expr": "SUM(cache_create_5m_tokens)+SUM(cache_create_1h_tokens)",
                     "rows": "assistant", "label": "cache create tokens"},
}

_ROW_FILTER = {
    "all": "",
    "assistant": "AND type='assistant'",
    "prompts": "AND type='user' AND prompt_text IS NOT NULL",
}


def current_window(db_path, hours: int = 5) -> list:
    """Per-model usage inside the rolling window Claude Code meters you on.

    The caller prices it. There is deliberately no "remaining" figure: your cap
    is never written to disk — `/status` asks Anthropic for it live — so any
    percentage here would be a guess dressed as a measurement.
    """
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")
    sql = f"""
      SELECT COALESCE(model,'unknown') AS model, COUNT(*) AS turns, {_TOKEN_SUMS}
        FROM messages
       WHERE type='assistant' AND timestamp >= ?
       GROUP BY model
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, (since,))]
        prompts = c.execute(
            "SELECT COUNT(*) FROM messages WHERE type='user' AND prompt_text IS NOT NULL"
            " AND timestamp >= ?", (since,)).fetchone()[0]
        first = c.execute(
            "SELECT MIN(timestamp) FROM messages WHERE timestamp >= ?", (since,)).fetchone()[0]
    return [{"since": since, "hours": hours, "prompts": prompts, "first_activity": first}, rows]


def metric_detail(db_path, metric: str, since=None, until=None) -> dict:
    """One stat tile, opened: the same number split by project, day and model.

    `sessions` and `prompts` get no model split on purpose — a typed prompt has
    no model attached, and attributing one would mean guessing which model
    happened to answer it.
    """
    m = METRICS[metric]
    rng, args = _range_clause(since, until)
    where = f"WHERE 1=1 {_ROW_FILTER[m['rows']]} {rng}"

    def grouped(select, group, extra=""):
        sql = f"SELECT {select}, {m['expr']} AS value FROM messages {where} {extra} GROUP BY {group}"
        return [dict(r) for r in c.execute(sql, args)]

    with connect(db_path) as c:
        projects = [r for r in grouped("project_slug", "project_slug") if r["value"]]
        projects.sort(key=lambda r: r["value"], reverse=True)
        _resolve_names(c, projects)

        days = [r for r in grouped("substr(timestamp,1,10) AS day", "day",
                                   extra="AND timestamp IS NOT NULL") if r["value"]]
        days.sort(key=lambda r: r["day"])

        models = []
        if m["rows"] == "assistant":
            models = [r for r in grouped("COALESCE(model,'unknown') AS model", "model") if r["value"]]
            models.sort(key=lambda r: r["value"], reverse=True)

        sessions = [dict(r) for r in c.execute(
            f"""SELECT session_id, project_slug, MIN(timestamp) AS started,
                       {m['expr']} AS value
                  FROM messages {where}
                 GROUP BY session_id ORDER BY value DESC LIMIT 12""", args)]
        sessions = [s for s in sessions if s["value"]]
        _resolve_names(c, sessions)

    return {"metric": metric, "label": m["label"], "projects": projects,
            "days": days, "models": models, "sessions": sessions,
            "total": sum(d["value"] for d in days)}


def prompt_costs(db_path, since=None, until=None) -> list:
    """Every typed prompt, with the tokens of all the work it set off.

    Attribution is by **turn window**: a prompt owns every assistant turn that
    follows it in its session until the next typed prompt. That is what someone
    means by "what did this prompt cost" — a prompt that triggers a twenty-tool
    agent run costs all twenty turns, not just the first reply.

    It deliberately does not follow `parent_uuid`. That chain cannot do the job:
    in a real database 20,598 of 34,586 assistant rows point at a uuid that
    isn't stored at all (streaming snapshots get evicted by the dedup, and not
    every attachment or tool result is kept), and of the ones that do resolve
    almost all land on a tool-result row rather than a typed prompt. The old
    join matched 257 of 34,586 turns — a 0.7% sample that looked like a ranking
    and wasn't one.

    Returns one row per (prompt, model), since a single window can span models
    and cost can only be computed per model. The caller prices and folds.
    """
    rng, args = _range_clause(since, until)
    sql = f"""
      WITH ordered AS (
        SELECT session_id, project_slug, uuid, type, timestamp, prompt_text, model,
               COALESCE(input_tokens,0)            AS i,
               COALESCE(output_tokens,0)           AS o,
               COALESCE(cache_read_tokens,0)       AS cr,
               COALESCE(cache_create_5m_tokens,0)  AS c5,
               COALESCE(cache_create_1h_tokens,0)  AS c1,
               SUM(CASE WHEN type='user' AND prompt_text IS NOT NULL THEN 1 ELSE 0 END)
                 OVER (PARTITION BY session_id ORDER BY timestamp, uuid
                       ROWS UNBOUNDED PRECEDING) AS grp
          FROM messages
         WHERE 1=1 {rng}
      ),
      heads AS (
        SELECT session_id, project_slug, grp, uuid, timestamp, prompt_text
          FROM ordered WHERE type='user' AND prompt_text IS NOT NULL
      ),
      work AS (
        SELECT session_id, grp, COALESCE(model,'unknown') AS model,
               COUNT(*) AS turns,
               SUM(i) AS input_tokens, SUM(o) AS output_tokens,
               SUM(cr) AS cache_read_tokens,
               SUM(c5) AS cache_create_5m_tokens, SUM(c1) AS cache_create_1h_tokens
          FROM ordered WHERE type='assistant' GROUP BY session_id, grp, model
      )
      -- LEFT, not INNER: a prompt that set nothing off still happened, and
      -- dropping it silently makes the list shorter than the prompt count on
      -- every other screen. It comes back with zeroes and costs nothing.
      SELECT h.uuid AS prompt_uuid, h.session_id, h.project_slug,
             h.timestamp, h.prompt_text,
             COALESCE(w.model, 'none')       AS model,
             COALESCE(w.turns, 0)            AS turns,
             COALESCE(w.input_tokens, 0)     AS input_tokens,
             COALESCE(w.output_tokens, 0)    AS output_tokens,
             COALESCE(w.cache_read_tokens, 0) AS cache_read_tokens,
             COALESCE(w.cache_create_5m_tokens, 0) AS cache_create_5m_tokens,
             COALESCE(w.cache_create_1h_tokens, 0) AS cache_create_1h_tokens
        FROM heads h
        LEFT JOIN work w ON w.session_id = h.session_id AND w.grp = h.grp
    """
    with connect(db_path) as c:
        rows = [dict(r) for r in c.execute(sql, args)]
        _resolve_names(c, rows)
    return rows


def daily_model_breakdown(db_path, since=None, until=None) -> list:
    """One row per (day, model). Caller prices each and sums per day."""
    return _grouped_model_breakdown(
        db_path, "substr(timestamp, 1, 10)", "day", since, until,
        "AND timestamp IS NOT NULL",
    )


def project_model_breakdown(db_path, since=None, until=None) -> list:
    """One row per (project_slug, model). Caller prices each and sums."""
    return _grouped_model_breakdown(
        db_path, "project_slug", "project_slug", since, until, "",
    )
