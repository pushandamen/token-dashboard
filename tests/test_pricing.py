import os
import unittest

from token_dashboard.pricing import load_pricing, cost_for, format_for_user, total_cost

PRICING = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "pricing.json"))


def _usage(**kw):
    base = {
        "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
        "cache_create_5m_tokens": 0, "cache_create_1h_tokens": 0,
    }
    base.update(kw)
    return base


class CostTests(unittest.TestCase):
    def setUp(self):
        self.p = load_pricing(PRICING)

    def test_known_opus_input_cost(self):
        c = cost_for("claude-opus-5", _usage(input_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 5.00, places=4)
        self.assertFalse(c["estimated"])

    def test_known_sonnet_output_cost(self):
        c = cost_for("claude-sonnet-4-6", _usage(output_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 15.00, places=4)

    def test_unknown_opus_falls_back(self):
        c = cost_for("claude-opus-9-9-experimental", _usage(input_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 5.00, places=4)
        self.assertTrue(c["estimated"])

    def test_unknown_unparseable_returns_none(self):
        c = cost_for("custom-local-model", _usage(input_tokens=9999), self.p)
        self.assertIsNone(c["usd"])

    def test_cache_read_cheaper_than_input(self):
        c_in = cost_for("claude-opus-5", _usage(input_tokens=1_000_000), self.p)
        c_cr = cost_for("claude-opus-5", _usage(cache_read_tokens=1_000_000), self.p)
        self.assertLess(c_cr["usd"], c_in["usd"])


class ModelCoverageTests(unittest.TestCase):
    """Every model actually seen in a transcript must price exactly, not by tier.

    A tier fallback is a safety net for models released after this table was
    written; a model we already know about landing on it means the table is stale.
    """

    def setUp(self):
        self.p = load_pricing(PRICING)

    def test_models_in_use_price_exactly(self):
        for model in (
            "claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5",
            "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001", "claude-sonnet-4-6",
            "gpt-5.5",
        ):
            with self.subTest(model=model):
                c = cost_for(model, _usage(input_tokens=1_000), self.p)
                self.assertIsNotNone(c["usd"], f"{model} has no price")
                self.assertFalse(c["estimated"], f"{model} fell through to a tier fallback")

    def test_fable_is_priced_not_dropped(self):
        # Regression: "claude-fable-5" contains none of opus/sonnet/haiku, so the
        # old tier matcher returned None and 32M tokens were costed at $0.
        c = cost_for("claude-fable-5", _usage(input_tokens=1_000_000), self.p)
        self.assertAlmostEqual(c["usd"], 10.00, places=4)

    def test_unknown_fable_and_gpt_hit_their_tiers(self):
        for model, expected in (("claude-fable-9", 10.00), ("gpt-9-turbo", 5.00)):
            with self.subTest(model=model):
                c = cost_for(model, _usage(input_tokens=1_000_000), self.p)
                self.assertAlmostEqual(c["usd"], expected, places=4)
                self.assertTrue(c["estimated"])

    def test_cache_multipliers_hold_for_every_claude_model(self):
        for name, r in self.p["models"].items():
            if r["tier"] == "gpt":
                continue  # OpenAI charges nothing to write cache
            with self.subTest(model=name):
                self.assertAlmostEqual(r["cache_read"], r["input"] * 0.1, places=4)
                self.assertAlmostEqual(r["cache_create_5m"], r["input"] * 1.25, places=4)
                self.assertAlmostEqual(r["cache_create_1h"], r["input"] * 2.0, places=4)

    def test_openai_charges_nothing_to_write_cache(self):
        r = self.p["models"]["gpt-5.5"]
        self.assertEqual(r["cache_create_5m"], 0.0)
        self.assertEqual(r["cache_create_1h"], 0.0)


class TotalCostTests(unittest.TestCase):
    def setUp(self):
        self.p = load_pricing(PRICING)

    def _row(self, model, **kw):
        return {"model": model, **_usage(**kw)}

    def test_sums_priced_models(self):
        out = total_cost([
            self._row("claude-opus-5", input_tokens=1_000_000),
            self._row("claude-haiku-4-5", output_tokens=1_000_000),
        ], self.p)
        self.assertAlmostEqual(out["usd"], 10.00, places=4)
        self.assertEqual(out["unpriced"], [])

    def test_reports_unpriced_instead_of_dropping_silently(self):
        out = total_cost([
            self._row("claude-opus-5", input_tokens=1_000_000),
            self._row("some-local-llama", input_tokens=500, output_tokens=500),
        ], self.p)
        self.assertAlmostEqual(out["usd"], 5.00, places=4)
        self.assertEqual(len(out["unpriced"]), 1)
        self.assertEqual(out["unpriced"][0]["model"], "some-local-llama")
        self.assertEqual(out["unpriced"][0]["billable_tokens"], 1000)

    def test_zero_token_model_is_not_reported_as_a_gap(self):
        # Claude Code's `<synthetic>` rows match no tier but bill nothing.
        out = total_cost([self._row("<synthetic>")], self.p)
        self.assertEqual(out["unpriced"], [])

    def test_flags_when_any_row_was_estimated(self):
        out = total_cost([self._row("claude-opus-77", input_tokens=10)], self.p)
        self.assertTrue(out["estimated"])


class PlanFormatTests(unittest.TestCase):
    def setUp(self):
        self.p = load_pricing(PRICING)

    def test_api_plan_returns_raw(self):
        out = format_for_user(12.34, "api", self.p)
        self.assertEqual(out["display_usd"], 12.34)
        self.assertIsNone(out["subscription_usd"])

    def test_pro_plan_returns_subscription_subtitle(self):
        out = format_for_user(12.34, "pro", self.p)
        self.assertEqual(out["subscription_usd"], 20)
        self.assertIn("Pro", out["subtitle"])


if __name__ == "__main__":
    unittest.main()
