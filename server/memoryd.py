#!/usr/bin/env python3
"""memoryd - a minimal, self-hosted long-term memory service.

This is the server half of the design in ``DESIGN.md``. It is deliberately
small and boring:

* **Standard library only.** macOS ships Python 3.9 without pip packages, so
  the whole service is ``http.server`` + ``sqlite3`` + ``json``. One file, no
  build step, no virtualenv.
* **Never calls an LLM.** It stores text, indexes it, and returns retrieval
  results. Summarisation belongs to the agent (see the DSH plugin).
* **Fails closed.** Every endpoint except ``/health`` requires a bearer token.
* **Hard limits.** Text size, batch size and body size are validated on the
  server, so a runaway client cannot turn one oversized transcript into a
  thousand billed model calls (see DESIGN.md 2.1).

Usage::

    memoryd.py --init-config            # write config with a fresh token
    memoryd.py                          # run (defaults: 127.0.0.1:8788)
    memoryd.py --check                  # open the DB and print a summary

Run ``memoryd.py --help`` for every option.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import logging
import math
import os
import re
import signal
import sqlite3
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

SCHEMA_VERSION = 1
SERVICE_NAME = "memoryd"
SERVICE_VERSION = 1

MAX_TEXT_CHARS = 4000
MAX_NOTES_PER_REQUEST = 50
MAX_BODY_BYTES = 1_000_000
MAX_DRAIN_BYTES = 8 * MAX_BODY_BYTES
MAX_PROJECT_CHARS = 64

KINDS = ("note", "journal", "manual")
STATUSES = ("ok", "empty", "failed")

PROJECT_RE = re.compile(r"^[\w.:-]{1,%d}$" % MAX_PROJECT_CHARS, re.UNICODE)
TOKEN_RE = re.compile(r"[0-9a-zA-Z_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
CJK_START_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

DEFAULT_RANKING = {
    "bm25": 1.0,
    "recency": 0.35,
    "kind": 0.25,
    "half_life_days": 30.0,
    "kind_weights": {"note": 1.0, "manual": 1.2, "journal": 0.4},
}

DEFAULT_CONFIG = {
    "token": "",
    "host": "127.0.0.1",
    "port": 8788,
    "db_path": "~/dsh-memory/data/memory.db",
    "allow_journal": False,
    "default_context_items": 20,
    "default_context_chars": 1500,
    "min_claim_interval_hours": 24,
    "ranking": DEFAULT_RANKING,
}

log = logging.getLogger(SERVICE_NAME)


# ---------------------------------------------------------------------------
# Time helpers. Everything on the wire is ISO 8601 UTC with a trailing "Z";
# the server never applies a local timezone offset.
# ---------------------------------------------------------------------------


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(moment: Optional[datetime]) -> str:
    if moment is None:
        return ""
    return moment.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_iso() -> str:
    return to_iso(utc_now())


def parse_iso(value: Any) -> Optional[datetime]:
    """Parse an ISO 8601 timestamp; return ``None`` for empty or invalid input."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Chinese-friendly search text.
#
# The bundled FTS5 tokenizer (`unicode61`) treats a run of Han characters as one
# enormous token, so "按日结" would never match a query for "日结". The fix is to
# index overlapping bigrams: "缓存设计" -> "缓存 存设 设计". Queries go through the
# exact same transform, so both sides agree. No custom tokenizer is needed,
# which matters because Python's stdlib sqlite3 cannot load extensions.
# ---------------------------------------------------------------------------


def is_cjk(text: str) -> bool:
    return bool(CJK_START_RE.match(text))


def build_search_text(text: str, max_tokens: int = 2000) -> str:
    """Return the FTS5 body for *text*: lowercased latin tokens + CJK bigrams."""
    lowered = text.lower()
    parts: List[str] = []
    for match in TOKEN_RE.finditer(lowered):
        token = match.group(0)
        if is_cjk(token):
            if len(token) == 1:
                parts.append(token)
            else:
                parts.extend(token[index:index + 2] for index in range(len(token) - 1))
        else:
            parts.append(token)
        if len(parts) >= max_tokens:
            parts = parts[:max_tokens]
            break
    return " ".join(parts)


def build_match_query(text: str) -> str:
    """Turn a free-text query into an FTS5 MATCH expression (OR of quoted tokens)."""
    tokens = build_search_text(text, max_tokens=24).split()
    if not tokens:
        return ""
    quoted = ['"%s"' % token.replace('"', '""') for token in tokens]
    return " OR ".join(quoted)


def normalize_tags(value: Any) -> str:
    """Normalise tags into a lowercase comma-separated string."""
    if value is None:
        return ""
    if isinstance(value, str):
        items: Iterable[str] = re.split(r"[,，]", value)
    elif isinstance(value, (list, tuple)):
        items = [item for item in value if isinstance(item, str)]
    else:
        return ""
    seen: List[str] = []
    for item in items:
        tag = item.strip().lower()
        if tag and tag not in seen:
            seen.append(tag[:32])
    return ",".join(seen)


def clamp_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


# ---------------------------------------------------------------------------
# Errors and validation.
# ---------------------------------------------------------------------------


class ApiError(Exception):
    """An error that maps directly onto an HTTP response."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def require_project(value: Any) -> str:
    if not isinstance(value, str) or not PROJECT_RE.match(value.strip()):
        raise ApiError(
            400,
            "invalid-project",
            "project must be 1-%d characters of letters, digits, dot, colon, dash or underscore"
            % MAX_PROJECT_CHARS,
        )
    return value.strip()


def require_text(value: Any, field: str = "text") -> str:
    if not isinstance(value, str) or not value.strip():
        raise ApiError(400, "invalid-%s" % field, "%s must be a non-empty string" % field)
    text = value.strip()
    if len(text) > MAX_TEXT_CHARS:
        raise ApiError(
            413,
            "text-too-long",
            "%s is %d characters; the limit is %d" % (field, len(text), MAX_TEXT_CHARS),
        )
    return text


def require_kind(value: Any, allow_journal: bool) -> str:
    if value is None:
        return "note"
    if not isinstance(value, str) or value not in KINDS:
        raise ApiError(400, "invalid-kind", "kind must be one of: %s" % ", ".join(KINDS))
    if value == "journal" and not allow_journal:
        raise ApiError(
            400,
            "journal-disabled",
            "journal rows are disabled; this service stores summaries, not raw transcripts",
        )
    return value


# ---------------------------------------------------------------------------
# Storage.
# ---------------------------------------------------------------------------


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('note','journal','manual')),
  text        TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_items_project_kind ON items(project, kind, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  search_text,
  content='items',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
  INSERT INTO items_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

CREATE TABLE IF NOT EXISTS watermark (
  project           TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_consolidated TEXT NOT NULL DEFAULT '',
  last_run_at       TEXT NOT NULL,
  last_status       TEXT NOT NULL DEFAULT 'ok',
  last_error        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


class Database(object):
    """SQLite storage for projects, items and consolidation watermarks.

    A single connection guarded by a lock is enough: the deployment is one
    small process and the data volume is measured in thousands of rows. WAL
    keeps readers from blocking the writer, and ``busy_timeout`` absorbs the
    occasional writer/writer overlap.
    """

    def __init__(self, path: str) -> None:
        directory = os.path.dirname(os.path.abspath(path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=5000")
        with self._lock:
            self._conn.executescript(SCHEMA_SQL)
            row = self._conn.execute("SELECT v FROM meta WHERE k='schema_version'").fetchone()
            if row is None:
                self._conn.execute(
                    "INSERT INTO meta(k, v) VALUES('schema_version', ?)", (str(SCHEMA_VERSION),)
                )
            elif int(row["v"]) != SCHEMA_VERSION:
                raise RuntimeError(
                    "database schema version %s does not match this build (%d)"
                    % (row["v"], SCHEMA_VERSION)
                )
            self._conn.commit()

    # -- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def checkpoint(self) -> None:
        with self._lock:
            self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    # -- projects ----------------------------------------------------------

    def _ensure_project(self, project: str) -> None:
        stamp = now_iso()
        self._conn.execute(
            "INSERT OR IGNORE INTO projects(id, label, created_at, last_seen_at) VALUES(?,?,?,?)",
            (project, project, stamp, stamp),
        )
        self._conn.execute(
            "UPDATE projects SET last_seen_at=? WHERE id=?", (stamp, project)
        )

    def projects(self) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT p.id AS id,
                       p.label AS label,
                       COUNT(i.id) AS items,
                       MAX(i.created_at) AS last_note_at
                FROM projects p
                LEFT JOIN items i ON i.project = p.id
                GROUP BY p.id
                ORDER BY COALESCE(MAX(i.created_at), '') DESC, p.id ASC
                """
            ).fetchall()
            return [
                {
                    "id": row["id"],
                    "label": row["label"] or row["id"],
                    "items": int(row["items"] or 0),
                    "last_note_at": row["last_note_at"] or "",
                }
                for row in rows
            ]

    def counts(self) -> Tuple[int, int]:
        with self._lock:
            projects = int(
                self._conn.execute("SELECT COUNT(*) AS n FROM projects").fetchone()["n"]
            )
            items = int(self._conn.execute("SELECT COUNT(*) AS n FROM items").fetchone()["n"])
            return projects, items

    def count_items(self, project: str) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM items WHERE project=?", (project,)
            ).fetchone()
            return int(row["n"] or 0)

    # -- items -------------------------------------------------------------

    def add_items(
        self,
        project: str,
        entries: List[Dict[str, Any]],
        source: str,
        default_kind: str,
        allow_journal: bool,
    ) -> List[int]:
        """Insert *entries* atomically; return their ids in input order."""
        with self._lock:
            ids: List[int] = []
            stamp = now_iso()
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                self._ensure_project(project)
                for entry in entries:
                    text = require_text(entry.get("text"))
                    kind = require_kind(entry.get("kind") or default_kind, allow_journal)
                    tags = normalize_tags(entry.get("tags"))
                    cursor = self._conn.execute(
                        """
                        INSERT INTO items(project, kind, text, tags, source, created_at, search_text)
                        VALUES(?,?,?,?,?,?,?)
                        """,
                        (project, kind, text, tags, source, stamp, build_search_text(text)),
                    )
                    ids.append(int(cursor.lastrowid))
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
            return ids

    def delete_item(self, item_id: int) -> bool:
        with self._lock:
            cursor = self._conn.execute("DELETE FROM items WHERE id=?", (item_id,))
            self._conn.commit()
            return cursor.rowcount > 0

    def get_item(self, item_id: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, project, kind, text, tags, created_at FROM items WHERE id=?",
                (item_id,),
            ).fetchone()
            return dict(row) if row is not None else None

    def recent_items(self, project: str, limit: int, max_chars: int) -> List[Dict[str, Any]]:
        """Return the compact context view: manual first, then newest, within *max_chars*."""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, kind, text, tags, created_at
                FROM items
                WHERE project = ?
                ORDER BY (kind = 'manual') DESC, created_at DESC, id DESC
                LIMIT ?
                """,
                (project, max(1, limit)),
            ).fetchall()
        selected: List[Dict[str, Any]] = []
        used = 0
        for row in rows:
            text = row["text"]
            cost = len(text) + 1
            if selected and used + cost > max_chars:
                continue
            if not selected and cost > max_chars:
                text = text[: max(0, max_chars - 1)]
                cost = len(text) + 1
            selected.append(
                {
                    "id": int(row["id"]),
                    "kind": row["kind"],
                    "text": text,
                    "tags": row["tags"],
                    "created_at": row["created_at"],
                }
            )
            used += cost
            if used >= max_chars:
                break
        return selected

    def search_items(
        self, project: str, query: str, limit: int, ranking: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Search one project, ranked in Python (bm25 + recency + kind weight)."""
        limit = max(1, limit)
        rows: List[sqlite3.Row] = []
        match = build_match_query(query)
        if match:
            try:
                with self._lock:
                    rows = self._conn.execute(
                        """
                        SELECT i.id AS id, i.kind AS kind, i.text AS text, i.tags AS tags,
                               i.created_at AS created_at, bm25(items_fts) AS rank
                        FROM items_fts JOIN items i ON i.id = items_fts.rowid
                        WHERE items_fts MATCH ? AND i.project = ?
                        ORDER BY rank
                        LIMIT ?
                        """,
                        (match, project, max(limit * 4, 16)),
                    ).fetchall()
            except sqlite3.Error as error:  # malformed MATCH falls back to LIKE
                log.warning("FTS query failed, falling back to LIKE: %s", error)
                rows = []

        if not rows:
            # DESIGN.md 5: small corpora make a LIKE scan an acceptable fallback.
            needle = "%" + query.strip() + "%"
            with self._lock:
                rows = self._conn.execute(
                    """
                    SELECT id, kind, text, tags, created_at, 0.0 AS rank
                    FROM items
                    WHERE project = ?
                      AND (text LIKE ? COLLATE NOCASE OR tags LIKE ? COLLATE NOCASE)
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?
                    """,
                    (project, needle, needle, max(limit * 4, 16)),
                ).fetchall()

        weights = ranking or DEFAULT_RANKING
        kind_weights = weights.get("kind_weights") or DEFAULT_RANKING["kind_weights"]
        half_life = float(weights.get("half_life_days") or 30.0) or 30.0
        now = utc_now()
        scored: List[Dict[str, Any]] = []
        seen = set()
        for row in rows:
            item_id = int(row["id"])
            if item_id in seen:
                continue
            seen.add(item_id)
            created = parse_iso(row["created_at"]) or now
            age_days = max(0.0, (now - created).total_seconds() / 86400.0)
            cost = -float(row["rank"] or 0.0)  # FTS5 bm25() is negative; lower is better.
            score = (
                float(weights.get("bm25", 1.0)) * (1.0 / (1.0 + max(0.0, cost)))
                + float(weights.get("recency", 0.35)) * math.exp(-age_days / half_life)
                + float(weights.get("kind", 0.25)) * float(kind_weights.get(row["kind"], 1.0))
            )
            scored.append(
                {
                    "id": item_id,
                    "kind": row["kind"],
                    "text": row["text"],
                    "tags": row["tags"],
                    "created_at": row["created_at"],
                    "score": round(score, 4),
                }
            )
        scored.sort(key=lambda item: (-item["score"], item["id"]))
        return scored[:limit]

    # -- watermark ---------------------------------------------------------

    def _watermark_row(self, project: str) -> Optional[sqlite3.Row]:
        return self._conn.execute(
            "SELECT project, last_consolidated, last_run_at, last_status, last_error "
            "FROM watermark WHERE project=?",
            (project,),
        ).fetchone()

    def watermark(self, project: str) -> Dict[str, Any]:
        with self._lock:
            row = self._watermark_row(project)
            if row is None:
                return {
                    "project": project,
                    "last_consolidated": "",
                    "last_run_at": "",
                    "last_status": "ok",
                    "last_error": "",
                }
            return {
                "project": project,
                "last_consolidated": row["last_consolidated"],
                "last_run_at": row["last_run_at"],
                "last_status": row["last_status"],
                "last_error": row["last_error"],
            }

    def consolidation_state(self, project: str, min_interval_hours: float) -> Dict[str, Any]:
        """Compute whether a consolidation run is due, without mutating anything."""
        with self._lock:
            row = self._watermark_row(project)
            if row is None:
                return {"due": True, "since": None, "last_run_at": None, "reason": "never-run"}
            interval = timedelta(hours=max(0.0, float(min_interval_hours)))
            now = utc_now()
            last_run = parse_iso(row["last_run_at"])
            since = parse_iso(row["last_consolidated"])
            if last_run is not None and now - last_run < interval:
                return {
                    "due": False,
                    "since": to_iso(since) or None,
                    "last_run_at": to_iso(last_run),
                    "reason": "too_soon",
                    "next_at": to_iso(last_run + interval),
                }
            return {
                "due": True,
                "since": to_iso(since) or None,
                "last_run_at": to_iso(last_run) or None,
                "reason": "due",
            }

    def claim(self, project: str, min_interval_hours: float) -> Dict[str, Any]:
        """Atomically reserve this project's consolidation window.

        Only the caller that wins the claim may summarise; everyone else gets
        ``claimed: false`` and must do nothing. This is what makes the once-a-day
        protocol idempotent when two sessions start at the same time.
        """
        with self._lock:
            state = self.consolidation_state(project, min_interval_hours)
            if not state.get("due"):
                return {
                    "claimed": False,
                    "reason": state.get("reason", "too_soon"),
                    "next_at": state.get("next_at"),
                }
            stamp = now_iso()
            self._conn.execute(
                "INSERT OR IGNORE INTO projects(id, label, created_at, last_seen_at) VALUES(?,?,?,?)",
                (project, project, stamp, stamp),
            )
            self._conn.execute(
                """
                INSERT INTO watermark(project, last_consolidated, last_run_at, last_status, last_error)
                VALUES(?, '', ?, 'ok', '')
                ON CONFLICT(project) DO UPDATE SET last_run_at=excluded.last_run_at
                """,
                (project, stamp),
            )
            self._conn.commit()
            since = state.get("since")
            if not since:
                # A brand-new project has nothing to advance from.
                since = None
            return {"claimed": True, "since": since}

    def set_watermark(
        self, project: str, last_consolidated: str, status: str, error: str = ""
    ) -> Dict[str, Any]:
        with self._lock:
            stamp = now_iso()
            self._conn.execute(
                "INSERT OR IGNORE INTO projects(id, label, created_at, last_seen_at) VALUES(?,?,?,?)",
                (project, project, stamp, stamp),
            )
            row = self._watermark_row(project)
            current = row["last_consolidated"] if row is not None else ""
            target = last_consolidated or current
            current_dt = parse_iso(current)
            target_dt = parse_iso(target)
            if current_dt is not None and target_dt is not None and target_dt < current_dt:
                # Watermarks only move forward; a late writer must not rewind them.
                target = current
            if status == "failed":
                self._conn.execute(
                    """
                    INSERT INTO watermark(project, last_consolidated, last_run_at, last_status, last_error)
                    VALUES(?, ?, ?, ?, ?)
                    ON CONFLICT(project) DO UPDATE SET
                      last_consolidated=excluded.last_consolidated,
                      last_status=excluded.last_status,
                      last_error=excluded.last_error
                    """,
                    (project, target, stamp, status, (error or "")[:500]),
                )
            else:
                self._conn.execute(
                    """
                    INSERT INTO watermark(project, last_consolidated, last_run_at, last_status, last_error)
                    VALUES(?, ?, ?, ?, ?)
                    ON CONFLICT(project) DO UPDATE SET
                      last_consolidated=excluded.last_consolidated,
                      last_run_at=excluded.last_run_at,
                      last_status=excluded.last_status,
                      last_error=excluded.last_error
                    """,
                    (project, target, stamp, status, ""),
                )
            self._conn.commit()
            return self.watermark(project)


# ---------------------------------------------------------------------------
# HTTP layer.
# ---------------------------------------------------------------------------


def json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    """Request router. One instance per connection, as `http.server` requires."""

    server_version = "%s/%d" % (SERVICE_NAME, SERVICE_VERSION)
    protocol_version = "HTTP/1.1"

    # -- infrastructure ----------------------------------------------------

    @property
    def app(self):  # type: ignore[no-untyped-def]
        return self.server  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        log.debug("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, payload: Any) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            # Error replies may leave an unread request body behind; closing the
            # connection keeps the next request from being parsed as leftover bytes.
            self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_error(self, status: int, code: str, message: str) -> None:
        self.close_connection = True
        self._send_json(status, {"error": {"code": code, "message": message}})

    def _authorized(self) -> bool:
        expected = self.app.config["token"]
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        provided = header[len("Bearer "):].strip()
        if not provided or not expected:
            return False
        return hmac.compare_digest(
            hashlib.sha256(provided.encode("utf-8")).digest(),
            hashlib.sha256(expected.encode("utf-8")).digest(),
        )

    def _read_json(self) -> Dict[str, Any]:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ApiError(411, "length-required", "Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError:
            raise ApiError(400, "invalid-length", "Content-Length must be an integer")
        if length < 0:
            raise ApiError(400, "invalid-length", "Content-Length must be positive")
        if length > MAX_BODY_BYTES:
            # Read (and discard) the oversized body before answering, otherwise
            # the client can see a connection reset instead of the 413.
            self._drain(length)
            self.close_connection = True
            raise ApiError(413, "body-too-large", "request body exceeds 1 MB")
        body = self.rfile.read(length)
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "invalid-json", "request body is not valid UTF-8 JSON")
        if not isinstance(payload, dict):
            raise ApiError(400, "invalid-body", "request body must be a JSON object")
        return payload

    def _drain(self, length: int) -> None:
        """Consume an oversized body so the error response can be delivered."""
        remaining = min(length, MAX_DRAIN_BYTES)
        while remaining > 0:
            chunk = self.rfile.read(min(65536, remaining))
            if not chunk:
                return
            remaining -= len(chunk)

    # -- verbs -------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def do_PUT(self) -> None:  # noqa: N802
        self._send_error(405, "method-not-allowed", "method not allowed")

    def do_PATCH(self) -> None:  # noqa: N802
        self._send_error(405, "method-not-allowed", "method not allowed")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send_error(405, "method-not-allowed", "method not allowed")

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        if path == "/health":
            if method != "GET":
                self._send_error(405, "method-not-allowed", "method not allowed")
                return
            self._handle_health()
            return
        if not self._authorized():
            self._send_error(401, "unauthorized", "missing or invalid bearer token")
            return
        try:
            self._route(method, path, query)
        except ApiError as error:
            self._send_error(error.status, error.code, error.message)
        except (BrokenPipeError, ConnectionResetError):
            raise
        except Exception as error:  # pragma: no cover - defensive
            log.exception("request failed: %s %s", method, path)
            self._send_error(500, "internal", "internal error: %s" % error)

    def _route(self, method: str, path: str, query: Dict[str, List[str]]) -> None:
        db = self.app.db
        config = self.app.config

        if method == "GET" and path == "/api/context":
            project = require_project(self._query_one(query, "project"))
            limit = clamp_int(
                self._query_one(query, "limit"), int(config["default_context_items"]), 1, 100
            )
            max_chars = clamp_int(
                self._query_one(query, "max_chars"), int(config["default_context_chars"]), 200, 20000
            )
            items = db.recent_items(project, limit, max_chars)
            watermark = db.watermark(project)
            state = db.consolidation_state(project, config["min_claim_interval_hours"])
            self._send_json(
                200,
                {
                    "project": project,
                    "items": items,
                    "total": db.count_items(project),
                    "watermark": watermark,
                    "consolidation": {
                        "due": bool(state.get("due")),
                        "since": state.get("since"),
                        "reason": state.get("reason"),
                        "next_at": state.get("next_at"),
                    },
                },
            )
            return

        if method == "GET" and path == "/api/search":
            project = require_project(self._query_one(query, "project"))
            text = self._query_one(query, "q") or ""
            if not text.strip():
                raise ApiError(400, "invalid-q", "q must be a non-empty search string")
            limit = clamp_int(self._query_one(query, "limit"), 8, 1, 50)
            items = db.search_items(project, text, limit, config["ranking"])
            self._send_json(200, {"project": project, "query": text, "items": items})
            return

        if method == "POST" and path == "/api/notes":
            payload = self._read_json()
            project = require_project(payload.get("project"))
            notes = payload.get("notes")
            if not isinstance(notes, list) or not notes:
                raise ApiError(400, "invalid-notes", "notes must be a non-empty array")
            if len(notes) > MAX_NOTES_PER_REQUEST:
                raise ApiError(
                    413,
                    "too-many-notes",
                    "at most %d notes per request" % MAX_NOTES_PER_REQUEST,
                )
            entries: List[Dict[str, Any]] = []
            for index, note in enumerate(notes):
                if not isinstance(note, dict):
                    raise ApiError(400, "invalid-notes", "notes[%d] must be an object" % index)
                if not isinstance(note.get("text"), str):
                    raise ApiError(
                        400, "invalid-text", "notes[%d].text must be a string" % index
                    )
                entries.append(note)
            source = payload.get("source")
            source = source.strip()[:64] if isinstance(source, str) else "consolidate"
            kind = require_kind(payload.get("kind") or "note", config["allow_journal"])
            ids = db.add_items(project, entries, source, kind, config["allow_journal"])
            self._send_json(200, {"stored": len(ids), "ids": ids})
            return

        if method == "POST" and path == "/api/items":
            payload = self._read_json()
            project = require_project(payload.get("project"))
            kind = require_kind(payload.get("kind") or "manual", config["allow_journal"])
            source = payload.get("source")
            source = source.strip()[:64] if isinstance(source, str) else "manual"
            ids = db.add_items(project, [payload], source, kind, config["allow_journal"])
            self._send_json(200, {"id": ids[0]})
            return

        match = re.match(r"^/api/items/(\d+)$", path)
        if match and method == "DELETE":
            item_id = int(match.group(1))
            deleted = db.delete_item(item_id)
            if not deleted:
                raise ApiError(404, "not-found", "no item with id %d" % item_id)
            self._send_json(200, {"deleted": True, "id": item_id})
            return

        if method == "GET" and path == "/api/watermark":
            project = require_project(self._query_one(query, "project"))
            self._send_json(200, db.watermark(project))
            return

        if method == "POST" and path == "/api/watermark":
            payload = self._read_json()
            project = require_project(payload.get("project"))
            last_consolidated = payload.get("last_consolidated")
            if last_consolidated is not None and not isinstance(last_consolidated, str):
                raise ApiError(
                    400, "invalid-last-consolidated", "last_consolidated must be an ISO timestamp"
                )
            if last_consolidated and parse_iso(last_consolidated) is None:
                raise ApiError(
                    400, "invalid-last-consolidated", "last_consolidated must be ISO 8601 UTC"
                )
            status = payload.get("status") or "ok"
            if status not in STATUSES:
                raise ApiError(400, "invalid-status", "status must be one of: %s" % ", ".join(STATUSES))
            error = payload.get("error")
            result = db.set_watermark(
                project,
                last_consolidated or "",
                status,
                error if isinstance(error, str) else "",
            )
            self._send_json(200, {"ok": True, "watermark": result})
            return

        if method == "POST" and path == "/api/watermark/claim":
            payload = self._read_json()
            project = require_project(payload.get("project"))
            hours = payload.get("min_interval_hours")
            if hours is None:
                hours = config["min_claim_interval_hours"]
            try:
                hours = float(hours)
            except (TypeError, ValueError):
                raise ApiError(400, "invalid-interval", "min_interval_hours must be a number")
            if hours < 0 or hours > 24 * 365:
                raise ApiError(400, "invalid-interval", "min_interval_hours is out of range")
            self._send_json(200, db.claim(project, hours))
            return

        if method == "GET" and path == "/api/projects":
            self._send_json(200, {"projects": db.projects()})
            return

        if path.startswith("/api/"):
            raise ApiError(404, "not-found", "no such endpoint: %s %s" % (method, path))
        raise ApiError(404, "not-found", "no such path: %s" % path)

    # -- helpers -----------------------------------------------------------

    def _query_one(self, query: Dict[str, List[str]], name: str) -> Optional[str]:
        values = query.get(name)
        if not values:
            return None
        return values[0]

    def _handle_health(self) -> None:
        try:
            projects, items = self.app.db.counts()
        except Exception as error:  # pragma: no cover - defensive
            log.exception("health check failed")
            self._send_json(503, {"ok": False, "error": {"code": "db", "message": str(error)}})
            return
        self._send_json(
            200,
            {
                "ok": True,
                "service": SERVICE_NAME,
                "version": SERVICE_VERSION,
                "schema": SCHEMA_VERSION,
                "projects": projects,
                "items": items,
                "time": now_iso(),
            },
        )


class MemoryServer(ThreadingHTTPServer):
    """Threaded HTTP server carrying the database and the resolved config."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: Tuple[str, int], db: Database, config: Dict[str, Any]) -> None:
        self.db = db
        self.config = config
        super().__init__(address, Handler)


# ---------------------------------------------------------------------------
# Configuration and entry point.
# ---------------------------------------------------------------------------


def config_path() -> str:
    override = os.environ.get("MEMORYD_CONFIG")
    if override:
        return os.path.expanduser(override)
    return os.path.expanduser("~/.config/dsh-memory/config.json")


def load_config(path: Optional[str] = None, overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Merge defaults, the JSON config file, environment variables and CLI flags."""
    config = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    target = os.path.expanduser(path) if path else config_path()
    if os.path.exists(target):
        with open(target, "r", encoding="utf-8-sig") as handle:
            try:
                stored = json.load(handle)
            except ValueError as error:
                raise SystemExit("config file %s is not valid JSON: %s" % (target, error))
        if not isinstance(stored, dict):
            raise SystemExit("config file %s must contain a JSON object" % target)
        for key, value in stored.items():
            if key == "ranking" and isinstance(value, dict):
                merged = dict(DEFAULT_RANKING)
                merged.update(value)
                config["ranking"] = merged
            else:
                config[key] = value
    config["config_path"] = target

    env_map = {
        "MEMORYD_TOKEN": "token",
        "MEMORYD_HOST": "host",
        "MEMORYD_PORT": "port",
        "MEMORYD_DB": "db_path",
        "MEMORYD_ALLOW_JOURNAL": "allow_journal",
    }
    for env_name, key in env_map.items():
        raw = os.environ.get(env_name)
        if raw is None or raw == "":
            continue
        if key == "port":
            config[key] = clamp_int(raw, 8788, 0, 65535)
        elif key == "allow_journal":
            config[key] = raw.strip().lower() in ("1", "true", "yes", "on")
        else:
            config[key] = raw

    if overrides:
        for key, value in overrides.items():
            if value is not None:
                config[key] = value

    config["port"] = clamp_int(config.get("port"), 8788, 0, 65535)
    config["db_path"] = os.path.expanduser(str(config.get("db_path") or DEFAULT_CONFIG["db_path"]))
    config["min_claim_interval_hours"] = float(config.get("min_claim_interval_hours") or 24)
    if not isinstance(config.get("ranking"), dict):
        config["ranking"] = json.loads(json.dumps(DEFAULT_RANKING))
    return config


EXAMPLE_CONFIG = {
    "token": "",
    "host": "127.0.0.1",
    "port": 8788,
    "db_path": "~/dsh-memory/data/memory.db",
    "allow_journal": False,
    "default_context_items": 20,
    "default_context_chars": 1500,
    "min_claim_interval_hours": 24,
    "ranking": DEFAULT_RANKING,
}


def write_example_config(path: str) -> str:
    """Create a config file with a fresh random token, mode 600."""
    target = os.path.expanduser(path)
    directory = os.path.dirname(target)
    if directory:
        os.makedirs(directory, exist_ok=True)
    if os.path.exists(target):
        raise SystemExit("refusing to overwrite existing config: %s" % target)
    token = "mem_" + hashlib.sha256(os.urandom(32)).hexdigest()[:40]
    payload = dict(EXAMPLE_CONFIG)
    payload["token"] = token
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    try:
        os.chmod(target, 0o600)
    except OSError:  # pragma: no cover - Windows has no POSIX modes
        pass
    return token


def build_server(config: Dict[str, Any]) -> MemoryServer:
    db = Database(config["db_path"])
    return MemoryServer((config["host"], int(config["port"])), db, config)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog=SERVICE_NAME,
        description="Self-hosted long-term memory service (Python 3.9 stdlib only).",
    )
    parser.add_argument("--config", help="path to config JSON (default: ~/.config/dsh-memory/config.json)")
    parser.add_argument("--host", help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, help="bind port (default: 8788)")
    parser.add_argument("--db", help="SQLite file path (default: ~/dsh-memory/data/memory.db)")
    parser.add_argument("--token", help="bearer token (prefer the config file)")
    parser.add_argument("--allow-journal", action="store_true", default=None,
                        help="permit kind=journal rows (off by default)")
    parser.add_argument("--log-level", default="INFO", help="DEBUG, INFO, WARNING, ERROR")
    parser.add_argument("--init-config", action="store_true", help="write a config with a fresh token")
    parser.add_argument("--check", action="store_true", help="open the database and print a summary")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if args.init_config:
        target = args.config or config_path()
        token = write_example_config(target)
        print("wrote %s" % os.path.expanduser(target))
        print("token: %s" % token)
        print("Give this token to the DSH plugin as `token` or `tokenFile`.")
        return 0

    config = load_config(
        args.config,
        {
            "host": args.host,
            "port": args.port,
            "db_path": args.db,
            "token": args.token,
            "allow_journal": args.allow_journal,
        },
    )
    if not str(config.get("token") or "").strip():
        raise SystemExit(
            "no token configured; run `memoryd.py --init-config` or set MEMORYD_TOKEN"
        )

    if args.check:
        db = Database(config["db_path"])
        projects, items = db.counts()
        print("db: %s" % config["db_path"])
        print("schema: %d" % SCHEMA_VERSION)
        print("projects: %d  items: %d" % (projects, items))
        for project in db.projects():
            print(
                "  - %-24s items=%-5d last_note=%s"
                % (project["id"], project["items"], project["last_note_at"] or "-")
            )
        db.close()
        return 0

    server = build_server(config)
    log.info(
        "%s %d listening on http://%s:%d (db: %s)",
        SERVICE_NAME,
        SERVICE_VERSION,
        config["host"],
        int(config["port"]),
        config["db_path"],
    )

    def shutdown(signum, frame):  # type: ignore[no-untyped-def]
        log.info("signal %s received, shutting down", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    for signal_name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, signal_name):
            try:
                signal.signal(getattr(signal, signal_name), shutdown)
            except ValueError:  # pragma: no cover - non-main thread
                pass

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        server.db.close()
        log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
