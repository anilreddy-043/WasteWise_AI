# WasteWise AI Settings Database Readiness

This runbook is for the single-store WasteWise AI application using MySQL
8.0.46 and schema `wastewise_ai`. It records read-only
`INFORMATION_SCHEMA` inspections and the expected SQLAlchemy model/API
contracts. No DDL or data was changed for these inspections.

## Live audit summary

| Settings schema object | Live status | Action |
|---|---|---|
| `user_general_settings` | Missing | Apply existing `20261106_add_user_general_settings.sql` after preflight |
| `store_information` | Missing on 2026-11-07 read-only check | Apply the revised existing `20261106_add_store_information.sql` after preflight |
| `category_shelf_life_settings` | Missing | Apply existing `20261105_add_expiry_provenance_and_shelf_life_settings.sql` after checking its two DDL preconditions |
| `inventory_batches.expiry_date_source` | Missing | Added by the existing shelf-life/provenance migration |
| `user_notification_settings` | Present, InnoDB | Verified; do not reapply |
| `user_notifications` | Present, InnoDB | Verified; do not reapply |
| `inventory_batches.location`, `inventory_batches.supplier` | Present and match current model types/nullability | No action |

`users` exists as InnoDB with `user_id BIGINT UNSIGNED` primary key. The two
notification tables have the expected columns/defaults, primary keys,
notification unique key `(user_id, event_key)`, read/created indexes, and
cascading user foreign keys. No missing indexes or foreign keys were observed
on the existing notification tables.

General Settings currently fails at its database lookup because its model
table is absent. Store Information lookups likewise fail because its table is
absent. The application must continue surfacing those errors; this runbook
does not propose application fallbacks or weaker validation.

The 2026-11-07 read-only status check confirmed MySQL 8.0.46,
`wastewise_ai`, and that `store_information` is absent. Its migration has
therefore been revised before application to create one fixed singleton row
key, shared by Admin and Store Manager. No DDL was executed.

## Existing migration files and order

No new schema migration is required for the inspected gaps. Existing migration
files already contain the necessary additive DDL. Do not copy their DDL into
a second migration or run the notification migrations again.

After preflight confirms each object is absent and the application version
expects the singleton store schema, apply only the missing files in this order:

1. `20261105_add_expiry_provenance_and_shelf_life_settings.sql`
2. `20261106_add_user_general_settings.sql`
3. `20261106_add_store_information.sql`

Notification migrations are intentionally excluded: both notification tables
are already present and were verified. If preflight results change before the
maintenance window, stop and re-evaluate rather than blindly executing this
list.

The first migration both adds `inventory_batches.expiry_date_source` and
creates/seeds `category_shelf_life_settings`. It is applicable to the current
observed schema because both targets were absent. Its seed values are
configuration defaults for ten product categories; they are not historical
or operational inventory records.

## DBA checklist

- [ ] Schedule the change and take/verify a recoverable backup using the
  approved DBA process.
- [ ] Connect to MySQL 8.0.46 as a DBA/schema-migration account and verify
  `SELECT VERSION()` and `SELECT DATABASE()` identify the expected server and
  `wastewise_ai`.
- [ ] Run and save all read-only preflight results below.
- [ ] Confirm `users` and `inventory_batches` are InnoDB and their referenced
  key types match: `users.user_id` is `BIGINT UNSIGNED`; the inventory table
  exists and has no `expiry_date_source` column.
- [ ] Confirm `category_shelf_life_settings`, `user_general_settings`, and
  `store_information` are absent. If any target exists, inspect its complete
  definition and data; stop rather than applying or skipping a migration
  until the schema and data are reconciled. The Store Information migration
  intentionally uses plain `CREATE TABLE` so an unexpected existing table
  causes a visible failure instead of being silently accepted.
- [ ] Execute each required migration separately, in order, and stop on the
  first SQL error.
- [ ] Run the post-migration metadata checks and compare operational table
  counts with the preflight snapshot.
- [ ] Keep application verification separate from the DDL result. Run
  authenticated Settings endpoint checks only after schema verification.

MySQL DDL implicitly commits; the three migration files do not form one
transaction. Do not use a client mode that continues after SQL errors.

## Read-only preflight queries

Run while connected to the intended `wastewise_ai` schema:

```sql
SELECT VERSION() AS mysql_version, DATABASE() AS selected_schema;

SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'users',
    'inventory_batches',
    'user_general_settings',
    'store_information',
    'category_shelf_life_settings',
    'user_notification_settings',
    'user_notifications'
  )
ORDER BY TABLE_NAME;

SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE,
       IS_NULLABLE, COLUMN_DEFAULT, EXTRA
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    TABLE_NAME IN (
      'users',
      'user_general_settings',
      'store_information',
      'category_shelf_life_settings',
      'user_notification_settings',
      'user_notifications'
    )
    OR (TABLE_NAME = 'inventory_batches'
        AND COLUMN_NAME IN ('expiry_date_source', 'location', 'supplier'))
  )
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
       SUB_PART, INDEX_TYPE
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'user_general_settings',
    'store_information',
    'category_shelf_life_settings',
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
    'user_general_settings',
    'store_information',
    'category_shelf_life_settings',
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

The application account has only `SELECT`, `INSERT`, `UPDATE`, and `DELETE`
grants on `wastewise_ai`; it cannot apply these migrations. Use a separate,
authorized DBA/schema-migration principal with `CREATE` on the schema and
`ALTER` on `inventory_batches`. Foreign-key creation may also require
`REFERENCES` on `users`; follow the server's DBA privilege policy. Do not
grant DDL privileges to the application account.

## Migration contents and expected objects

### 1. `20261105_add_expiry_provenance_and_shelf_life_settings.sql`

- Adds nullable `inventory_batches.expiry_date_source VARCHAR(32)`.
  Existing rows receive SQL `NULL`; no current expiry dates or inventory
  quantities are rewritten.
- Creates `category_shelf_life_settings` with `category VARCHAR(80)` primary
  key, `days INT NOT NULL`, nullable `updated_by BIGINT UNSIGNED`, and
  `updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE
  CURRENT_TIMESTAMP`.
- Adds `fk_shelf_life_updated_by`: `updated_by` references `users.user_id`,
  `ON UPDATE CASCADE ON DELETE SET NULL`.
- Adds `ck_shelf_life_days_positive`, requiring `days BETWEEN 1 AND 3650`.
- Inserts ten named default shelf-life configuration rows. These inserts are
  not `IF NOT EXISTS`/upserts; do not rerun this migration after partial or
  successful execution.

### 2. `20261106_add_user_general_settings.sql`

- Creates one `user_general_settings` row per user, keyed by
  `user_id BIGINT UNSIGNED`.
- Defaults: application name `WasteWise AI`, timezone `Asia/Kolkata`, date
  format `DD MMM YYYY`, language `en`, and `items_per_page` 10.
- `updated_at` is maintained with `CURRENT_TIMESTAMP ON UPDATE
  CURRENT_TIMESTAMP`.
- Adds a cascading user FK and `ck_user_general_settings_items_per_page`
  limiting values to 10, 20, 50, or 100.
- Uses plain `CREATE TABLE`; it is not rerunnable.

### 3. `20261106_add_store_information.sql`

- Creates one `store_information` row with fixed `store_id = 1`; the primary
  key plus `ck_store_information_singleton` check constraint prevent any
  second store ID from being stored.
- Uses the existing store fields and limits: `store_name VARCHAR(160)`,
  `store_address VARCHAR(255)`, `contact_number VARCHAR(32)`,
  `email VARCHAR(254)`, nullable `logo_path VARCHAR(512)`, and created/
  updated timestamps.
- Retains empty-string defaults for text fields and MySQL's automatic
  `updated_at` behavior. It has no `user_id` owner or user foreign key because
  this is the one shared physical store; the acting user remains recorded in
  `user_activity`.
- Uses plain `CREATE TABLE`, not `IF NOT EXISTS`. If a table unexpectedly
  exists, the migration stops and requires DBA inspection rather than
  silently accepting a mismatched schema.
- Inserts the one initial row with `store_id = 1` and empty-string text
  defaults. This is an empty settings record, not fabricated store data; the
  user-entered store details are saved through the Settings API.

Admin and Store Manager use the same singleton row and logo through
authenticated endpoints. Both roles retain read/write permission under the
existing RBAC policy. The API uses an atomic MySQL `ON DUPLICATE KEY UPDATE`
write for concurrent first-time updates, and SQLite's equivalent in tests.
General Settings and Notification Preferences remain per-user.

Notification tables are already installed. Their existing structures should
continue to match the notification migration/model definitions, including
the unique `(user_id, event_key)` key and per-user read state. Do not reapply
those migrations during this change.

## Execution commands

From the repository root, run each required command separately, using a DBA
account and password prompt. Execute only after the preflight verifies its
targets are absent and compatible:

```powershell
mysql -h 127.0.0.1 -P 3306 -u <DBA_USER> -p wastewise_ai < backend\migrations\20261105_add_expiry_provenance_and_shelf_life_settings.sql
mysql -h 127.0.0.1 -P 3306 -u <DBA_USER> -p wastewise_ai < backend\migrations\20261106_add_user_general_settings.sql
mysql -h 127.0.0.1 -P 3306 -u <DBA_USER> -p wastewise_ai < backend\migrations\20261106_add_store_information.sql
```

Never put a password on the command line or in the repository. If a command
fails or its outcome is uncertain, stop, rerun read-only preflight, and
inspect partial state. Do not blindly retry a file that has plain `ALTER`,
`CREATE`, or `INSERT` statements.

## Read-only post-migration checks

Repeat the preflight metadata queries. Confirm the new table definitions,
columns, defaults, primary key, and singleton check match this section. The
Store Information table intentionally has no user foreign key or user index.
Confirm `inventory_batches.expiry_date_source` is nullable `VARCHAR(32)`.
Confirm the shelf-life table has the ten expected category rows:

```sql
SELECT category, days, updated_by, updated_at
FROM category_shelf_life_settings
ORDER BY category;

SELECT COUNT(*) AS general_settings_rows FROM user_general_settings;
SELECT store_id, store_name, store_address, contact_number, email, logo_path
FROM store_information;
SELECT COUNT(*) AS store_information_rows FROM store_information;

SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'inventory_batches', COUNT(*) FROM inventory_batches
UNION ALL SELECT 'sales_records', COUNT(*) FROM sales_records
UNION ALL SELECT 'waste_records', COUNT(*) FROM waste_records
UNION ALL SELECT 'user_activity', COUNT(*) FROM user_activity;
```

No backfill is performed for per-user General Settings. The Store Information
migration creates its one empty singleton row; details remain empty until
saved through the authenticated Settings API. Before the migration, the
endpoint returns blank defaults without writing a row.
Compare operational counts to the preflight snapshot. Counts should be
unchanged by these migrations, except that `category_shelf_life_settings`
receives its documented configuration rows. Counts alone do not prove
row-for-row equality if application writes occur concurrently; coordinate a
quiet window or use the DBA's approved consistency method.

## Rollback and data-preservation boundaries

MySQL DDL implicitly commits. Prefer forward fixes; do not attempt transaction
rollback. Never drop a preexisting table, delete user settings, or change
products, inventory quantities, sales, waste, or audit history.

If rollback is approved by the DBA, identify exactly which objects were
created by this run and whether they now contain application data. Dropping
`user_general_settings` or `store_information` loses persisted preferences or
shared store details. Dropping `category_shelf_life_settings` loses both seeded
defaults and subsequent operator-edited values. Dropping
`inventory_batches.expiry_date_source` permanently loses provenance values
recorded after migration. Do not execute rollback DDL until those risks are
accepted and affected values have been preserved.

## Audit limits and blockers

- This is a schema-readiness result, not evidence that migrations have run.
- Live schema reads observed MySQL 8.0.46 and the missing/present objects
  summarized above. No migration was executed.
- The restricted application account lacks `CREATE` and `ALTER`; a DBA must
  run the required files.
- The live Store Information table was absent at the 2026-11-07 read-only
  check. Apply the revised pending migration before deploying code that
  expects the singleton schema.
- The existing store schema is user-scoped rather than a single shared
  singleton record. Confirm whether that behavior is acceptable for the
  physical store before relying on identical store details for all users.
- Model Settings and some System Preferences controls in the current UI use
  frontend-only placeholder state and have no corresponding persistence
  endpoint/model. No missing database objects can make those controls persist;
  that is outside this schema-only migration set.
