import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone

from token_dashboard.db import init_db
from token_dashboard.glance import build_glance
from token_dashboard.scanner import scan_dir

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DAY = "2026-04-19"
OTHER_DAY = "2026-03-02"


def _session(uuid_prefix, day, in_tok, out_tok, cache_read=0):
    """A user turn plus its assistant reply, as two JSONL lines."""
    u, a = f"u{uuid_prefix}", f"a{uuid_prefix}"
    usage = {"input_tokens": in_tok, "output_tokens": out_tok, "cache_read_input_tokens": cache_read}
    return (
        json.dumps({
            "type": "user", "uuid": u, "sessionId": f"s{uuid_prefix}",
            "timestamp": f"{day}T10:00:00Z", "isSidechain": False,
            "cwd": "/tmp/demo-project",
            "message": {"role": "user", "content": "hi"},
        }) + "\n"
        + json.dumps({
            "type": "assistant", "uuid": a, "parentUuid": u, "sessionId": f"s{uuid_prefix}",
            "timestamp": f"{day}T10:00:01Z", "isSidechain": False,
            "cwd": "/tmp/demo-project",
            "message": {"id": f"m{uuid_prefix}", "model": "claude-haiku-4-5", "usage": usage},
        }) + "\n"
    )


class GlanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.proj = os.path.join(self.tmp, "projects")
        os.makedirs(os.path.join(self.proj, "demo"))
        with open(os.path.join(self.proj, "demo", "s.jsonl"), "w", encoding="utf-8") as f:
            f.write(_session("1", DAY, 100, 50, cache_read=200))
            f.write(_session("2", OTHER_DAY, 7, 3))
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)
        scan_dir(self.proj, self.db)

    def _bundle(self, day=DAY):
        pinned = datetime.fromisoformat(f"{day}T23:00:00+00:00")
        return build_glance(self.db, now=pinned)

    def test_today_is_scoped_to_the_day_and_all_time_is_not(self):
        b = self._bundle()
        # Only the DAY session lands in `today`; `all_time` carries both.
        self.assertEqual(b["today"]["input_tokens"], 100)
        self.assertEqual(b["today"]["output_tokens"], 50)
        self.assertEqual(b["today"]["sessions"], 1)
        self.assertEqual(b["all_time"]["input_tokens"], 107)
        self.assertEqual(b["all_time"]["sessions"], 2)

    def test_billable_excludes_cache_reads(self):
        b = self._bundle()
        self.assertEqual(b["today"]["cache_read_tokens"], 200)
        self.assertEqual(b["today"]["billable_tokens"], 150)

    def test_cost_is_priced_not_zero(self):
        b = self._bundle()
        self.assertGreater(b["all_time"]["cost_usd"], 0)

    def test_daily_window_drops_days_outside_it(self):
        b = self._bundle()
        days = [d["day"] for d in b["daily"]]
        self.assertIn(DAY, days)
        self.assertNotIn(OTHER_DAY, days)  # 48 days back, outside the 14-day window

    def test_projects_and_sessions_are_named_and_capped(self):
        b = self._bundle()
        self.assertLessEqual(len(b["projects"]), 5)
        self.assertLessEqual(len(b["recent_sessions"]), 3)
        self.assertEqual(b["projects"][0]["project_name"], "demo-project")

    def test_shape_is_stable_on_an_empty_db(self):
        empty = os.path.join(self.tmp, "empty.db")
        init_db(empty)
        b = build_glance(empty)
        self.assertEqual(b["all_time"]["sessions"], 0)
        self.assertEqual(b["all_time"]["cost_usd"], 0)
        self.assertEqual(b["daily"], [])
        self.assertEqual(b["projects"], [])
        self.assertEqual(b["tips"], [])
        self.assertEqual(b["plan"], "api")

    def test_cli_glance_emits_parseable_json_only(self):
        env = {**os.environ, "TOKEN_DASHBOARD_DB": self.db}
        r = subprocess.run(
            [sys.executable, "cli.py", "glance"],
            cwd=ROOT, env=env, capture_output=True, text=True,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        parsed = json.loads(r.stdout)  # no banner line may precede the JSON
        self.assertIn("all_time", parsed)
        self.assertIn("generated_at", parsed)


if __name__ == "__main__":
    unittest.main()
