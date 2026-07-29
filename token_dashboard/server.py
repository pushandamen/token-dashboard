"""HTTP server: static frontend + JSON endpoints + SSE diff stream."""
from __future__ import annotations

import http.server
import json
import mimetypes
import queue
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from .db import (
    overview_totals, project_summary,
    tool_token_breakdown, recent_sessions, session_turns,
    daily_token_breakdown, model_breakdown, skill_breakdown,
    daily_model_breakdown, project_model_breakdown,
    day_detail, model_detail, tool_detail,
    session_model_rows, prompt_costs, metric_detail, METRICS, current_window,
)
from .pricing import load_pricing, cost_for, get_plan, plan_is_set, set_plan, total_cost
from .savings import build_savings, set_label
from .tips import all_tips, dismiss_tip
from .scanner import scan_dir
from .codex import scan_codex
from .skills import cached_catalog


WEB_ROOT = Path(__file__).resolve().parent.parent / "web"
PRICING_JSON = Path(__file__).resolve().parent.parent / "pricing.json"

# One queue per connected client, not one queue for the server. A single shared
# queue is consumed by whichever stream handler reaches it first, so with two
# tabs open they steal each other's events and neither updates reliably — and
# with one tab, anything else listening (a probe, a second window) silently
# swallows the notification. Events are broadcast to every subscriber instead.
_SUBSCRIBERS: "set[queue.Queue]" = set()
_SUB_LOCK = threading.Lock()


def publish(evt: dict) -> None:
    with _SUB_LOCK:
        targets = list(_SUBSCRIBERS)
    for q in targets:
        q.put(evt)


@contextmanager
def _subscribe():
    q: "queue.Queue[dict]" = queue.Queue()
    with _SUB_LOCK:
        _SUBSCRIBERS.add(q)
    try:
        yield q
    finally:
        with _SUB_LOCK:
            _SUBSCRIBERS.discard(q)


def subscriber_count() -> int:
    with _SUB_LOCK:
        return len(_SUBSCRIBERS)

MAX_POST_BYTES = 1_000_000  # 1 MB — we only accept tiny JSON bodies (plan, tip key)
MAX_LIMIT = 1000

# How many prompts the savings drill-down hands to the client to sort. Every
# typed prompt is priced; this only bounds how many travel to the browser, and
# when it binds the response says so rather than implying the list is complete.
PROMPT_POOL = 20000


def _attach_costs(rows, key: str, per_model_rows, pricing: dict) -> None:
    """Add `cost_usd` to each row in `rows` from its per-model split.

    Buckets with nothing priceable get 0.0, not None: the caller is drawing a
    line, and a null renders as a gap that reads like "no activity" rather than
    "no price on file". Unpriced models are reported in full on /api/overview,
    which is where a gap in the pricing table belongs.
    """
    totals: dict = {}
    for r in per_model_rows:
        c = cost_for(r["model"], r, pricing)
        if c["usd"] is not None:
            totals[r[key]] = totals.get(r[key], 0.0) + c["usd"]
    for r in rows:
        r["cost_usd"] = round(totals.get(r[key], 0.0), 4)


_TOKEN_COLS = ("input_tokens", "output_tokens", "cache_read_tokens",
               "cache_create_5m_tokens", "cache_create_1h_tokens")


def _price_rows(rows, pricing: dict) -> None:
    """Add `cost_usd` to rows that carry a `model` and the raw token columns."""
    for r in rows:
        c = cost_for(r["model"], r, pricing)
        r["cost_usd"] = round(c["usd"], 4) if c["usd"] is not None else 0.0


def _fold_priced(rows, key: str, pricing: dict, carry=()) -> list:
    """Price per-(bucket, model) rows, then sum them into one row per bucket.

    Pricing has to happen before the fold, not after — the rate depends on the
    model, so a bucket's tokens can't be priced once they've been mixed.
    """
    out: dict = {}
    for r in rows:
        c = cost_for(r["model"], r, pricing)
        acc = out.setdefault(r[key], {
            key: r[key], "cost_usd": 0.0, "billable_tokens": 0,
            **{col: 0 for col in _TOKEN_COLS},
            **{k: r.get(k) for k in carry},
        })
        acc["cost_usd"] += c["usd"] or 0.0
        for col in _TOKEN_COLS:
            acc[col] += r.get(col) or 0
        acc["billable_tokens"] += (
            (r.get("input_tokens") or 0) + (r.get("output_tokens") or 0)
            + (r.get("cache_create_5m_tokens") or 0) + (r.get("cache_create_1h_tokens") or 0)
        )
    for acc in out.values():
        acc["cost_usd"] = round(acc["cost_usd"], 4)
    return sorted(out.values(), key=lambda a: a["cost_usd"], reverse=True)


_ZERO_USAGE = {c: 0 for c in _TOKEN_COLS}


def _cache_saving(row, pricing: dict) -> float:
    """What caching was worth on this row, NET of what it cost to fill the cache.

    Same arithmetic the Savings page does, at row grain: reads billed at a tenth
    instead of full input, minus the premium paid to write those entries. Net,
    not gross — otherwise the rows would sum to more than the headline they are
    supposed to explain, which is the one way a drill-down can be worse than no
    drill-down at all.

    Priced by asking `cost_for` the same question twice, so the rates come from
    the same table as everything else and cannot drift apart from it.
    """
    model = row["model"]
    read = row.get("cache_read_tokens") or 0
    c5 = row.get("cache_create_5m_tokens") or 0
    c1 = row.get("cache_create_1h_tokens") or 0
    if not (read or c5 or c1):
        return 0.0

    def usd(usage):
        v = cost_for(model, dict(_ZERO_USAGE, **usage), pricing)["usd"]
        return v or 0.0

    saved = usd({"input_tokens": read}) - usd({"cache_read_tokens": read})
    premium = (usd({"cache_create_5m_tokens": c5, "cache_create_1h_tokens": c1})
               - usd({"input_tokens": c5 + c1}))
    return saved - premium


def _fold_sessions(rows, pricing: dict) -> list:
    """One row per session, carrying both its cost and its caching saving."""
    out: dict = {}
    for r in rows:
        c = cost_for(r["model"], r, pricing)
        acc = out.setdefault(r["session_id"], {
            "session_id": r["session_id"],
            "project_slug": r["project_slug"],
            "project_name": r.get("project_name"),
            "started": r.get("started"),
            "cost_usd": 0.0, "cache_saved_usd": 0.0,
            "billable_tokens": 0, "cache_read_tokens": 0,
        })
        acc["cost_usd"] += c["usd"] or 0.0
        acc["cache_saved_usd"] += _cache_saving(r, pricing)
        acc["cache_read_tokens"] += r.get("cache_read_tokens") or 0
        acc["billable_tokens"] += (
            (r.get("input_tokens") or 0) + (r.get("output_tokens") or 0)
            + (r.get("cache_create_5m_tokens") or 0) + (r.get("cache_create_1h_tokens") or 0)
        )
        if r.get("started") and (not acc["started"] or r["started"] < acc["started"]):
            acc["started"] = r["started"]
    for a in out.values():
        a["cost_usd"] = round(a["cost_usd"], 4)
        a["cache_saved_usd"] = round(a["cache_saved_usd"], 4)
    return list(out.values())


def _fold_prompts(rows, pricing: dict, text_chars: int = 220) -> list:
    """One row per prompt, priced across every model its turn window touched.

    Prompt text is truncated here rather than in the browser: the full body of a
    40k-token prompt has no business travelling to a panel that shows one line.
    """
    out: dict = {}
    for r in rows:
        c = cost_for(r["model"], r, pricing)
        acc = out.setdefault(r["prompt_uuid"], {
            "prompt_uuid": r["prompt_uuid"],
            "session_id": r["session_id"],
            "project_slug": r["project_slug"],
            "project_name": r.get("project_name"),
            "timestamp": r["timestamp"],
            "prompt_text": (r["prompt_text"] or "")[:text_chars],
            "models": [],
            "turns": 0, "cost_usd": 0.0, "cache_saved_usd": 0.0,
            "billable_tokens": 0, "cache_read_tokens": 0,
        })
        if r["model"] not in acc["models"]:
            acc["models"].append(r["model"])
        acc["turns"] += r["turns"] or 0
        acc["cost_usd"] += c["usd"] or 0.0
        acc["cache_saved_usd"] += _cache_saving(r, pricing)
        acc["cache_read_tokens"] += r["cache_read_tokens"] or 0
        acc["billable_tokens"] += (r["input_tokens"] + r["output_tokens"]
                                   + r["cache_create_5m_tokens"] + r["cache_create_1h_tokens"])
    for a in out.values():
        a["cost_usd"] = round(a["cost_usd"], 4)
        a["cache_saved_usd"] = round(a["cache_saved_usd"], 4)
        # The model that did the most work in the window, for the badge.
        a["model"] = a["models"][0] if a["models"] else "unknown"
    return list(out.values())


def _send_json(handler, obj, status: int = 200) -> None:
    body = json.dumps(obj, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _send_error(handler, status: int, msg: str) -> None:
    _send_json(handler, {"error": msg}, status=status)


def _clamp_limit(raw, default: int) -> int:
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(v, MAX_LIMIT))


def _serve_static(handler, rel: str) -> None:
    rel = rel.lstrip("/")
    p = (WEB_ROOT / rel).resolve()
    if not str(p).startswith(str(WEB_ROOT.resolve())) or not p.is_file():
        handler.send_response(404)
        handler.end_headers()
        return
    body = p.read_bytes()
    ctype, _ = mimetypes.guess_type(str(p))
    handler.send_response(200)
    handler.send_header("Content-Type", ctype or "application/octet-stream")
    handler.send_header("Content-Length", str(len(body)))
    # No caching, deliberately. These files are read off local disk over
    # loopback, so there is nothing to save — and with no headers at all the
    # browser applies its own heuristic and happily serves a stale ES module,
    # which looks exactly like "the fix didn't work" after every edit.
    handler.send_header("Cache-Control", "no-store, must-revalidate")
    handler.end_headers()
    handler.wfile.write(body)


def build_handler(db_path: str, projects_dir: str):
    pricing = load_pricing(PRICING_JSON)

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def do_HEAD(self):
            return self.do_GET()

        def do_GET(self):
            url = urlparse(self.path)
            qs = parse_qs(url.query or "")
            path = url.path
            since = qs.get("since", [None])[0]
            until = qs.get("until", [None])[0]
            if path in ("/", "/index.html"):
                return _serve_static(self, "index.html")
            if path.startswith("/web/"):
                return _serve_static(self, path[5:])
            if path == "/api/overview":
                totals = overview_totals(db_path, since, until)
                cost = total_cost(model_breakdown(db_path, since, until), pricing)
                totals["cost_usd"] = cost["usd"]
                totals["cost_estimated"] = cost["estimated"]
                totals["unpriced_models"] = cost["unpriced"]
                return _send_json(self, totals)
            if path == "/api/prompts":
                limit = _clamp_limit(qs.get("limit", ["50"])[0], 50)
                sort = qs.get("sort", ["tokens"])[0]
                rows = _fold_prompts(prompt_costs(db_path, since, until), pricing)
                if sort == "recent":
                    rows.sort(key=lambda r: r["timestamp"] or "", reverse=True)
                else:
                    rows.sort(key=lambda r: r["cost_usd"], reverse=True)
                return _send_json(self, rows[:limit])
            if path == "/api/projects":
                rows = project_summary(db_path, since, until)
                _attach_costs(
                    rows, "project_slug",
                    project_model_breakdown(db_path, since, until), pricing,
                )
                return _send_json(self, rows)
            if path == "/api/tools":
                return _send_json(self, tool_token_breakdown(db_path, since, until))
            if path == "/api/sessions":
                return _send_json(self, recent_sessions(
                    db_path, limit=_clamp_limit(qs.get("limit", ["20"])[0], 20),
                    since=since, until=until,
                ))
            if path == "/api/daily":
                rows = daily_token_breakdown(db_path, since, until)
                _attach_costs(
                    rows, "day",
                    daily_model_breakdown(db_path, since, until), pricing,
                )
                return _send_json(self, rows)
            if path == "/api/skills":
                rows = skill_breakdown(db_path, since, until)
                catalog = cached_catalog()
                for r in rows:
                    info = catalog.get(r["skill"])
                    r["tokens_per_call"] = info["tokens"] if info else None
                return _send_json(self, rows)
            if path == "/api/by-model":
                rows = model_breakdown(db_path, since, until)
                for r in rows:
                    c = cost_for(r["model"], r, pricing)
                    r["cost_usd"] = c["usd"]
                    r["cost_estimated"] = c["estimated"]
                return _send_json(self, rows)
            if path.startswith("/api/sessions/"):
                sid = path.rsplit("/", 1)[1]
                return _send_json(self, session_turns(db_path, sid))
            if path == "/api/breakdown":
                by = qs.get("by", [""])[0]
                key = qs.get("key", [""])[0]
                if not key:
                    return _send_json(self, {"error": "key required"}, 400)
                if by == "day":
                    d = day_detail(db_path, key)
                    _price_rows(d["models"], pricing)
                    d["projects"] = _fold_priced(d["projects"], "project_slug",
                                                 pricing, carry=("project_name",))
                    # Which prompts made the day cost what it did. Scoped to the
                    # day, so a prompt typed yesterday is yesterday's.
                    prompts = _fold_prompts(
                        prompt_costs(db_path, key + "T00:00:00", key + "T23:59:59.999"),
                        pricing, text_chars=160,
                    )
                    prompts.sort(key=lambda p: p["cost_usd"], reverse=True)
                    d["prompts"] = prompts[:12]
                    d["prompt_count"] = len(prompts)
                    return _send_json(self, d)
                if by == "model":
                    d = model_detail(db_path, key, since, until)
                    _price_rows(d["projects"], pricing)
                    _price_rows(d["days"], pricing)
                    return _send_json(self, d)
                if by == "tool":
                    return _send_json(self, tool_detail(db_path, key, since, until))
                if by == "metric":
                    if key not in METRICS:
                        return _send_json(self, {"error": "unknown metric"}, 400)
                    return _send_json(self, metric_detail(db_path, key, since, until))
                return _send_json(self, {"error": "by must be day, model, tool or metric"}, 400)
            if path == "/api/savings/breakdown":
                of = qs.get("of", [""])[0]
                if of not in ("spend", "caching"):
                    # "Saved by your changes" is a rate compared against your own
                    # worst week, measured per day. There is no prompt or session
                    # it belongs to, and inventing an attribution would be the
                    # one thing this page refuses to do.
                    return _send_json(self, {"error": "not attributable"}, 400)
                key = "cost_usd" if of == "spend" else "cache_saved_usd"
                sessions = _fold_sessions(session_model_rows(db_path), pricing)
                sessions.sort(key=lambda s: s[key], reverse=True)
                prompts = _fold_prompts(prompt_costs(db_path), pricing)
                prompts.sort(key=lambda p: p[key], reverse=True)
                truncated = len(prompts) > PROMPT_POOL
                return _send_json(self, {
                    "of": of,
                    "sessions": sessions,
                    "prompts": prompts[:PROMPT_POOL],
                    "session_total": round(sum(s[key] for s in sessions), 2),
                    "prompt_total": round(sum(p[key] for p in prompts), 2),
                    # The client sorts these tables itself, so it has to be able
                    # to say whether it is sorting everything or only a slice.
                    "prompts_truncated": truncated,
                })
            if path == "/api/window":
                meta, rows = current_window(db_path)
                cost = total_cost(rows, pricing)
                meta["cost_usd"] = round(cost["usd"], 4)
                meta["turns"] = sum(r["turns"] for r in rows)
                for col in _TOKEN_COLS:
                    meta[col] = sum(r[col] for r in rows)
                meta["models"] = sorted(
                    (r["model"] for r in rows if r["turns"]),
                    key=lambda m: -next(x["turns"] for x in rows if x["model"] == m))
                return _send_json(self, meta)
            if path == "/api/savings":
                return _send_json(self, build_savings(db_path))
            if path == "/api/tips":
                return _send_json(self, all_tips(db_path))
            if path == "/api/plan":
                return _send_json(self, {
                    "plan": get_plan(db_path),
                    "plan_set": plan_is_set(db_path),
                    "pricing": pricing,
                })
            if path == "/api/scan":
                n = scan_dir(projects_dir, db_path)
                # Same notification the background loop sends, or a dashboard
                # left open would sit on stale numbers until the next sweep.
                if n["messages"] > 0:
                    publish({"type": "scan", "n": n, "ts": time.time()})
                return _send_json(self, n)
            if path == "/api/stream":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                with _subscribe() as inbox:
                    while True:
                        try:
                            evt = inbox.get(timeout=15)
                            chunk = f"data: {json.dumps(evt, default=str)}\n\n".encode()
                        except queue.Empty:
                            chunk = b": ping\n\n"
                        try:
                            self.wfile.write(chunk)
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            url = urlparse(self.path)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return _send_error(self, 400, "invalid Content-Length")
            if length < 0 or length > MAX_POST_BYTES:
                return _send_error(self, 413, f"body too large (max {MAX_POST_BYTES} bytes)")
            try:
                body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except json.JSONDecodeError:
                return _send_error(self, 400, "invalid JSON")
            if not isinstance(body, dict):
                return _send_error(self, 400, "body must be a JSON object")
            if url.path == "/api/plan":
                set_plan(db_path, body.get("plan", "api"))
                return _send_json(self, {"ok": True})
            if url.path == "/api/tips/dismiss":
                dismiss_tip(db_path, body.get("key", ""))
                return _send_json(self, {"ok": True})
            if url.path == "/api/savings/label":
                key = str(body.get("key", "")).strip()
                if not key:
                    return _send_error(self, 400, "key is required")
                label = str(body.get("label", ""))
                if len(label) > 200:
                    return _send_error(self, 400, "label too long (max 200 chars)")
                set_label(db_path, key, label)
                return _send_json(self, {"ok": True})
            self.send_response(404)
            self.end_headers()

    return H


def _scan_loop(db_path: str, projects_dir: str, interval: float = 30.0):
    while True:
        try:
            n = scan_dir(projects_dir, db_path)
            # Codex too, or a /grill-me-codex run finished while the dashboard
            # was open would stay invisible until the next manual scan.
            scan_codex(None, db_path)
            if n["messages"] > 0:
                publish({"type": "scan", "n": n, "ts": time.time()})
        except Exception as e:
            publish({"type": "error", "message": str(e)})
        time.sleep(interval)


def run(host: str, port: int, db_path: str, projects_dir: str):
    threading.Thread(target=_scan_loop, args=(db_path, projects_dir), daemon=True).start()
    H = build_handler(db_path, projects_dir)
    httpd = http.server.ThreadingHTTPServer((host, port), H)
    httpd.serve_forever()
