import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from token_dashboard.db import connect, init_db
from token_dashboard.pricing import load_pricing
from token_dashboard.savings import (
    _detect,
    build_savings,
    cache_savings,
    change_points,
    efficiency_trend,
    set_label,
)

PRICING = load_pricing(os.path.join(os.path.dirname(__file__), "..", "pricing.json"))
DAY0 = datetime(2026, 6, 1, tzinfo=timezone.utc)


def _msg(c, i, day, model="claude-opus-5", **tok):
    base = {
        "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
        "cache_create_5m_tokens": 0, "cache_create_1h_tokens": 0,
    }
    base.update(tok)
    c.execute(
        "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model,"
        " input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens,"
        " cache_create_1h_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (f"u{i}", f"s{day}", "proj", "assistant", f"{day}T12:00:00Z", model,
         base["input_tokens"], base["output_tokens"], base["cache_read_tokens"],
         base["cache_create_5m_tokens"], base["cache_create_1h_tokens"]),
    )


def _turn(c, i, day):
    """A prompt the human typed. `prompt_text` is what distinguishes one of
    these from a tool result, which Claude Code also stores as type='user'."""
    c.execute(
        "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, prompt_text)"
        " VALUES (?,?,?,?,?,?)",
        (f"t{i}", f"s{day}", "proj", "user", f"{day}T12:00:00Z", "do the thing"),
    )


def _tool_result(c, i, day):
    """A tool result. Same type='user', but no prompt_text — must NOT be a turn."""
    c.execute(
        "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp)"
        " VALUES (?,?,?,?,?)",
        (f"r{i}", f"s{day}", "proj", "user", f"{day}T12:00:00Z"),
    )


def _tool(c, i, day, name, target, result_tokens=None, session="s1"):
    c.execute(
        "INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name,"
        " target, result_tokens, timestamp) VALUES (?,?,?,?,?,?,?)",
        (f"m{i}", session, "proj", name, target, result_tokens, f"{day}T12:00:00Z"),
    )


class DetectorTests(unittest.TestCase):
    def _days(self, values):
        return [((DAY0 + timedelta(days=i)).strftime("%Y-%m-%d"), float(v))
                for i, v in enumerate(values)]

    def test_finds_a_clean_step_down(self):
        hit = _detect(self._days([100] * 10 + [10] * 10))
        self.assertIsNotNone(hit)
        self.assertEqual(hit["day"], "2026-06-11")
        self.assertGreater(hit["drop"], 0.8)

    def test_ignores_a_flat_series(self):
        self.assertIsNone(_detect(self._days([50] * 20)))

    def test_ignores_a_rise(self):
        self.assertIsNone(_detect(self._days([10] * 10 + [100] * 10)))

    def test_ignores_a_drop_below_the_threshold(self):
        # 20% down is ordinary week-to-week variation, not an optimization.
        self.assertIsNone(_detect(self._days([100] * 10 + [80] * 10)))

    def test_needs_data_on_both_sides(self):
        self.assertIsNone(_detect(self._days([100, 100, 0])))


class CacheSavingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_nets_the_write_premium_off_the_read_saving(self):
        with connect(self.db) as c:
            _msg(c, 1, "2026-06-01", cache_read_tokens=1_000_000,
                 cache_create_1h_tokens=1_000_000)
            c.commit()
        out = cache_savings(self.db, PRICING)
        # opus-5: reads save (5.00 - 0.50) = $4.50; 1h writes cost (10.00 - 5.00) = $5.00 extra
        self.assertAlmostEqual(out["gross_saved_usd"], 4.50, places=2)
        self.assertAlmostEqual(out["write_premium_usd"], 5.00, places=2)
        self.assertAlmostEqual(out["net_saved_usd"], -0.50, places=2)

    def test_reports_hit_rate(self):
        with connect(self.db) as c:
            _msg(c, 1, "2026-06-01", cache_read_tokens=900, cache_create_5m_tokens=100)
            c.commit()
        self.assertEqual(cache_savings(self.db, PRICING)["hit_rate_pct"], 90.0)

    def test_prices_each_model_at_its_own_rate(self):
        with connect(self.db) as c:
            _msg(c, 1, "2026-06-01", model="claude-haiku-4-5", cache_read_tokens=1_000_000)
            _msg(c, 2, "2026-06-01", model="claude-fable-5", cache_read_tokens=1_000_000)
            c.commit()
        # haiku (1.00-0.10) + fable (10.00-1.00) = 0.90 + 9.00
        self.assertAlmostEqual(cache_savings(self.db, PRICING)["gross_saved_usd"], 9.90, places=2)


class ChangePointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)
        with connect(self.db) as c:
            for i in range(24):
                day = (DAY0 + timedelta(days=i)).strftime("%Y-%m-%d")
                _msg(c, i, day, input_tokens=1000)
                _turn(c, i, day)
                # A file read 8x/day for 12 days, then not at all.
                for n in range(8 if i < 12 else 0):
                    _tool(c, i * 100 + n, day, "Read", "/tmp/hot.md", session=f"s{day}")
            c.commit()

    def test_finds_the_day_the_file_stopped_being_read(self):
        pts = change_points(self.db, PRICING)
        hit = next((p for p in pts if "hot.md" in p["metric"]), None)
        self.assertIsNotNone(hit, "the abandoned file should be detected")
        self.assertEqual(hit["date"], "2026-06-13")
        self.assertEqual(hit["unit"], "calls")

    # Deliberately short name: the obvious longer one puts `re_` in front of
    # 20+ word characters, which is the shape of a Resend API key and trips
    # the vault's secret scanner. A test name is not worth a --no-verify.
    def test_call_counts_stay_unpriced(self):
        hit = next(p for p in change_points(self.db, PRICING) if "hot.md" in p["metric"])
        self.assertIsNone(hit["saved_usd_per_week"])
        self.assertEqual(hit["saved_per_week"], 56.0)  # 8/day x 7

    def test_a_per_turn_rate_is_never_summed_or_priced(self):
        pts = change_points(self.db, PRICING)
        rate = [p for p in pts if p["unit"] == "tokens/turn"]
        for p in rate:
            self.assertIsNone(p["saved_per_week"], "a rate must not be multiplied into a weekly total")
            self.assertIsNone(p["saved_usd_per_week"])

    def test_labels_round_trip_and_survive_recompute(self):
        key = next(p for p in change_points(self.db, PRICING) if "hot.md" in p["metric"])["key"]
        set_label(self.db, key, "stopped re-reading hot.md every turn")
        again = next(p for p in change_points(self.db, PRICING) if p["key"] == key)
        self.assertEqual(again["label"], "stopped re-reading hot.md every turn")

    def test_empty_label_clears_it(self):
        key = next(p for p in change_points(self.db, PRICING) if "hot.md" in p["metric"])["key"]
        set_label(self.db, key, "something")
        set_label(self.db, key, "   ")
        again = next(p for p in change_points(self.db, PRICING) if p["key"] == key)
        self.assertIsNone(again["label"])


class TurnCountingTests(unittest.TestCase):
    """A turn is a prompt the human typed — not every `type: "user"` row.

    Claude Code writes tool results as user messages too. Counting those inflated
    the turn total roughly 8x on a real history (40,274 user rows, 5,094 prompts)
    and divided tokens-per-turn by the same factor.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)
        with connect(self.db) as c:
            _turn(c, 1, "2026-06-01")           # one real prompt
            for j in range(9):                   # nine tool results behind it
                _tool_result(c, j, "2026-06-01")
            _msg(c, 1, "2026-06-01", input_tokens=9_000)
            c.commit()

    def test_tool_results_are_not_turns(self):
        from token_dashboard.db import overview_totals
        self.assertEqual(overview_totals(self.db)["turns"], 1)

    def test_tokens_per_turn_is_per_prompt(self):
        e = efficiency_trend(self.db)
        self.assertEqual(e["latest_tokens_per_turn"], 9_000)

    def test_sessions_and_projects_agree_on_the_definition(self):
        from token_dashboard.db import project_summary, recent_sessions
        self.assertEqual(recent_sessions(self.db)[0]["turns"], 1)
        self.assertEqual(project_summary(self.db)[0]["turns"], 1)


class EfficiencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_reports_direction_of_travel(self):
        with connect(self.db) as c:
            for i in range(21):
                day = (DAY0 + timedelta(days=i)).strftime("%Y-%m-%d")
                _turn(c, i, day)
                _msg(c, i, day, input_tokens=1000 if i < 7 else 200)
            c.commit()
        e = efficiency_trend(self.db)
        self.assertGreater(e["first_tokens_per_turn"], e["latest_tokens_per_turn"])
        self.assertLess(e["change_pct"], 0)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)

    def test_shape_is_stable_on_an_empty_db(self):
        b = build_savings(self.db)
        self.assertEqual(b["headline"]["total_usd"], 0)
        self.assertEqual(b["change_points"], [])
        self.assertIsNone(b["history"]["first_day"])
        self.assertTrue(b["projection"]["is_forecast"])

    def test_todate_only_counts_days_that_beat_the_peak(self):
        # Flat history: every day sits at the peak rate, so nothing was avoided.
        # The old figure took this week's gap and multiplied it by every week of
        # history, which invented savings out of a steady state.
        with connect(self.db) as c:
            for i in range(28):
                day = (DAY0 + timedelta(days=i)).strftime("%Y-%m-%d")
                _msg(c, i, day, cache_create_1h_tokens=1_000_000)
                _turn(c, i, day)
            c.commit()
        b = build_savings(self.db, now=DAY0 + timedelta(days=28))
        self.assertEqual(b["waste"]["saved_usd_to_date"], 0.0)
        self.assertEqual(b["headline"]["attributed_usd"], 0.0)

    def test_partial_today_is_kept_out_of_the_current_window(self):
        with connect(self.db) as c:
            for i in range(21):
                day = (DAY0 + timedelta(days=i)).strftime("%Y-%m-%d")
                _msg(c, i, day, cache_create_1h_tokens=1_000_000)
                _turn(c, i, day)
            c.commit()
        # "now" is the last day in the data, so that day is still in progress.
        b = build_savings(self.db, now=DAY0 + timedelta(days=20))
        self.assertEqual(b["waste"]["window_ends"],
                         (DAY0 + timedelta(days=19)).strftime("%Y-%m-%d"))

    def test_forecast_is_excluded_from_the_headline(self):
        with connect(self.db) as c:
            for i in range(20):
                day = (DAY0 + timedelta(days=i)).strftime("%Y-%m-%d")
                _msg(c, i, day, cache_read_tokens=1_000_000, input_tokens=1000)
                _turn(c, i, day)
            c.commit()
        b = build_savings(self.db, now=DAY0 + timedelta(days=20))
        self.assertAlmostEqual(
            b["headline"]["total_usd"],
            round(b["headline"]["exact_usd"] + b["headline"]["attributed_usd"], 2),
            places=2,
        )
        self.assertNotIn(b["projection"]["annual_avoided_usd"], (b["headline"]["total_usd"],))

    def test_money_figures_explain_themselves(self):
        b = build_savings(self.db)
        for path in (("headline",), ("cache",), ("waste",), ("projection",)):
            with self.subTest(section=path[0]):
                self.assertIn("basis", b[path[0]], f"{path[0]} must explain how it was computed")
                self.assertTrue(b[path[0]]["basis"].strip())

    def test_json_serialisable(self):
        json.dumps(build_savings(self.db))


if __name__ == "__main__":
    unittest.main()
