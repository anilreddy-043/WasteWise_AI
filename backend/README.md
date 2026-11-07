# WasteWise AI backend

## Local MySQL configuration

Install the backend dependencies, then create `backend/.env` from `.env.example`.
Set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` for a dedicated
non-root MySQL application account. Keep `.env` local and generate a unique
`AUTH_SECRET_KEY` with at least 32 characters. Do not use a MySQL root account
for application runtime access.

The local development configuration uses the `wastewise_ai` schema and a
dedicated `wastewise_app` account. The database and account were provisioned
after a read-only schema check confirmed the target schema did not exist. The
application account has only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` grants
on that schema.

## Safe schema initialization

`init.sql` contains only `CREATE TABLE IF NOT EXISTS` statements and creates
the initial application tables without dropping tables or deleting/resetting
records. Before reusing it on an existing database, inspect
`INFORMATION_SCHEMA.TABLES`, `COLUMNS`, `KEY_COLUMN_USAGE`, and `STATISTICS`,
then compare the existing schema with the script. `IF NOT EXISTS` does not
migrate or repair a table that already exists.

From the repository root, apply the reviewed script to a new database using a
DBA or schema-migration account (not the application account):

```powershell
mysql -h 127.0.0.1 -P 3306 -u <DBA_USER> -p wastewise_ai < backend\init.sql
```

The `-p` option prompts for the DBA password. Do not put that password on the
command line or in `backend/.env`. The current local schema has been initialized
and verified; do not rerun table changes against another database without
inspecting it first.

## Settings database readiness

The live Settings schema audit and migration readiness checklist for
General Settings, Store Information, and category shelf-life settings is
documented in
[`migrations/SETTINGS_DATABASE_READINESS.md`](migrations/SETTINGS_DATABASE_READINESS.md).
That audit found the notification tables present, but identified other
Settings tables and inventory expiry provenance still pending DBA migration.
Store Information uses one shared singleton record for Admin and Store
Manager; its migration must be applied before this behavior is available on
the live database. General Settings and notification preferences remain
per-user.

## Notification schema migrations

For the complete DBA checklist, exact preflight/post-migration SQL, expected
schema, least-privilege requirements, and rollback boundaries, see
[`migrations/NOTIFICATION_MIGRATION_RUNBOOK.md`](migrations/NOTIFICATION_MIGRATION_RUNBOOK.md).

Notification preferences are stored per user in `user_notification_settings`.
The Notification Center stores deduplicated events and per-user read state in
`user_notifications`; the existing preferences and audit tables do not provide
an event uniqueness key or recipient-specific read state. These migrations
create only those two tables. They do not update or delete existing users,
products, inventory, sales, waste, or audit rows, and they do not grant
privileges to the application account.

The migration files are:

1. `migrations/20261106_add_user_notification_settings.sql`
2. `migrations/20261106_create_user_notifications.sql`

Before applying anything, take/verify a database backup and connect to the
intended schema with an authorized DBA/schema-migration account. Do not run
these commands with the restricted application account. Confirm the schema
name and inspect table definitions, indexes, and foreign keys:

```sql
SELECT DATABASE();

SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('users', 'user_notification_settings', 'user_notifications')
ORDER BY TABLE_NAME;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('users', 'user_notification_settings', 'user_notifications')
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('users', 'user_notification_settings', 'user_notifications')
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
  AND k.TABLE_NAME IN ('user_notification_settings', 'user_notifications')
  AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME;
```

Verify that `users` exists as InnoDB and `users.user_id` is `BIGINT UNSIGNED`
with a primary or unique key. For either notification table that already
exists, compare every column, default, nullability, primary/unique/index key,
foreign key, and table engine with its migration and the corresponding
SQLAlchemy model before proceeding. **Do not treat `CREATE TABLE IF NOT EXISTS`
as schema validation:** it skips creation even if an existing table has an
incompatible definition.

Apply in order, and only when preflight confirms each table is absent:

```powershell
mysql -h 127.0.0.1 -P 3306 -u <DBA_USER> -p wastewise_ai < backend\migrations\20261106_add_user_notification_settings.sql
mysql -h 127.0.0.1 -P 3306 -u <DBA_USER> -p wastewise_ai < backend\migrations\20261106_create_user_notifications.sql
```

The preferences migration uses plain `CREATE TABLE`, so it is **not
rerunnable**: if `user_notification_settings` already exists, verify it and
skip that file. The history migration uses `CREATE TABLE IF NOT EXISTS`, so
re-running it will not duplicate a correctly created table, but it will also
not repair or reject an incompatible preexisting table. Preflight both tables
on every run; stop and resolve any mismatch instead of editing existing user
preferences or notification history implicitly. Once applied, verify the
expected constraints/indexes above and confirm the tables use InnoDB.

Both tables use `BIGINT UNSIGNED` user IDs with cascading foreign keys to
`users.user_id`, matching `backend/init.sql`. Preferences have one row per user
and preserve their values when later changed through the API. Notification
events have a unique `(user_id, event_key)` key, so retries cannot create a
second copy for the same recipient and event; separate users can independently
receive the same event. `read_at` belongs to that recipient’s row, isolating
read/unread state by user. The `DATETIME` event/read fields follow the
application’s naive-UTC storage convention; the API formats event timestamps
using each user’s configured timezone. `created_at` uses MySQL
`CURRENT_TIMESTAMP`, so ensure the DBA/application MySQL session timezone
policy is consistent with the system’s UTC convention.

DDL in MySQL implicitly commits. To roll back, first stop notification writes
and verify which tables were created by this migration run. If rollback is
necessary, a DBA may drop only a table newly created by this run, in reverse
order (`user_notifications`, then `user_notification_settings`). Never drop a
preexisting table: dropping `user_notifications` deletes notification history
and read state; dropping `user_notification_settings` deletes saved
preferences. Do not roll back by deleting users or changing any operational or
audit tables.

The application account has no `CREATE` privilege, and the application does
not run these migrations automatically. If either required table is missing,
the affected notification endpoints will return a service error until the DBA
applies and verifies the migration. Schema inspection and migration execution
must be reported separately; a static review or SQLite test is not evidence
that these files have been executed successfully on MySQL 8.0.

## Data CSV import and exports

The authenticated data transfer routes are:

- `POST /api/v1/data/imports/products` (`multipart/form-data`, file field `file`)
- `POST /api/v1/data/imports/inventory` (`multipart/form-data`, file field `file`)
- `POST /api/v1/data/imports/sales` (`multipart/form-data`, file field `file`)
- `GET /api/v1/data/exports/{products|inventory|sales|waste|reports}?format=csv|xlsx`

Imports and exports require an administrator role. Files must be UTF-8 CSV,
at most 5 MB and 5,000 data rows. Invalid rows reject the transaction as a
whole; matching product SKUs, repeated sales, and exact file replays are
skipped without overwriting existing records. Existing batch-code conflicts
reject an inventory file without committing any batch. Inventory imports reuse the
existing batch importer, match products by name/SKU (or resolve a supplied
product ID), and never create products implicitly. Sales imports validate
product/batch relationships, add `source=csv_import`, and do not decrement
inventory; import metadata and source hashes are recorded in the existing
`user_activity` table in the same transaction. No new database table or
migration is needed.

The UI can download header-only templates. Product columns are
`product_name,category,sku,unit,price,supplier`; inventory uses the established
batch-import columns; sales columns are
`product_id,batch_id,sold_at,quantity,unit_price` (`batch_id` may be blank).
The existing files in `ml/data/raw/` are historical/training datasets, not
operational import templates. Continue using the existing dashboard dataset
importer for historical data; operational CSV imports do not silently treat
simulated rows as sales, stock, or waste.

Exports use the live MySQL operational tables, include IDs and relevant
created/sold/recorded timestamps, and return a header row for empty CSV
datasets. `reports` exports an actual-data KPI summary. CSV and XLSX values are
escaped against spreadsheet formula injection.

## Database Backup and Restore

The admin-only database backup routes are:

- `POST /api/v1/backups` creates a private backup.
- `GET /api/v1/backups` lists verified backup files and failed attempts.
- `GET /api/v1/backups/{backup_id}/download` downloads a verified backup.
- `POST /api/v1/backups/upload` imports a previously downloaded `.wwbackup`
  file for restore.
- `POST /api/v1/backups/{backup_id}/restore` restores after an explicit
  confirmation body: `{"confirm_restore": true, "confirmation_text": "RESTORE DATABASE"}`.

Backups are signed, compressed, AES-GCM-encrypted data snapshots of the current
database tables. Encryption and integrity keys are derived from
`AUTH_SECRET_KEY`; retain that secret securely and keep it stable to restore
existing backups. The key itself is never written to the backup or returned by
the API. Database passwords and application configuration are not serialized.
They are stored outside the frontend/static directories, are never served as
static files, and can only be listed/downloaded/restored through authenticated
administrator endpoints. Restore can select only a backup created by or
imported into this application. Uploads accept only
signature-verified, encrypted WasteWise `.wwbackup` archives (256 MB max); the
original client filename is never used for storage. SQL files and arbitrary ZIP
archives are rejected. Before replacing records, restore verifies the file
signature, database identity, and exact table/column schema, then creates a
pre-restore safety backup. A mismatch or invalid confirmation leaves live data
unchanged. Backup and restore attempts use the existing `user_activity` table,
and restore preserves recorded session revocations. No table or migration is
added.

This is a data restore for the existing schema, not a schema migration; it does
not recreate database DDL, views, triggers, or stored routines. Keep the
application schema unchanged between backup and restore. The backup archive
limit is 256 MB compressed and 512 MB uncompressed. The default private
directory is `%LOCALAPPDATA%\WasteWiseAI\backups` on Windows and
`backend/var/backups` on other platforms. Operators who override
`WASTEWISE_BACKUP_DIR` must ensure that the directory is private to the API
service account and outside every static/web-served directory.

Before implementation, the configured MySQL account was checked read-only:
it has `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on `wastewise_ai`; all 12
current tables use InnoDB. No MySQL command-line dump utility is installed.
The implemented data-only snapshot and same-schema restore use those existing
table privileges and do not require DDL grants or `FILE`. In particular, the
application does not run uploaded SQL or invoke a shell restore command.

## Run and verify

From the `backend` directory:

```powershell
python -m pip install -r requirements.txt
python -m app.db.init_db
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

The connection check executes `SELECT 1`; failures identify the configured
host, port, and database and never log the password or connection URL. The
FastAPI startup check also verifies MySQL before serving requests. The
`/health/database` endpoint performs a fresh connection check.

If no approved administrator exists, create the first one from the backend
directory using the configured non-root application account. The command checks
that an administrator does not already exist, asks for the name and email, and
reads the password and confirmation without echoing them. Never pass the
password as a command-line argument or put it in `.env`:

```powershell
python -m app.core.bootstrap_admin
```

## Authentication and access control

The sign-up form creates an account in the existing `users` table with a
one-way scrypt password hash and an allowed non-admin role. New accounts can
sign in immediately. Public registration cannot assign the `admin` role. Once
signed in as an administrator, open **Users & Roles** in the dashboard to
activate/deactivate accounts or change roles. Account access and role changes
are enforced by administrator-only API routes; inactive accounts cannot sign in.
The last active administrator cannot be demoted or deactivated. The legacy
`approval_status` column is retained for database compatibility but is not
used to control access.

Sign-in issues a 60-minute signed bearer token only for active accounts. The
client keeps the token in memory and verifies the user through
`GET /api/v1/auth/me`; browser refresh clears the client session. Sign-out calls
`POST /api/v1/auth/logout`, which revokes that token by recording its unique ID
in the existing `user_activity` table. `POST /api/v1/auth/change-password`
verifies the current password, applies the existing password-strength rules,
and revokes all active sessions. Failed logins are recorded with HMAC-derived
account and IP identifiers (not plaintext credentials, email, or IP); after
10 failures per account or 30 per IP in 15 minutes, sign-in requests are
temporarily throttled. No authentication table migration is required.
Protected endpoints re-check account status, current role, and token revocation.

## User profile

The authenticated **My Profile** account-menu page reads the current user's
identity and status from the existing `users` row. Users may update their own
full name; email and role remain read-only (email changes have no verification
workflow, and role changes stay in **Users & Roles**). The page reuses
`POST /api/v1/auth/change-password`, which verifies the current password and
revokes active sessions.

Profile images are optional PNG, JPEG, or WebP files up to 5 MB. They are stored
under the backend's private `uploads/profiles` directory, keyed by the
authenticated user ID, and served only through an authenticated endpoint.
Profile changes and image additions/removals are recorded in the existing
`user_activity` table without passwords or other sensitive values. No schema
migration or new database table is required.

All data APIs require an active account. Administrators can manage users and
roles, settings, imports/exports, and database backups. Administrators and
Store Managers can perform daily product, inventory, batch, sales, waste,
expiry-rule, and recommendation operations. Store Managers, Staff, and Viewers
have read-only access to the APIs outside their permitted preferences; Staff
and Viewers cannot perform operational writes. The backend enforces every
permission independently of frontend navigation.

## Database-backed API routes

- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`,
  `POST /api/v1/auth/change-password`, `GET /api/v1/auth/me`
- `GET/PATCH /api/v1/profile`, `POST/DELETE /api/v1/profile/image`
- Authenticated `GET /api/v1/profile/image` (private profile image retrieval)
- `GET /api/v1/notifications`, `PATCH /api/v1/notifications/{id}/read`,
  `POST /api/v1/notifications/read-all` (Admin and Store Manager)
- Admin-only `GET /api/v1/users`, `PATCH /api/v1/users/{id}/active`, and
  `PATCH /api/v1/users/{id}/role`
- `GET/POST/PUT/DELETE /api/v1/products`
- `GET/POST/PATCH/DELETE /api/v1/inventory/batches`
- `GET/POST /api/v1/sales`, `GET/POST /api/v1/waste`
- `GET /api/v1/inventory/summary`
- `GET /api/v1/risk/expiry`
- `GET /api/v1/dashboard/summary`, `/sales-demand`, `/category-distribution`, `/waste-trend`
- `GET /api/v1/dashboard/expiry-alerts`, `/recommendations`, `/top-products`, `/low-stock`, `/recent-activities`
- `GET /api/v1/expiry-alerts` (search, filters, pagination and risk counts)
- `GET /api/v1/expiry-alerts/summary`, `/charts`, `/filters`, `/batches/{batch_id}`
- `GET /api/v1/expiry-alerts/export?format=csv|xlsx`
- `GET/POST /api/v1/expiry-alerts/rules`, `PATCH/DELETE /api/v1/expiry-alerts/rules/{rule_id}`
- `GET /api/v1/forecasts`, `GET/PATCH /api/v1/recommendations`
- `GET /api/v1/model-metrics`, `/overview`, `/models`, `/performance`, `/performance-trend`
- `GET /api/v1/model-metrics/prediction-distribution`
- `GET /api/v1/model-metrics/feature-importance/{model_name}`
- `GET /api/v1/model-metrics/recent-predictions`
- `GET /api/v1/model-metrics/demand/actual-vs-predicted`
- `GET /api/v1/model-metrics/models/{model_name}/details`
- `POST /api/v1/model-metrics/models/{model_name}/evaluate` (admin only)
- `POST /api/v1/model-metrics/retrain-all` and `GET /api/v1/model-metrics/retrain-all/{job_id}` (admin only)
- `GET /api/v1/users` (admin only)
- `PATCH /api/v1/users/{user_id}/active` (admin only)

API data routes require an active user's bearer token. Registration creates
accounts that can sign in immediately. The dashboard client uses the Vite
`/api` proxy to the configured FastAPI origin.

Model Metrics reads the demand-forecast, expiry-risk, and discount-recommendation
Random Forest artifacts and their held-out evaluation sidecars from
`ml/artifacts`. Evaluation reruns the existing fitted pipelines on the existing
chronological/grouped holdout data and persists the resulting metrics in the
existing `model_metrics.metrics_json` field; it does not fit a model. Training
timestamps are reported as unavailable when the artifact metadata does not
contain one. The discount model's evaluation data is simulated and is not
evidence of real customer price response.
Dataset import no longer schedules model training; training requires a separate
admin retraining request with explicit confirmation.

Prediction analytics use persisted `demand_forecasts`, `expiry_risk_predictions`,
and `recommendations` rows. The live database was inspected read-only and does
not currently have `expiry_risk_predictions`; expiry prediction history and its
distribution therefore report unavailable until the additive
`migrations/20261105_add_expiry_risk_prediction_history.sql` is reviewed and
applied by an authorized database operator. No migration runs automatically.
Demand actual-versus-predicted comparisons join stored forecasts to
`sales_records` on product and forecast date; unmatched actuals remain null.
Retraining requires an explicit admin request (`{"confirm": true}`), runs in a
background process, and uses the existing versioned candidate-promotion and
rollback registry. Job status is held in API-process memory and is lost if that
process restarts.

Expiry alert reads use positive-stock rows from the existing `inventory_batches`
and `products` tables. Risk is computed from stored batch expiry dates at
request time (expired <0 days, high 0–3, medium 4–7, low 8–14, safe >14).
Alert rules are retained as audit events in the existing `user_activity` table;
only administrators and store managers may create, update, or archive them.
Suggested actions are informational and do not alter inventory.

Batch location and supplier values are stored on operational inventory batches.
For an existing database, inspect `INFORMATION_SCHEMA.COLUMNS` first and
manually apply the additive migration once with a DBA/schema-migration account:

```powershell
mysql -h 127.0.0.1 -P 3306 -u <DBA_USER> -p wastewise_ai < database\migrations\20261029_add_batch_location_supplier.sql
```

This migration only adds nullable supplier and defaulted location columns; it
does not recreate tables, overwrite batch data, or run automatically. The
application role must already have its normal `SELECT`, `INSERT`, `UPDATE`,
and `DELETE` privileges for the table.

## Batch expiry dates

The additive SQL in `migrations/20261105_add_expiry_provenance_and_shelf_life_settings.sql`
adds nullable `inventory_batches.expiry_date_source` and seeds the editable
`category_shelf_life_settings` table. Apply it manually before deploying the new
API code to an existing database; it has not been run as part of this change.
Existing rows retain a `NULL` source and their stored expiry dates are not
recalculated.

The default suggestions are Seafood (2 days), Meat & Poultry (3), Dairy
Products (9), Bakery Products (5), Vegetables (9), Fruits (9), Ready-to-Eat
Foods (4), Fresh Juices (3), Frozen Foods (228), and Beverages (105). An admin
can read `/api/v1/inventory/shelf-life` and update a category with
`PUT /api/v1/inventory/shelf-life/{category}`. The authenticated
`GET /api/v1/products/{product_id}/expiry-suggestion?received_at=YYYY-MM-DD`
endpoint returns the suggestion for a product and receipt date.

When a new batch omits its expiry or marks it `estimated`, the API calculates
the date from the configured category days. Explicit manufacturer, manually
verified, and imported dates are retained. The source values are `estimated`,
`manufacturer_verified`, `manual_verified`, and `imported`; `NULL` indicates an
unverified legacy value. Editing a received date recalculates only an estimated
batch. Verified dates remain unchanged, and expiry earlier than receipt is
rejected.

Batch Management's CSV import is a two-phase operation. Administrators can
preview and validate CSV text with
`POST /api/v1/inventory/batches/import/preview`, then commit the unchanged or
corrected CSV with `POST /api/v1/inventory/batches/import/confirm`. The required
columns are `product_name`, `batch_code`, `quantity_received`, `received_at`,
`expiry_date`, and `location`; matching uses `sku` first, then product name.
Creating a missing product additionally requires `sku`, `category`, `unit`,
`price`, and `supplier`, and the confirmation request must explicitly set
`create_missing_products` to `true`. Dates use ISO `YYYY-MM-DD`.

The preview reports every invalid row and the confirmation revalidates the
whole file before writing. Duplicate product/batch pairs reject the import;
no rows are silently skipped or overwritten. Batch creation, optional product
creation, and audit history are committed in one database transaction.
`GET /api/v1/inventory/batches/imports` returns recent successful imports.
The existing `user_activity` table stores import history; this feature does
not require a schema migration.

Each batch's stored `expiry_date` drives inventory status, dashboard and expiry
alerts, and ML/recommendation calculations. Frontend views display whether its
source is estimated, verified, imported, or unknown. Dashboard CSV inventory
inputs remain dated snapshots and are not written over MySQL batch dates.

Dashboard CSV inventory inputs are dated snapshots, not operational batch
imports. Their provided expiry dates remain intact and are not written over
MySQL batch expiry dates.

## Authentication verification

From the `backend` directory, run the integration checks with:

```powershell
python -m unittest discover -s tests -p "test_auth_integration.py" -v
```

The auth integration test exercises registration, password hashing, immediate
login, protected access, role restrictions, logout, and token
revocation in a transaction that is rolled back when the test ends.

Run all backend unit and integration tests from this directory with:

```powershell
python -m unittest discover -s tests -v
```

## Dashboard Data and CSV Import

The dashboard combines application products and operational records from
MySQL with a read-only catalog/history view from `ml/data/raw/products.csv` and
`perishable_inventory.csv`. The CSV view requires no schema migration. CSV
catalog IDs are deduplicated against `MLDATA-<source ID>` SKUs and recorded
import provenance. CSV sales and waste remain labeled training history; they
never contribute to operational revenue, stock, expiry, sales, or waste KPIs.
The current product schema has no active/archive column, so active product
count equals catalog product count. Category shares are calculated from
distinct catalog products, while stock quantities use only active MySQL batches
and remain grouped by unit. Low stock uses a default threshold of 10 in each
product's unit, configurable with `reorder_level`. There is no store/tenant
ownership field in the verified schema, so dashboard access uses the existing
active-user authentication scope.

Apply the additive migration once with a DBA/schema-migration account after
inspecting the target database. It creates only import-run, import-provenance,
and historical-metric tables; it does not alter or delete existing records:

```powershell
mysql -h 127.0.0.1 -P 3306 -u <DBA_USER> -p wastewise_ai < database\migrations\20261028_add_dashboard_imports.sql
```

The migration and importer are optional for dashboard CSV display. Apply the
migration and then, from the `backend` directory, run the repeatable importer
with the configured application account only when the CSV history should also
be persisted in MySQL:

```powershell
python -m app.core.import_dashboard_data
```

The importer reads `ml/data/raw/products.csv` and
`ml/data/raw/perishable_inventory.csv`. Source product IDs and product/date
keys provide stable deduplication; each run records source hashes and row
counts. Re-imports skip previously imported rows and do not overwrite catalog
fields edited after import. The source catalog has no unit or supplier columns,
so imported products are marked with generic `unit` and `ML training dataset`
values for review before operational use. The perishable CSV is training
history and remains separate from application sales and waste records.

The `inventory_batches.csv` file contains dated snapshots, including future
snapshot dates, and is not imported as current stock. The two discount scenario
CSVs are identical and contain simulated outcomes; they are not treated as
real sales or generated recommendations. `calendar.csv` and `sell_prices.csv`
are not present in the workspace. Sales, waste KPIs, and expiry alerts only
use actual application records.

Sales-demand returns actual sales, imported training history, and persisted
versioned forecasts in separate series. Forecasts use a separate forward
window of 30 days by default (`prediction_days` supports 0 through 180) and
include the stored model versions. The shipped forecast artifact cannot
be called by the backend environment: ML dependencies are not installed there,
its prediction module is empty, and its training features include lagged sales
and inventory/discount inputs not persisted by the application schema. The API
reports no live inference when no saved forecasts exist. Discount outcomes are
simulated, and expiry alerts use stored expiry dates and remaining quantities.

## Operations Console APIs

The Operations Console reuses the existing audit, notification, and system
health APIs. All routes below are authenticated and require the listed roles;
no additional tables or migrations are used.

### Audit Logs

- `GET /api/v1/audit-logs/filters` — Admin and Store Manager. Returns allowed
  action/actor filter options and the requesting user's timezone.
- `GET /api/v1/audit-logs` — Admin and Store Manager. Supports `action`,
  `user_id`, `unknown_actor`, `start_date`, `end_date`, `search`, and `status`
  (`successful`, `failed`, or `unknown`). `search` matches action, affected
  record type/ID, actor name, and actor role. Pagination uses `page` (default
  1) and `page_size` (default 25, maximum 100). Sorting uses `sort_by`
  (`timestamp`, `action`, `actor`, `affected_record`, or `status`) and
  `sort_order` (`asc` or `desc`).

Example:

```http
GET /api/v1/audit-logs?status=successful&search=store&page=1&page_size=25&sort_by=timestamp&sort_order=desc
Authorization: Bearer <access-token>
```

```json
{
  "items": [{
    "activity_id": 42,
    "user_id": 7,
    "actor_name": "Store Manager",
    "actor_role": "store_manager",
    "action": "store_information_updated",
    "entity_type": "store_information",
    "entity_id": 1,
    "affected_record": "store_information (ID: 1)",
    "created_at": "2026-11-07T01:42:00Z",
    "status": "successful",
    "details": {"changed_fields": ["store_name"]}
  }],
  "total": 1,
  "page": 1,
  "page_size": 25,
  "total_pages": 1,
  "timezone": "Asia/Kolkata"
}
```

Managers see only operational activity allowed by the existing audit RBAC;
Admin can see all activity. Sensitive details are allow-listed and redacted.
Unclassified legacy actions have `status: "unknown"` rather than being
misreported as successful.

### Notification Center

- `GET /api/v1/notifications` — Admin and Store Manager. Supports `category`
  (`expiry`, `inventory`, `demand`, `import`, or `system`),
  `read_status` (`all`, `read`, or `unread`), `limit` (1–100), and `offset`.
  This GET synchronizes deduplicated notifications from current inventory,
  forecast, system checks, and committed import/inventory audit events before
  returning the page. Inventory batch change alerts are generated from
  committed audit events in the previous seven days; the unique
  `(user_id, event_key)` constraint prevents
  duplicate events. The response includes `total` matching the
  selected filters, and `unread_count`/`read_count` for the selected category
  (or all preference-enabled categories when no category is selected), before
  the read-status filter is applied.
- `PATCH /api/v1/notifications/{notification_id}/read` with
  `{"is_read": true|false}` — Admin and Store Manager; only the authenticated
  user's own notification can be changed.
- `POST /api/v1/notifications/read-all` — Admin and Store Manager; marks the
  authenticated user's visible, preference-enabled notifications as read.

Example response:

```json
{
  "items": [{
    "notification_id": 18,
    "title": "Product nearing expiry",
    "description": "Fresh Greens, batch EXP-1, expires in 2 day(s); 8 kg remain.",
    "category": "expiry",
    "priority": "high",
    "occurred_at": "2026-11-07T01:30:00Z",
    "is_read": false
  }],
  "total": 1,
  "unread_count": 1,
  "read_count": 0
}
```

Notification visibility follows each user's saved preferences and existing
role restrictions. Store Managers do not receive system/import categories;
read state remains per-user.

### System Health

- `GET /api/v1/system-health` — Admin and Store Manager. Performs a live
  `SELECT 1` database check and verifies that the configured model artifacts
  can be loaded; it does not run predictions. Admin receives application
  version, uptime, and component errors. Store Manager receives operational
  health only. `frontend_backend.status` is `connected` when this authenticated
  request reaches the API; the backend cannot independently probe whether a
  browser is rendering its frontend or bypass browser CORS enforcement.

Example:

```json
{
  "status": "healthy",
  "checked_at": "2026-11-07T01:53:00Z",
  "last_successful_check": "2026-11-07T01:53:00Z",
  "api": {"status": "available"},
  "frontend_backend": {
    "status": "connected",
    "message": "The authenticated health request reached the backend API."
  },
  "database": {"status": "available"},
  "ml_models": [
    {"name": "demand_forecast", "artifact": "demand_forecast.joblib", "status": "available"},
    {"name": "discount_recommendation", "artifact": "discount_recommendation.joblib", "status": "available"},
    {"name": "expiry_risk", "artifact": "expiry_risk.joblib", "status": "available"}
  ],
  "app_version": "1.0.0",
  "uptime_seconds": 3600,
  "errors": []
}
```

Unhealthy database or model checks return `status: "degraded"` and mark the
failed component `unavailable`; messages do not reveal credentials or
filesystem paths. The endpoint keeps its last successful check timestamp in
process memory, so it is empty until a healthy check succeeds after process
startup.
