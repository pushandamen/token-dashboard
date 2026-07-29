import json
import os
import tempfile
import unittest

from token_dashboard.codex import codex_breakdown, codex_totals, parse_rollout, scan_codex
from token_dashboard.db import init_db, slug_for_cwd

CWD = "/Users/someone/Documents/BA-Vault/Second Brain"


def _line(**kw):
    return json.dumps(kw) + "\n"


def _rollout(path, session_id, model="gpt-5.5", turns=2, totals=None, cwd=CWD):
    """A rollout log shaped like the real thing: cumulative token_count events."""
    totals = totals or [
        {"input_tokens": 1000, "cached_input_tokens": 600, "output_tokens": 40, "reasoning_output_tokens": 10},
        {"input_tokens": 5000, "cached_input_tokens": 4000, "output_tokens": 250, "reasoning_output_tokens": 60},
    ]
    with open(path, "w", encoding="utf-8") as f:
        f.write(_line(timestamp="2026-07-20T10:00:00.000Z", type="session_meta",
                      payload={"session_id": session_id, "cwd": cwd, "originator": "codex_exec"}))
        for i in range(turns):
            f.write(_line(timestamp=f"2026-07-20T10:0{i+1}:00.000Z", type="turn_context",
                          payload={"model": model, "cwd": cwd}))
        for i, t in enumerate(totals):
            f.write(_line(timestamp=f"2026-07-20T10:1{i}:00.000Z", type="event_msg",
                          payload={"type": "token_count", "info": {"total_token_usage": t}}))


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "rollout-2026-07-20T10-00-00-abc.jsonl")

    def test_last_cumulative_total_wins(self):
        # total_token_usage is a RUNNING TOTAL — summing the events would double-count.
        _rollout(self.path, "s1")
        row = parse_rollout(self.path)
        self.assertEqual(row["input_tokens"], 5000)
        self.assertEqual(row["cached_input_tokens"], 4000)
        self.assertEqual(row["output_tokens"], 250)
        self.assertEqual(row["reasoning_tokens"], 60)

    def test_captures_model_cwd_and_turns(self):
        _rollout(self.path, "s1", turns=3)
        row = parse_rollout(self.path)
        self.assertEqual(row["model"], "gpt-5.5")
        self.assertEqual(row["cwd"], CWD)
        self.assertEqual(row["turns"], 3)
        self.assertEqual(row["originator"], "codex_exec")

    def test_project_slug_matches_claude_code_encoding(self):
        # Same directory => same slug as the Claude side, so the two sources join.
        _rollout(self.path, "s1")
        row = parse_rollout(self.path)
        self.assertEqual(row["project_slug"], "-Users-someone-Documents-BA-Vault-Second-Brain")
        self.assertEqual(row["project_slug"], slug_for_cwd(CWD))

    def test_file_without_usage_is_skipped(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(_line(timestamp="2026-07-20T10:00:00.000Z", type="session_meta",
                          payload={"session_id": "s1", "cwd": CWD}))
        self.assertIsNone(parse_rollout(self.path))

    def test_truncated_final_line_does_not_lose_earlier_usage(self):
        _rollout(self.path, "s1")
        with open(self.path, "a", encoding="utf-8") as f:
            f.write('{"type": "event_msg", "payl')  # killed mid-write
        row = parse_rollout(self.path)
        self.assertEqual(row["input_tokens"], 5000)


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sessions = os.path.join(self.tmp, "sessions", "2026", "07", "20")
        os.makedirs(self.sessions)
        _rollout(os.path.join(self.sessions, "rollout-a.jsonl"), "s1")
        _rollout(os.path.join(self.sessions, "rollout-b.jsonl"), "s2")
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_scan_walks_the_date_tree(self):
        n = scan_codex(os.path.join(self.tmp, "sessions"), self.db)
        self.assertEqual(n["sessions"], 2)

    def test_rescan_is_idempotent(self):
        scan_codex(os.path.join(self.tmp, "sessions"), self.db)
        scan_codex(os.path.join(self.tmp, "sessions"), self.db)
        t = codex_totals(self.db)
        self.assertEqual(t["sessions"], 2)          # not 4
        self.assertEqual(t["output_tokens"], 500)   # not 1000

    def test_missing_directory_is_not_an_error(self):
        n = scan_codex(os.path.join(self.tmp, "nope"), self.db)
        self.assertEqual(n, {"files": 0, "sessions": 0})

    def test_breakdown_splits_cached_out_of_input_for_pricing(self):
        scan_codex(os.path.join(self.tmp, "sessions"), self.db)
        rows = codex_breakdown(self.db)
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["model"], "gpt-5.5")
        # OpenAI reports input inclusive of cached; pricing needs them separated.
        self.assertEqual(r["cache_read_tokens"], 8000)
        self.assertEqual(r["input_tokens"], 2000)   # 10000 raw - 8000 cached
        self.assertEqual(r["cache_create_5m_tokens"], 0)  # no cache-write charge

    def test_breakdown_is_priceable_end_to_end(self):
        from token_dashboard.pricing import load_pricing, total_cost
        pricing = load_pricing(os.path.join(os.path.dirname(__file__), "..", "pricing.json"))
        scan_codex(os.path.join(self.tmp, "sessions"), self.db)
        out = total_cost(codex_breakdown(self.db), pricing)
        # 2000 in @$5 + 8000 cached @$0.50 + 500 out @$30 per MTok
        self.assertAlmostEqual(out["usd"], (2000 * 5 + 8000 * 0.5 + 500 * 30) / 1_000_000, places=6)
        self.assertEqual(out["unpriced"], [])
        self.assertFalse(out["estimated"])

    def test_range_filter_uses_session_end(self):
        scan_codex(os.path.join(self.tmp, "sessions"), self.db)
        self.assertEqual(codex_totals(self.db, since="2027-01-01")["sessions"], 0)
        self.assertEqual(codex_totals(self.db, until="2027-01-01")["sessions"], 2)


if __name__ == "__main__":
    unittest.main()
