#!/usr/bin/env python3
"""Pull the append-only D1 audit outbox into a local SQLite audit copy.

Configuration is read only from environment variables:
  AUDIT_API_URL       HTTPS Worker origin, e.g. https://isp.example.com
  AUDIT_ADMIN_SECRET  High-entropy admin secret (never stored in SQLite)
  AUDIT_DB_PATH       Local SQLite file (default: ./audit/audit.sqlite3)

Run periodically on a trusted machine. The local copy is eventual, not a
synchronous dual write; D1 remains authoritative. The sync is replay-safe.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS audit_events (
  event_id INTEGER PRIMARY KEY,
  actor_user_id TEXT,
  event_type TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'local audit events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'local audit events are append-only');
END;
CREATE TABLE IF NOT EXISTS audit_sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_event_id INTEGER NOT NULL,
  chain_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO audit_sync_state (singleton, last_event_id, chain_hash)
VALUES (1, 0, '');
"""

GENESIS_HASH = "0" * 64


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def record_hash(previous_hash: str, event: dict[str, Any]) -> str:
    material = previous_hash.encode("ascii") + b"\n" + canonical_json(event).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def connect_db(path: str) -> sqlite3.Connection:
    if path == ":memory:":
        target = None
        db = sqlite3.connect(":memory:", timeout=30)
    else:
        requested = Path(path).expanduser()
        if requested.is_symlink():
            raise ValueError("AUDIT_DB_PATH must not be a symbolic link")
        target = requested.resolve()
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        db = sqlite3.connect(str(target), timeout=30)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    db.execute("PRAGMA synchronous = FULL")
    if target is not None:
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
    return db


def validate_event(event: Any) -> dict[str, Any]:
    if not isinstance(event, dict):
        raise ValueError("audit event must be an object")
    event_id = event.get("event_id")
    if isinstance(event_id, bool) or not isinstance(event_id, int) or event_id <= 0:
        raise ValueError("audit event_id must be a positive integer")
    if not isinstance(event.get("event_type"), str) or not event["event_type"]:
        raise ValueError("audit event_type is required")
    if not isinstance(event.get("created_at"), str) or not event["created_at"]:
        raise ValueError("audit created_at is required")
    if not isinstance(event.get("details"), (dict, list, str, int, float, bool, type(None))):
        raise ValueError("invalid audit details")
    for field in ("actor_user_id", "target_id"):
        if event.get(field) is not None and not isinstance(event[field], str):
            raise ValueError(f"invalid {field}")
    return event


def verify_chain(db: sqlite3.Connection) -> tuple[int, str]:
    previous = ""
    last_id = 0
    for row in db.execute("SELECT * FROM audit_events ORDER BY event_id ASC"):
        event = {
            "event_id": row["event_id"],
            "actor_user_id": row["actor_user_id"],
            "event_type": row["event_type"],
            "target_id": row["target_id"],
            "details": json.loads(row["details_json"]),
            "created_at": row["created_at"],
        }
        expected = record_hash(previous, event)
        if row["previous_hash"] != previous or row["record_hash"] != expected:
            raise ValueError(f"local audit chain verification failed at event {row['event_id']}")
        if row["event_id"] <= last_id:
            raise ValueError("audit event IDs are not strictly increasing")
        previous = expected
        last_id = row["event_id"]
    state = db.execute("SELECT last_event_id, chain_hash FROM audit_sync_state WHERE singleton = 1").fetchone()
    if not state or state["last_event_id"] != last_id or state["chain_hash"] != previous:
        raise ValueError("audit checkpoint does not match local event chain")
    return last_id, previous


def append_events(db: sqlite3.Connection, events: Iterable[dict[str, Any]]) -> int:
    batch = [validate_event(event) for event in events]
    db.execute("BEGIN IMMEDIATE")
    try:
        state = db.execute("SELECT last_event_id, chain_hash FROM audit_sync_state WHERE singleton = 1").fetchone()
        last_id = int(state["last_event_id"])
        previous = str(state["chain_hash"])
        added = 0
        for event in batch:
            event_id = event["event_id"]
            if event_id <= last_id:
                existing = db.execute("SELECT record_hash FROM audit_events WHERE event_id = ?", (event_id,)).fetchone()
                if existing:
                    candidate = record_hash(str(db.execute("SELECT previous_hash FROM audit_events WHERE event_id = ?", (event_id,)).fetchone()[0]), event)
                    if candidate != existing["record_hash"]:
                        raise ValueError(f"D1 event {event_id} conflicts with the local audit copy")
                    continue
                raise ValueError("D1 returned an event older than the saved cursor")
            if event_id <= last_id:
                raise ValueError("D1 audit events must be strictly increasing")
            details_json = canonical_json(event.get("details"))
            normalized = {
                "event_id": event_id,
                "actor_user_id": event.get("actor_user_id"),
                "event_type": event["event_type"],
                "target_id": event.get("target_id"),
                "details": json.loads(details_json),
                "created_at": event["created_at"],
            }
            current_hash = record_hash(previous, normalized)
            db.execute(
                "INSERT INTO audit_events (event_id, actor_user_id, event_type, target_id, details_json, created_at, previous_hash, record_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (event_id, normalized["actor_user_id"], normalized["event_type"], normalized["target_id"], details_json, normalized["created_at"], previous, current_hash),
            )
            last_id, previous = event_id, current_hash
            added += 1
        db.execute("UPDATE audit_sync_state SET last_event_id = ?, chain_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1", (last_id, previous))
        db.commit()
        return added
    except Exception:
        db.rollback()
        raise


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_origin(raw: str) -> str:
    parsed = urllib.parse.urlparse(raw)
    local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not local_http:
        raise ValueError("AUDIT_API_URL must use HTTPS (HTTP is allowed only for localhost)")
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("AUDIT_API_URL must be an origin URL without credentials, query, or fragment")
    if parsed.path not in ("", "/"):
        raise ValueError("AUDIT_API_URL must be an origin, not a path")
    return f"{parsed.scheme}://{parsed.netloc}"


def fetch_page(origin: str, secret: str, after_id: int, limit: int = 500) -> dict[str, Any]:
    query = urllib.parse.urlencode({"after_id": after_id, "limit": limit})
    url = f"{origin}/api/admin/audit/events?{query}"
    request = urllib.request.Request(url, headers={"X-Admin-Secret": secret, "Accept": "application/json"})
    opener = urllib.request.build_opener(NoRedirectHandler())
    try:
        with opener.open(request, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError(f"audit endpoint returned HTTP {response.status}")
            body = response.read(2_000_001)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"audit endpoint returned HTTP {error.code}") from None
    if len(body) > 2_000_000:
        raise RuntimeError("audit response exceeded the 2 MB safety limit")
    payload = json.loads(body.decode("utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("events"), list):
        raise ValueError("invalid audit endpoint response")
    return payload


def sync(origin: str, secret: str, db: sqlite3.Connection) -> int:
    added_total = 0
    while True:
        last_id, _ = verify_chain(db)
        payload = fetch_page(origin, secret, last_id)
        events = payload["events"]
        if not events:
            return added_total
        previous_id = last_id
        for event in events:
            validate_event(event)
            if event["event_id"] <= previous_id:
                raise ValueError("D1 returned unsorted or duplicate event IDs")
            previous_id = event["event_id"]
        added_total += append_events(db, events)
        next_after = payload.get("next_after_id")
        if next_after != previous_id:
            raise ValueError("D1 audit cursor does not match the final returned event")
        verify_chain(db)
        if not payload.get("has_more"):
            return added_total


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="verify the local hash chain without contacting D1")
    args = parser.parse_args()
    db_path = os.environ.get("AUDIT_DB_PATH", "./audit/audit.sqlite3")
    try:
        with connect_db(db_path) as db:
            if args.verify_only:
                event_id, _ = verify_chain(db)
                print(f"Verified local audit chain through event {event_id}.")
                return 0
            raw_origin = os.environ.get("AUDIT_API_URL", "")
            secret = os.environ.get("AUDIT_ADMIN_SECRET", "")
            if not raw_origin or len(secret.encode("utf-8")) < 32:
                raise ValueError("Set AUDIT_API_URL and a 32-byte minimum AUDIT_ADMIN_SECRET in the environment")
            origin = validate_origin(raw_origin)
            added = sync(origin, secret, db)
            last_id, _ = verify_chain(db)
            print(f"Imported {added} new audit event(s); verified through event {last_id} in {Path(db_path).expanduser()}.")
        return 0
    except (OSError, sqlite3.Error, urllib.error.URLError, json.JSONDecodeError, ValueError, RuntimeError) as error:
        print(f"Audit sync failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
