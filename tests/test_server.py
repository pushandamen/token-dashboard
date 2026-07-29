import http.server
import json
import os
import socket
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from token_dashboard.db import init_db
from token_dashboard.pricing import cost_for, load_pricing
from token_dashboard.server import PRICING_JSON, build_handler


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        init_db(self.db)
        with sqlite3.connect(self.db) as c:
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, prompt_text, prompt_chars) VALUES ('u',NULL,'s','p','user','2026-04-19T00:00:00Z',NULL,0,0,0,0,0,'hi',2)")
            c.execute("INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('a','u','s','p','assistant','2026-04-19T00:00:01Z','claude-haiku-4-5',1,1,0,0,0)")
            c.commit()
        self.port = _free_port()
        H = build_handler(self.db, projects_dir="/nonexistent")
        self.httpd = http.server.HTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()

    def _get(self, path):
        return urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}").read()

    def test_index_html(self):
        body = self._get("/")
        self.assertIn(b"Token Meter", body)

    def test_overview_json(self):
        body = json.loads(self._get("/api/overview"))
        self.assertIn("sessions", body)
        self.assertEqual(body["sessions"], 1)

    def test_prompts_json(self):
        body = json.loads(self._get("/api/prompts?limit=10"))
        self.assertIsInstance(body, list)

    def test_projects_json(self):
        body = json.loads(self._get("/api/projects"))
        self.assertIsInstance(body, list)
        self.assertEqual(body[0]["project_slug"], "p")

    def test_plan_json(self):
        body = json.loads(self._get("/api/plan"))
        self.assertIn("plan", body)
        self.assertIn("pricing", body)

    def _add_assistant(self, uuid, model, day, out_tokens):
        with sqlite3.connect(self.db) as c:
            c.execute(
                "INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type,"
                " timestamp, model, input_tokens, output_tokens, cache_read_tokens,"
                " cache_create_5m_tokens, cache_create_1h_tokens)"
                f" VALUES ('{uuid}','u','s','p','assistant','{day}T05:00:00Z','{model}',0,{out_tokens},0,0,0)"
            )
            c.commit()

    def test_daily_carries_cost(self):
        # Rates are per million tokens, so the two-token setUp fixture genuinely
        # does round to zero. A cost figure needs a realistic volume behind it.
        self._add_assistant("a2", "claude-haiku-4-5", "2026-04-19", 1_000_000)
        body = json.loads(self._get("/api/daily"))
        self.assertEqual(len(body), 1)
        self.assertIn("cost_usd", body[0])
        self.assertGreater(body[0]["cost_usd"], 0)

    def test_projects_carry_cost(self):
        self._add_assistant("a2", "claude-haiku-4-5", "2026-04-19", 1_000_000)
        body = json.loads(self._get("/api/projects"))
        self.assertIn("cost_usd", body[0])
        self.assertGreater(body[0]["cost_usd"], 0)

    def test_daily_cost_prices_each_model_separately(self):
        """The whole reason a day is split by model before it is priced.

        A million Haiku tokens and a million Opus tokens are an order of
        magnitude apart, so summing a day's tokens and pricing the total once
        would be wrong by that factor.
        """
        pricing = load_pricing(PRICING_JSON)
        self._add_assistant("a2", "claude-haiku-4-5", "2026-04-19", 1_000_000)
        self._add_assistant("a3", "claude-opus-4-1", "2026-04-19", 1_000_000)

        day = json.loads(self._get("/api/daily"))[0]

        zero = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
                "cache_create_5m_tokens": 0, "cache_create_1h_tokens": 0}
        seed = cost_for("claude-haiku-4-5", {**zero, "input_tokens": 1, "output_tokens": 1}, pricing)
        haiku = cost_for("claude-haiku-4-5", {**zero, "output_tokens": 1_000_000}, pricing)
        opus = cost_for("claude-opus-4-1", {**zero, "output_tokens": 1_000_000}, pricing)
        expected = seed["usd"] + haiku["usd"] + opus["usd"]
        self.assertAlmostEqual(day["cost_usd"], expected, places=3)

        # Priced as one undifferentiated blob at the cheaper rate it would be far
        # too low — that gap is what makes this worth testing.
        blended = cost_for("claude-haiku-4-5", {**zero, "output_tokens": 2_000_001, "input_tokens": 1}, pricing)
        self.assertGreater(day["cost_usd"], blended["usd"] * 1.5)

    def test_unpriced_day_is_zero_not_null(self):
        """A null renders as a gap in the trend line, which reads as 'no activity'."""
        self._add_assistant("a3", "some-model-that-does-not-exist", "2026-04-20", 500_000)
        days = {d["day"]: d for d in json.loads(self._get("/api/daily"))}
        self.assertEqual(days["2026-04-20"]["cost_usd"], 0.0)

    def _status(self, path):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}")
            return 200
        except urllib.error.HTTPError as e:
            return e.code

    def test_breakdown_day_has_every_section(self):
        self._add_assistant("a2", "claude-opus-4-1", "2026-04-19", 1_000_000)
        d = json.loads(self._get("/api/breakdown?by=day&key=2026-04-19"))
        self.assertEqual(d["day"], "2026-04-19")
        for section in ("models", "projects", "tools", "sessions"):
            self.assertIn(section, d)
        self.assertGreater(sum(m["cost_usd"] for m in d["models"]), 0)
        # Projects arrive split by model and are folded after pricing, so each
        # project appears exactly once with one summed cost.
        slugs = [p["project_slug"] for p in d["projects"]]
        self.assertEqual(len(slugs), len(set(slugs)))

    def test_breakdown_rejects_unknown_axis(self):
        self.assertEqual(self._status("/api/breakdown?by=nonsense&key=x"), 400)
        self.assertEqual(self._status("/api/breakdown?by=day"), 400)

    def test_savings_breakdown_refuses_to_attribute_your_changes(self):
        """The attributed saving is a rate against your own worst week.

        No prompt or session owns any part of it, so the endpoint must refuse
        rather than produce a plausible-looking list.
        """
        self.assertEqual(self._status("/api/savings/breakdown?of=changes"), 400)
        self.assertEqual(self._status("/api/savings/breakdown?of=spend"), 200)

    def test_cache_saving_is_net_of_the_write_premium(self):
        """A session that only ever filled the cache and never read from it has
        paid the premium and collected nothing — that must show as negative."""
        with sqlite3.connect(self.db) as c:
            c.execute(
                "INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type,"
                " timestamp, model, input_tokens, output_tokens, cache_read_tokens,"
                " cache_create_5m_tokens, cache_create_1h_tokens)"
                " VALUES ('w',NULL,'writeonly','p','assistant','2026-04-19T06:00:00Z',"
                "'claude-opus-4-1',0,0,0,1000000,0)"
            )
            c.commit()
        d = json.loads(self._get("/api/savings/breakdown?of=caching"))
        rows = {s["session_id"]: s for s in
                json.loads(self._get("/api/savings/breakdown?of=spend"))["sessions"]}
        self.assertIn("writeonly", rows)
        self.assertLess(rows["writeonly"]["cache_saved_usd"], 0)
        self.assertIsInstance(d["session_total"], float)

    def test_head_returns_200_not_501(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/", method="HEAD")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.read(), b"")

    def test_head_api_endpoint(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/overview", method="HEAD")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.read(), b"")


if __name__ == "__main__":
    unittest.main()


class StreamFanOutTests(unittest.TestCase):
    """Every connected client gets every event.

    A single shared queue meant whichever stream handler reached it first ate
    the event — two tabs would steal from each other, and one tab plus anything
    else listening meant the tab silently stopped updating.
    """

    def test_publish_reaches_every_subscriber(self):
        from token_dashboard import server

        with server._subscribe() as a, server._subscribe() as b:
            self.assertEqual(server.subscriber_count(), 2)
            server.publish({"type": "scan", "n": {"messages": 1}})
            self.assertEqual(a.get(timeout=1)["type"], "scan")
            self.assertEqual(b.get(timeout=1)["type"], "scan")
        self.assertEqual(server.subscriber_count(), 0)

    def test_subscriber_is_removed_even_if_the_body_raises(self):
        from token_dashboard import server

        with self.assertRaises(RuntimeError):
            with server._subscribe():
                raise RuntimeError("client hung up")
        self.assertEqual(server.subscriber_count(), 0)


class StaticCachingTests(ServerTests):
    """Static assets must not be cached.

    With no cache headers the browser applies a heuristic and can serve a stale
    ES module after an edit — indistinguishable, from the outside, from a fix
    that silently didn't work.
    """

    def _headers(self, path):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as r:
            return {k.lower(): v for k, v in r.headers.items()}

    def test_js_is_not_cacheable(self):
        cc = self._headers("/web/app.js").get("cache-control", "")
        self.assertIn("no-store", cc)

    def test_index_is_not_cacheable(self):
        self.assertIn("no-store", self._headers("/").get("cache-control", ""))

    def test_api_stays_no_store(self):
        self.assertIn("no-store", self._headers("/api/overview").get("cache-control", ""))
