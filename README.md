# WasteWise AI

## Launch on Windows

Open a PowerShell terminal at the project root. MySQL is a separate Windows
service; check it before starting the API:

```powershell
Get-Service MySQL80
Test-NetConnection 127.0.0.1 -Port 3306
```

If `MySQL80` is stopped, start it from an elevated PowerShell terminal with
`Start-Service MySQL80`. The configured database is selected by `DB_NAME` in
`backend\.env`; this workspace uses `wastewise_ai`. Do not recreate an existing
database or rerun `backend\init.sql` against it.

The backend `.env` must contain `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
`DB_PASSWORD`, and an `AUTH_SECRET_KEY` of at least 32 characters. Keep those
values private. Create an isolated backend environment with Python 3.14 (or use
the project's existing environment if its Python runtime works on your
machine):

```powershell
py -3.14 -m venv .venv314
.\.venv314\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
Set-Location backend
python -c "from app.core.config import get_database_settings, get_auth_secret; get_database_settings(); get_auth_secret(); print('Backend configuration is valid.')"
python -m app.db.init_db
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

`app.db.init_db` only verifies a database connection with `SELECT 1`; it does
not create, reset, or migrate tables. Inspect the live schema before applying
any migration. The local schema currently lacks
`inventory_batches.expiry_date_source` and `category_shelf_life_settings`.
Batch reads and edits remain compatible with this legacy schema, but expiry-date
provenance cannot be persisted until the documented additive migration is applied.
After reviewing and backing up the database, a DBA/schema-migration account
(not the restricted `DB_USER`) can apply the additive migration once:

```powershell
& $env:ComSpec /c '""C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -h 127.0.0.1 -P 3306 -u YOUR_DBA_USER -p wastewise_ai < "backend\migrations\20261105_add_expiry_provenance_and_shelf_life_settings.sql"'
```

The migration is not safe to rerun: its `ALTER TABLE` and `CREATE TABLE`
statements intentionally fail if their targets already exist. Recheck
`INFORMATION_SCHEMA.COLUMNS` and `INFORMATION_SCHEMA.TABLES` before applying it;
replace `YOUR_DBA_USER` with the authorized schema-migration account.

Notification choices are stored per authenticated user in
`user_notification_settings`. The live schema has no notification-preferences
table, so review and apply the additive migration once with the authorized
DBA/schema-migration account (the restricted application account cannot create
tables):

```powershell
& $env:ComSpec /c '""C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -h 127.0.0.1 -P 3306 -u YOUR_DBA_USER -p wastewise_ai < "backend\migrations\20261106_add_user_notification_settings.sql"'
```

Verify that `user_notification_settings` is absent before applying the
migration; it creates one row per user and does not modify existing records.

In a second PowerShell terminal at the project root, install and start the
frontend:

```powershell
Set-Location frontend
npm ci
npm.cmd run dev -- --host 127.0.0.1
```

Open [http://localhost:5173](http://localhost:5173); the Vite `/api` proxy
forwards to `http://127.0.0.1:8001`. The API documentation is at
[http://localhost:8001/docs](http://localhost:8001/docs). Verify both services
and the database from PowerShell:

```powershell
curl.exe -f http://127.0.0.1:8001/health
curl.exe -f http://127.0.0.1:8001/health/database
curl.exe -i http://127.0.0.1:5173/api/v1/auth/me
```

The last request should reach FastAPI through Vite and return HTTP 401 when no
bearer token is supplied.

## Frontend API integration

In development, the React client uses same-origin `/api` requests through Vite's
proxy, which targets `http://127.0.0.1:8001` by default. Set
`VITE_API_PROXY_TARGET` to change that development target. When serving the
frontend and backend separately, set `VITE_API_BASE_URL` to the backend origin
and allow the frontend origin in the backend's `FRONTEND_ORIGINS` setting.
Protected requests use the signed-in user's bearer token; expired or revoked
sessions return to sign-in.

Dashboard, inventory, batches, sales history, waste reports, expiry alerts,
forecasts, recommendations, model metrics, and the model registry read from
their corresponding API endpoints. POS checkout uses the server-authoritative
`POST /api/v1/sales/checkout` service. Generating demand forecasts is an explicit
action because it persists forecast records; opening the page only reads saved
forecasts. Recording waste is also an explicit write and can reduce a selected
batch's remaining quantity.

The current backend does not persist store preferences, import CSV data, restore
settings backups, retrain models, or return feature importance. The UI labels
these limitations rather than reporting simulated success. Data exports include
records returned by the API.

Expiry Alerts reads positive-quantity batches directly from `inventory_batches`
joined to `products`. Its risk bands use each batch's stored expiry date:
expired (<0 days), high (0–3), medium (4–7), low (8–14), and safe (>14).
Search, category/risk/location/supplier filters, pagination, chart summaries,
batch details, and CSV/XLSX exports are served by `/api/v1/expiry-alerts`.
Alert rule changes are append-only events in the existing `user_activity`
table; only administrators and store managers can manage rules. Reviewing a
suggested action does not change stock, apply a discount, or discard a batch.

Product images can be uploaded from the Edit Batch form. They are stored under
`backend\uploads\products` on the API server and appear in Sales / POS only;
other pages continue to use product symbols. Include that folder in backups if
uploaded images need to survive a server move or restore.

## Verification

From `frontend`, run `npm.cmd test` and `npm.cmd run build`. Backend tests run
from the repository root with `python -m pytest backend\tests`; they use isolated
test databases. Do not use the test suite as a substitute for explicitly
authorized production database changes.