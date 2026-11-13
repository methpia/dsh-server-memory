"""End-to-end tests for ``memoryd.py``.

These use nothing beyond the standard library, matching the server's runtime
contract (Python 3.9, no pip packages). Run them with::

    python3 -m unittest discover -s server/tests -v
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import timedelta

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

import memoryd  # noqa: E402  (import after sys.path tweak)

TOKEN = "test-token-0123456789"


class ServerTestCase(unittest.TestCase):
    """Boot one server per test class on an ephemeral port with a temp DB."""

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="memoryd-test-")
        cls.config = memoryd.load_config(
            None,
            {
                "token": TOKEN,
                "host": "127.0.0.1",
                "port": 0,
                "db_path": os.path.join(cls.tmpdir, "memory.db"),
                "allow_journal": False,
            },
        )
        cls.server = memoryd.build_server(cls.config)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=5)
        cls.server.server_close()
        cls.server.db.close()
        shutil.rmtree(cls.tmpdir, ignore_errors=True)

    # -- helpers -----------------------------------------------------------

    def request(self, method, path, body=None, token=TOKEN, raw_body=None):
        url = "http://127.0.0.1:%d%s" % (self.port, path)
        data = None
        # Force a fresh socket per request: keep-alive reuse across a shutdown race
        # was the source of a rare ConnectionAbortedError in CI.
        headers = {"Content-Type": "application/json; charset=utf-8", "Connection": "close"}
        if raw_body is not None:
            data = raw_body
        elif body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        if token is not None:
            headers["Authorization"] = "Bearer %s" % token
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = response.read().decode("utf-8")
                return response.status, json.loads(payload) if payload else {}
        except urllib.error.HTTPError as error:
            payload = error.read().decode("utf-8")
            return error.code, json.loads(payload) if payload else {}

    def add_notes(self, project, texts, kind="note", tags=None, expect=200):
        notes = []
        for text in texts:
            note = {"text": text}
            if tags is not None:
                note["tags"] = tags
            notes.append(note)
        status, payload = self.request(
            "POST",
            "/api/notes",
            {"project": project, "notes": notes, "kind": kind, "source": "test"},
        )
        self.assertEqual(status, expect, payload)
        return payload


class HealthAndAuthTests(ServerTestCase):
    def test_health_is_open(self):
        status, payload = self.request("GET", "/health", token=None)
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["version"], 1)
        self.assertIn("projects", payload)
        self.assertIn("items", payload)

    def test_health_rejects_post(self):
        status, payload = self.request("POST", "/health", body={}, token=None)
        self.assertEqual(status, 405)
        self.assertEqual(payload["error"]["code"], "method-not-allowed")

    def test_missing_token_is_401(self):
        status, payload = self.request("GET", "/api/context?project=dsh", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"]["code"], "unauthorized")

    def test_wrong_token_is_401(self):
        status, _ = self.request("GET", "/api/context?project=dsh", token="nope")
        self.assertEqual(status, 401)

    def test_error_replies_close_the_connection(self):
        # An error may leave an unread request body behind; the reply must close
        # so the next request is not parsed from leftover bytes.
        url = "http://127.0.0.1:%d/api/notes" % self.port
        request = urllib.request.Request(
            url,
            data=json.dumps({"project": "dsh", "notes": [{"text": "x"}]}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer wrong"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=10)
        self.assertEqual(caught.exception.code, 401)
        self.assertEqual(caught.exception.headers.get("Connection"), "close")
        caught.exception.close()
        # The service is still healthy on a fresh connection.
        self.assertEqual(self.request("GET", "/health", token=None)[0], 200)

    def test_unknown_api_path_with_body_is_404(self):
        status, payload = self.request(
            "POST", "/api/nope", body={"project": "dsh", "notes": [{"text": "x"}]}
        )
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "not-found")

    def test_unknown_path_is_404(self):
        status, payload = self.request("GET", "/api/nope")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "not-found")

    def test_put_is_405(self):
        status, payload = self.request("PUT", "/api/notes", body={})
        self.assertEqual(status, 405)
        self.assertEqual(payload["error"]["code"], "method-not-allowed")

    def test_invalid_json_is_400(self):
        status, payload = self.request(
            "POST", "/api/notes", raw_body=b"{not json"
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid-json")


class NotesAndContextTests(ServerTestCase):
    def test_notes_roundtrip_and_context_budget(self):
        payload = self.add_notes(
            "roundtrip",
            [
                "结算模块改为按日结，不再月结",
                "对账页面优先展示当日汇总",
                "跨月订单佣金计算会出现一天空档",
            ],
            tags=["结算", "偏好"],
        )
        self.assertEqual(payload["stored"], 3)
        self.assertEqual(len(payload["ids"]), 3)

        status, context = self.request(
            "GET", "/api/context?project=roundtrip&limit=10&max_chars=1500"
        )
        self.assertEqual(status, 200, context)
        self.assertEqual(len(context["items"]), 3)
        self.assertEqual(context["project"], "roundtrip")
        self.assertIn("watermark", context)
        self.assertIn("consolidation", context)
        self.assertTrue(context["consolidation"]["due"])

        total = sum(len(item["text"]) + 1 for item in context["items"])
        self.assertLessEqual(total, 1500)

    def test_context_truncates_to_the_character_budget(self):
        long_texts = ["第%d段：" % index + "记忆内容" * 30 for index in range(3)]
        self.add_notes("budget", long_texts)
        status, payload = self.request(
            "GET", "/api/context?project=budget&limit=10&max_chars=200"
        )
        self.assertEqual(status, 200, payload)
        budget = sum(len(item["text"]) + 1 for item in payload["items"])
        self.assertLessEqual(budget, 200)
        self.assertTrue(payload["items"], "the budget must still return something")
        self.assertLess(len(payload["items"]), 3)

    def test_manual_items_come_first(self):
        self.add_notes("manual-first", ["普通摘要一", "普通摘要二"])
        status, payload = self.request(
            "POST", "/api/items", {"project": "manual-first", "text": "用户要求始终用中文", "tags": ["偏好"]}
        )
        self.assertEqual(status, 200, payload)
        status, context = self.request("GET", "/api/context?project=manual-first&limit=5")
        self.assertEqual(status, 200)
        self.assertEqual(context["items"][0]["kind"], "manual")
        self.assertEqual(context["items"][0]["text"], "用户要求始终用中文")

    def test_manual_kind_is_default_for_items(self):
        status, payload = self.request("POST", "/api/items", {"project": "kinds", "text": "一句手工记忆"})
        self.assertEqual(status, 200)
        item_id = payload["id"]
        status, context = self.request("GET", "/api/context?project=kinds&limit=5")
        self.assertEqual(context["items"][0]["id"], item_id)
        self.assertEqual(context["items"][0]["kind"], "manual")

    def test_delete_item(self):
        payload = self.add_notes("deleting", ["待删除的一条记忆"])
        item_id = payload["ids"][0]
        status, result = self.request("DELETE", "/api/items/%d" % item_id)
        self.assertEqual(status, 200, result)
        self.assertTrue(result["deleted"])
        status, again = self.request("DELETE", "/api/items/%d" % item_id)
        self.assertEqual(status, 404)
        self.assertEqual(again["error"]["code"], "not-found")

    def test_journal_is_rejected_by_default(self):
        payload = self.add_notes("journal", ["原始流水"], kind="journal", expect=400)
        self.assertEqual(payload["error"]["code"], "journal-disabled")

    def test_text_limit_is_enforced_server_side(self):
        payload = self.add_notes(
            "limits", ["啊" * (memoryd.MAX_TEXT_CHARS + 1)], expect=413
        )
        self.assertEqual(payload["error"]["code"], "text-too-long")

    def test_note_batch_limit(self):
        notes = [{"text": "第 %d 条" % index} for index in range(memoryd.MAX_NOTES_PER_REQUEST + 1)]
        status, payload = self.request(
            "POST", "/api/notes", {"project": "limits", "notes": notes}
        )
        self.assertEqual(status, 413)
        self.assertEqual(payload["error"]["code"], "too-many-notes")

    def test_body_limit(self):
        huge = b'{"project":"x","notes":[{"text":"' + b"a" * (memoryd.MAX_BODY_BYTES + 10) + b'"}]}'
        status, payload = self.request("POST", "/api/notes", raw_body=huge)
        self.assertEqual(status, 413)
        self.assertEqual(payload["error"]["code"], "body-too-large")

    def test_invalid_project_is_rejected(self):
        status, payload = self.request("GET", "/api/context?project=a%20b")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid-project")

    def test_missing_project_is_rejected(self):
        status, payload = self.request("GET", "/api/context")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid-project")


class SearchTests(ServerTestCase):
    def test_chinese_bigram_search(self):
        self.add_notes("demo-project", ["结算模块改为按日结，不再月结"])
        for query in ("日结", "结算", "月结"):
            status, payload = self.request(
                "GET", "/api/search?project=demo-project&q=" + urllib.parse.quote(query)
            )
            self.assertEqual(status, 200, payload)
            self.assertEqual(len(payload["items"]), 1, "query %s missed" % query)
            self.assertIn("结算模块", payload["items"][0]["text"])

    def test_search_is_project_scoped(self):
        self.add_notes("project-a", ["共享关键词：灰度发布策略"])
        self.add_notes("project-b", ["共享关键词：灰度发布策略"])
        status, payload = self.request(
            "GET", "/api/search?project=project-a&q=" + urllib.parse.quote("灰度发布")
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["items"]), 1)

    def test_search_falls_back_to_like(self):
        self.add_notes("fallback", ["接口返回 C++ 编译错误时先看头文件"])
        # "++" yields no FTS tokens, so the server must fall back to LIKE.
        status, payload = self.request(
            "GET", "/api/search?project=fallback&q=" + urllib.parse.quote("++")
        )
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["items"], "LIKE fallback should still find the note")

    def test_empty_query_is_rejected(self):
        status, payload = self.request("GET", "/api/search?project=fallback&q=")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid-q")

    def test_manual_outranks_note_on_equal_match(self):
        self.add_notes("ranking", ["部署脚本要带 --dry-run"])
        self.request("POST", "/api/items", {"project": "ranking", "text": "部署脚本要带 --dry-run"})
        status, payload = self.request(
            "GET", "/api/search?project=ranking&q=" + urllib.parse.quote("部署脚本")
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["items"][0]["kind"], "manual")
        self.assertGreaterEqual(payload["items"][0]["score"], payload["items"][-1]["score"])


class WatermarkTests(ServerTestCase):
    def test_claim_is_atomic_and_idempotent(self):
        first = self.request("POST", "/api/watermark/claim", {"project": "claiming"})[1]
        self.assertTrue(first["claimed"])
        self.assertIsNone(first["since"])

        second_status, second = self.request(
            "POST", "/api/watermark/claim", {"project": "claiming"}
        )
        self.assertEqual(second_status, 200)
        self.assertFalse(second["claimed"])
        self.assertEqual(second["reason"], "too_soon")
        self.assertIn("next_at", second)

    def test_watermark_advance_and_since(self):
        status, payload = self.request(
            "POST",
            "/api/watermark",
            {
                "project": "advancing",
                "last_consolidated": "2026-11-12T09:00:00Z",
                "status": "ok",
            },
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["watermark"]["last_consolidated"], "2026-11-12T09:00:00Z")

        claim = self.request(
            "POST", "/api/watermark/claim", {"project": "advancing", "min_interval_hours": 0}
        )[1]
        self.assertTrue(claim["claimed"])
        self.assertEqual(claim["since"], "2026-11-12T09:00:00Z")

        status, watermark = self.request("GET", "/api/watermark?project=advancing")
        self.assertEqual(status, 200)
        self.assertEqual(watermark["last_status"], "ok")

    def test_watermark_never_rewinds(self):
        self.request(
            "POST",
            "/api/watermark",
            {"project": "rewind", "last_consolidated": "2026-11-10T00:00:00Z", "status": "ok"},
        )
        self.request(
            "POST",
            "/api/watermark",
            {"project": "rewind", "last_consolidated": "2026-11-01T00:00:00Z", "status": "ok"},
        )
        status, watermark = self.request("GET", "/api/watermark?project=rewind")
        self.assertEqual(status, 200)
        self.assertEqual(watermark["last_consolidated"], "2026-11-10T00:00:00Z")

    def test_failed_status_is_recorded(self):
        status, payload = self.request(
            "POST",
            "/api/watermark",
            {
                "project": "failing",
                "last_consolidated": "2026-11-12T00:00:00Z",
                "status": "failed",
                "error": "transcript unreadable",
            },
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["watermark"]["last_status"], "failed")
        self.assertEqual(payload["watermark"]["last_error"], "transcript unreadable")
        # A failure must not schedule an immediate retry for the same day.
        state = self.request("GET", "/api/context?project=failing")[1]["consolidation"]
        self.assertFalse(state["due"])

    def test_invalid_status_is_rejected(self):
        status, payload = self.request(
            "POST", "/api/watermark", {"project": "failing", "status": "maybe"}
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid-status")

    def test_claim_after_interval_is_due_again(self):
        self.request("POST", "/api/watermark/claim", {"project": "later"})
        # Pretend the claim happened two days ago.
        two_days_ago = memoryd.to_iso(memoryd.utc_now() - timedelta(days=2))
        with self.server.db._lock:
            self.server.db._conn.execute(
                "UPDATE watermark SET last_run_at=? WHERE project=?", (two_days_ago, "later")
            )
            self.server.db._conn.commit()
        claim = self.request(
            "POST", "/api/watermark/claim", {"project": "later", "min_interval_hours": 24}
        )[1]
        self.assertTrue(claim["claimed"])


class ProjectsTests(ServerTestCase):
    def test_projects_summary(self):
        self.add_notes("alpha", ["alpha 的第一条", "alpha 的第二条"])
        self.add_notes("beta", ["beta 的一条"])
        status, payload = self.request("GET", "/api/projects")
        self.assertEqual(status, 200)
        by_id = {entry["id"]: entry for entry in payload["projects"]}
        self.assertIn("alpha", by_id)
        self.assertIn("beta", by_id)
        self.assertEqual(by_id["alpha"]["items"], 2)
        self.assertEqual(by_id["beta"]["items"], 1)
        self.assertTrue(by_id["alpha"]["last_note_at"].endswith("Z"))


class SearchTextTests(unittest.TestCase):
    def test_cjk_bigrams(self):
        text = memoryd.build_search_text("结算模块改为按日结")
        for token in ("结算", "算模", "模块", "按日", "日结"):
            self.assertIn(token, text.split())

    def test_single_cjk_character_is_kept(self):
        self.assertEqual(memoryd.build_search_text("猫"), "猫")

    def test_latin_and_mixed(self):
        tokens = memoryd.build_search_text("React 状态管理 v2.1").split()
        self.assertIn("react", tokens)
        self.assertIn("状态", tokens)
        self.assertIn("态管", tokens)
        self.assertIn("v2", tokens)

    def test_match_query_quotes_tokens(self):
        self.assertEqual(memoryd.build_match_query("日结"), '"日结"')
        self.assertEqual(memoryd.build_match_query(""), "")

    def test_parse_iso_accepts_zulu_and_rejects_garbage(self):
        self.assertIsNotNone(memoryd.parse_iso("2026-11-13T09:20:00Z"))
        self.assertIsNotNone(memoryd.parse_iso("2026-11-13T09:20:00"))
        self.assertIsNone(memoryd.parse_iso("yesterday"))
        self.assertIsNone(memoryd.parse_iso(""))

    def test_normalize_tags(self):
        self.assertEqual(memoryd.normalize_tags(["结算", " 结算 ", "Refund"]), "结算,refund")
        self.assertEqual(memoryd.normalize_tags("a, b，c"), "a,b,c")
        self.assertEqual(memoryd.normalize_tags(None), "")


if __name__ == "__main__":
    unittest.main()
