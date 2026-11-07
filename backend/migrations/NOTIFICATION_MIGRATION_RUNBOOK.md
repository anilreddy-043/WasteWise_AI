# WasteWise AI Notification Migration Runbook

This runbook is for the single-store WasteWise AI MySQL 8.0.46 database
(`wastewise_ai`). It documents the two additive notification migrations. It
does not authorize applying them to a different schema or granting privileges
to the runtime application account.

## Migration files and order

Apply the files in this order, only after the preflight confirms each target
table is absent:

1. `20261106_add_user_notification_settings.sql`
2. `20261106_create_user_notifications.sql`

The first creates `user_notification_settings`, which holds one preference row
per user. The second creates `user_notifications`, which holds deduplicated
notification events and recipient-specific read state. Neither migration
updates or deletes existing users, products, inventory, sales, waste, or audit
records, and neither migrates or synthesizes notification records.

## DBA execution checklist

- [ ] Confirm the maintenance window and take or verify a recoverable database
  backup using the established DBA procedure.
- [ ] Connect to the intended MySQL 8.0.46 server using an authorized
  DBA/schema-migration account; never use the application account.
- [ ] Confirm `SELECT DATABASE()` returns exactly `wastewise_ai` and confirm
  the server version is 8.0.46 (or the approved MySQL 8.0-compatible version).
- [ ] Record the pre-migration table-presence, schema, grant, and operational
  row-count query results below.
- [ ] Confirm `users` exists as InnoDB and `users.user_id` is a primary/unique
  `BIGINT UNSIGNED` key.
- [ ] If either notification table already exists, compare its complete
  definition with this runbook and the corresponding SQLAlchemy model.
  **Do not run a create statement on an existing mismatched table.** Stop and
  resolve schema drift through the normal DBA process; do not drop or
  overwrite it as part of this package.
- [ ] Confirm the required DBA grants described below are available.
- [ ] Apply only missing migration(s), in the order above, one file at a time.
- [ ] Record each command’s exit code/output. Stop on any SQL error.
- [ ] Run all post-migration checks and compare operational row counts with the
  pre-migration values.
- [ ] Keep notification endpoints disabled/unannounced until the schema
  verification is clean and the application’s notification tests pass.

MySQL DDL implicitly commits; the two files are not one atomic transaction.
Do not use a client option that continues after SQL errors.

## Read-only preflight

Run these statements in a session connected to the intended database. They
read metadata and row counts only.

```sql
SELECT VERSION() AS mysql_version, DATABASE() AS selected_schema;

SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'users',
    'user_notification_settings',
    'user_notifications'
  )
ORDER BY TABLE_NAME;

SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE,
       IS_NULLABLE, COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'users',
    'user_notification_settings',
    'user_notifications'
  )
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
       SUB_PART, INDEX_TYPE
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'users',
    'user_notification_settings',
    'user_notifications'
  )
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME,
       k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
       r.UPDATE_RULE, r.DELETE_RULE
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS k
LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS r
  ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
 AND r.TABLE_NAME = k.TABLE_NAME
 AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
WHERE k.CONSTRAINT_SCHEMA = DATABASE()
  AND k.TABLE_NAME IN (
    'user_notification_settings',
    'user_notifications'
  )
  AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME;

SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'inventory_batches', COUNT(*) FROM inventory_batches
UNION ALL SELECT 'sales_records', COUNT(*) FROM sales_records
UNION ALL SELECT 'waste_records', COUNT(*) FROM waste_records
UNION ALL SELECT 'user_activity', COUNT(*) FROM user_activity;
```

Interpret `TABLE_NAME` results as follows:

- `users` must exist and be InnoDB.
- If `user_notification_settings` is absent, its migration may be applied.
  If present, verify it fully and skip its non-idempotent migration.
- If `user_notifications` is absent, its migration may be applied. If present,
  verify it fully before deciding whether it is already correct.
- A table’s presence alone is insufficient. `CREATE TABLE IF NOT EXISTS`
  silently leaves a preexisting table unchanged, even if its definition is
  incompatible.

Before creating child tables, confirm that `users.user_id` is
`BIGINT UNSIGNED`, indexed as primary or unique, and belongs to an InnoDB
table. Capture the row counts above for comparison after the DDL.

## Required privileges

Use a DBA/schema-migration principal with, at minimum:

- `CREATE` on the `wastewise_ai` schema to create the two tables and their
  indexes.
- `REFERENCES` on `wastewise_ai.users` for the foreign keys, where required
  by the server’s privilege configuration.
- Permission to run the read-only metadata and count checks in this runbook.

The migration does not require `INSERT`, `UPDATE`, or `DELETE` on existing
operational tables. Do not grant schema-management privileges to the
application account. Its runtime grants remain unchanged. The DBA must follow
local privilege policy if the server already allows foreign-key creation
without a separate `REFERENCES` grant.

## Execute

From the repository root, invoke each command separately and enter the DBA
password at the prompt. Replace only the host/port if the approved database
endpoint differs; retain `wastewise_ai` as the schema unless a separately
reviewed deployment explicitly uses another one.

Run the first command only if preflight confirms
`user_notification_settings` is absent:

```powershell
mysql -h 127.0.0.1 -P 3306 -u <DBA_USER> -p wastewise_ai < backend\migrations\20261106_add_user_notification_settings.sql
```

After confirming that command succeeded, run the second only if preflight
confirms `user_notifications` is absent:

```powershell
mysql -h 127.0.0.1 -P 3306 -u <DBA_USER> -p wastewise_ai < backend\migrations\20261106_create_user_notifications.sql
```

Do not place passwords in the command, scripts, logs, or this runbook. Do not
run the same command blindly as a retry: the settings migration is not
rerunnable. Re-run preflight after an interrupted or ambiguous command and
inspect the resulting table before taking further action.

## Expected schema

Both tables must use InnoDB, `utf8mb4`, and `utf8mb4_unicode_ci`. Their
`user_id` foreign keys reference `users.user_id` and cascade `UPDATE` and
`DELETE`.

### `user_notification_settings`

| Column | Expected MySQL definition | Notes |
|---|---|---|
| `user_id` | `BIGINT UNSIGNED NOT NULL` | Primary key; FK to `users.user_id` |
| `expiry_alerts` | `BOOLEAN NOT NULL DEFAULT TRUE` | MySQL reports `BOOLEAN` as `TINYINT(1)` |
| `low_stock_alerts` | `BOOLEAN NOT NULL DEFAULT TRUE` | Same |
| `high_demand_alerts` | `BOOLEAN NOT NULL DEFAULT TRUE` | Same |
| `daily_reports` | `BOOLEAN NOT NULL DEFAULT FALSE` | Same |
| `weekly_insights` | `BOOLEAN NOT NULL DEFAULT TRUE` | Same |
| `system_notifications` | `BOOLEAN NOT NULL DEFAULT TRUE` | Same |
| `updated_at` | `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP` | MySQL-managed update timestamp |

Expected keys: primary key on `user_id`; FK
`fk_user_notification_settings_user` with `ON UPDATE CASCADE ON DELETE
CASCADE`. There is no backfill: absent settings rows continue to use
application defaults; existing rows are not changed by table creation.

### `user_notifications`

| Column | Expected MySQL definition | Notes |
|---|---|---|
| `notification_id` | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT` | Primary key |
| `user_id` | `BIGINT UNSIGNED NOT NULL` | FK to `users.user_id` |
| `event_key` | `VARCHAR(191) NOT NULL` | Unique per user |
| `title` | `VARCHAR(160) NOT NULL` | |
| `description` | `VARCHAR(500) NOT NULL` | |
| `category` | `VARCHAR(32) NOT NULL` | |
| `priority` | `VARCHAR(16) NOT NULL` | |
| `occurred_at` | `DATETIME NOT NULL` | Application stores naive UTC |
| `read_at` | `DATETIME NULL` | Per-recipient read state; naive UTC |
| `created_at` | `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP` | Verify MySQL session timezone convention |

Expected keys:

- Primary key on `notification_id`.
- Unique key `uq_user_notifications_user_event` on
  `(user_id, event_key)`.
- Index `ix_user_notifications_user_read` on `(user_id, read_at)`.
- Index `ix_user_notifications_user_created` on `(user_id, created_at)`.
- FK `fk_user_notifications_user_id` to `users.user_id`, with
  `ON DELETE CASCADE ON UPDATE CASCADE`.

The unique key permits the same event key for different users but prevents
duplicates for the same user/event. Read/unread state is stored in each user’s
own row. `DATETIME` does not carry a timezone; ensure the MySQL session uses
the application’s UTC convention for `CURRENT_TIMESTAMP`. The application
normalizes event/read timestamps as naive UTC and formats them for the user.

## Read-only post-migration verification

Run the same metadata queries from preflight. Confirm both tables exist as
InnoDB with the expected columns, defaults, indexes, key order, and foreign
key actions. Then run:

```sql
SELECT COUNT(*) AS settings_rows FROM user_notification_settings;
SELECT COUNT(*) AS notification_rows FROM user_notifications;

SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('user_notification_settings', 'user_notifications')
ORDER BY TABLE_NAME;

SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('user_notification_settings', 'user_notifications')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME,
       k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
       r.UPDATE_RULE, r.DELETE_RULE
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS k
LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS r
  ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
 AND r.TABLE_NAME = k.TABLE_NAME
 AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
WHERE k.CONSTRAINT_SCHEMA = DATABASE()
  AND k.TABLE_NAME IN (
    'user_notification_settings',
    'user_notifications'
  )
  AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME;

SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'inventory_batches', COUNT(*) FROM inventory_batches
UNION ALL SELECT 'sales_records', COUNT(*) FROM sales_records
UNION ALL SELECT 'waste_records', COUNT(*) FROM waste_records
UNION ALL SELECT 'user_activity', COUNT(*) FROM user_activity;
```

For a newly created migration set with no application writes yet, both
notification row counts should be zero. Compare operational counts with the
captured preflight results; they should be unchanged by these DDL statements.
Counts alone cannot prove row-for-row equality if other application activity
was concurrent. If counts differ unexpectedly, stop and investigate before
enabling notification writes.

## Rollback boundaries and data-loss warnings

MySQL DDL auto-commits. There is no transaction rollback for these migrations.
Prefer forward correction after migration. If rollback is explicitly approved:

1. Stop notification writes and preserve the pre-migration backup.
2. Identify exactly which tables were absent before, and created by this
   migration run. Do not infer ownership from table names alone.
3. Only if the table was newly created in this run and contains no data that
   must be retained, a DBA may drop it in reverse migration order:

   ```sql
   DROP TABLE `user_notifications`;
   DROP TABLE `user_notification_settings`;
   ```

4. Omit any `DROP` statement for a table that predated this migration. Never
   drop/replace a mismatched preexisting table as an ad hoc rollback.

Dropping `user_notifications` deletes notification history and all read state.
Dropping `user_notification_settings` deletes saved user preferences. After
the application has written rows, dropping either table is destructive even
though the original migration only created the schema. Do not roll back by
deleting users or changing products, inventory, sales, waste, or audit history.

## Scope and sign-off

These are schema-only additions, with no data backfill. This package does not
verify application behavior against MySQL; after schema verification, test
notification endpoints and role/preference behavior through the normal
application test and deployment process. Record the MySQL version, schema,
operator, execution time, migration outcomes, and post-check results in the
organization’s approved DBA change record, not in application logs containing
credentials.
