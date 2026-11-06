import sqlite3
import unittest

from scripts.sync_audit import append_events, connect_db, validate_origin, verify_chain


def event(event_id, event_type="payment.order_created"):
    return {
        "event_id": event_id,
        "actor_user_id": "user-1",
        "event_type": event_type,
        "target_id": f"order-{event_id}",
        "details": {"amount": 2500, "currency": "TZS"},
        "created_at": "2026-10-06 12:00:00",
    }


class AuditSyncTests(unittest.TestCase):
    def setUp(self):
        self.db = connect_db(":memory:")

    def tearDown(self):
        self.db.close()

    def test_append_and_verify_chain(self):
        self.assertEqual(append_events(self.db, [event(3), event(8)]), 2)
        self.assertEqual(verify_chain(self.db)[0], 8)

    def test_local_events_are_append_only(self):
        append_events(self.db, [event(1)])
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE audit_events SET event_type = 'forged' WHERE event_id = 1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM audit_events WHERE event_id = 1")

    def test_bad_batch_rolls_back_every_event_and_cursor(self):
        with self.assertRaises(ValueError):
            append_events(self.db, [event(1), {"event_id": "bad"}])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0], 0)
        self.assertEqual(verify_chain(self.db)[0], 0)

    def test_tampering_is_detected(self):
        append_events(self.db, [event(1)])
        # Simulate an operator disabling local protections and modifying the file.
        self.db.execute("DROP TRIGGER audit_events_no_update")
        self.db.execute("UPDATE audit_events SET details_json = '{\"amount\":1}' WHERE event_id = 1")
        with self.assertRaisesRegex(ValueError, "chain verification failed"):
            verify_chain(self.db)

    def test_remote_origins_require_https(self):
        self.assertEqual(validate_origin("https://audit.example.test/"), "https://audit.example.test")
        self.assertEqual(validate_origin("http://127.0.0.1:8787"), "http://127.0.0.1:8787")
        with self.assertRaises(ValueError):
            validate_origin("http://audit.example.test")
        with self.assertRaises(ValueError):
            validate_origin("https://audit.example.test/path")


if __name__ == "__main__":
    unittest.main()
