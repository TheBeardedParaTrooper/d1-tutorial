-- 0006: staff sign-in names must be unique ignoring case, at the schema level.
--
-- Why this exists: migration 0005 added idx_admin_users_username as a plain
-- (non-unique) index for lookup speed, and the case-collision rule lived only
-- in a BEFORE UPDATE trigger plus the console's own pre-check. That left the
-- insert path open: a row named 'ADMIN' could sit next to 'admin', and login
-- resolves with lower(username) = ?, so a privileged lookup could silently pick
-- the wrong account. Customers were already covered by the unique
-- idx_users_username_lower from migration 0004; staff were not.
--
-- The fix is the index itself, so no application code path can bypass it.

-- 1. Any name that only differs in case from an older account is disabled and
--    renamed, so the unique index can be created at all. Newest rows lose.
UPDATE admin_users
SET username = substr(username, 1, 12) || '_dup_' || substr(id, 1, 8),
    active = 0,
    must_change_password = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE lower(username) IN (
  SELECT lower(username) FROM admin_users GROUP BY lower(username) HAVING COUNT(*) > 1
)
AND id NOT IN (
  SELECT MIN(id) FROM admin_users GROUP BY lower(username)
);

-- 2. Same treatment for lookalike email addresses.
UPDATE admin_users
SET email = NULL, active = 0, updated_at = CURRENT_TIMESTAMP
WHERE lower(email) IN (
  SELECT lower(email) FROM admin_users WHERE email IS NOT NULL GROUP BY lower(email) HAVING COUNT(*) > 1
)
AND id NOT IN (
  SELECT MIN(id) FROM admin_users WHERE email IS NOT NULL GROUP BY lower(email)
);

-- 3. The guarantee, as a constraint rather than a convention.
DROP INDEX IF EXISTS idx_admin_users_username;
CREATE UNIQUE INDEX idx_admin_users_username ON admin_users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email_lower
  ON admin_users (lower(email)) WHERE email IS NOT NULL;

-- 4. Say so in the audit trail; this file changes who can sign in as staff.
INSERT INTO audit_outbox (event_type, target_id, details_json)
VALUES (
  'admin.schema_username_case_unique',
  NULL,
  json_object('enforced_by', 'unique index on lower(username)', 'deduped_rows', (
    SELECT COUNT(*) FROM admin_users WHERE active = 0 AND username LIKE '%_dup_%'
  ))
);
