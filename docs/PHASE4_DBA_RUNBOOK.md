# WasteWise AI Phase 4 — DBA Runbook

## Scope and safety

This runbook applies `database/migrations/20261102_extend_recommendation_types.sql` only to MySQL database `wastewise_ai` on MySQL 8.0.46. The migration preserves the existing ENUM values, adds `reorder` and `remove`, adds nullable recommendation batch linkage, and adds an application timestamp column.

Do not use an application credential. Do not put passwords in this file, in environment variables committed to source control, or in PowerShell command history. Use MySQL's `-p` prompt. Stop immediately if the inspected target differs from the values below.

## Migration review result

No SQL defect remained after review. The migration is rerunnable and includes MySQL 8-compatible checks for:

- Existing `recommendations.batch_id` wrong type.
- Existing source `inventory_batches.batch_id` type.
- Existing orphaned batch references before adding a foreign key.
- Existing matching foreign key relationships.
- Conflicting foreign-key names.
- Missing indexes.

If a conflicting schema is reported, stop and resolve it manually before retrying.

## DBA prerequisite checklist

From PowerShell, run only against the expected server:

```powershell
$MySQLBin = 'C:\Program Files\MySQL\MySQL Server 8.0\bin'
$DBHost = '127.0.0.1'
$DBPort = '3306'
$DBAUser = Read-Host 'Authorized DBA username'
$Database = 'wastewise_ai'
& "$MySQLBin\mysql.exe" --version
```

Verify the server and database. The password is requested interactively and is not echoed:

```powershell
& "$MySQLBin\mysql.exe" `
  --host=$DBHost --port=$DBPort --user=$DBAUser -p `
  --execute="SELECT VERSION() AS mysql_version, DATABASE(); SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='wastewise_ai';"
```

Then explicitly select the database and inspect its identity and counts:

```powershell
& "$MySQLBin\mysql.exe" `
  --host=$DBHost --port=$DBPort --user=$DBAUser -p `
  --database=$Database `
  --execute="SELECT VERSION() AS mysql_version, DATABASE() AS selected_database; SHOW CREATE TABLE recommendations; SHOW CREATE TABLE inventory_batches; SELECT COUNT(*) AS recommendation_total FROM recommendations;"
```

Expected database name: `wastewise_ai`. Expected source key: `inventory_batches.batch_id`, `bigint unsigned`, InnoDB.

## Create and verify the backup

Run in the project root. Do not reuse a backup filename after an older backup exists.

```powershell
$ProjectRoot = 'D:\11AM_Data_Science_NIT\End_to_End_Projects\WasteWise-AI'
$BackupDir = Join-Path $ProjectRoot 'database\backups'
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
$Timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$BackupFile = Join-Path $BackupDir "wastewise_ai_$Timestamp.sql"

& "$MySQLBin\mysqldump.exe" `
  --host=$DBHost --port=$DBPort --user=$DBAUser -p `
  --databases $Database `
  --routines --events --triggers `
  --single-transaction --add-drop-table `
  --set-gtid-purged=OFF `
  --result-file=$BackupFile

Get-Item -LiteralPath $BackupFile
Get-FileHash -Algorithm SHA256 -LiteralPath $BackupFile
```

A zero-byte or missing file is a stop condition. Record the SHA-256 hash in the DBA change record.

Confirm the dump is readable and contains the required schema and data sections:

```powershell
if ((Get-Item -LiteralPath $BackupFile).Length -eq 0) { throw 'Backup is empty.' }
$DumpText = Get-Content -LiteralPath $BackupFile -Raw
if ($DumpText -notmatch 'CREATE TABLE `recommendations`') { throw 'Backup does not contain recommendations schema.' }
if ($DumpText -notmatch 'CREATE TABLE `inventory_batches`') { throw 'Backup does not contain inventory_batches schema.' }
"Dump bytes: $((Get-Item -LiteralPath $BackupFile).Length)"
"Recommendations table found: $($DumpText.Contains('CREATE TABLE `recommendations`'))"
"MySQL dump header:
$(Get-Content -LiteralPath $BackupFile -TotalCount 12 | Out-String)"
```

Best-practice restore validation: restore the dump to a disposable database using a DBA account. This is optional only if policy permits creating a temporary schema; it does not change `wastewise_ai`.

```powershell
$RestoreDB = "wastewise_ai_restore_$Timestamp"
& "$MySQLBin\mysql.exe" --host=$DBHost --port=$DBPort --user=$DBAUser -p `
  --execute="CREATE DATABASE ``$RestoreDB`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# The full dump explicitly selects wastewise_ai, so adapt a verification copy without touching the backup.
$VerifyFile = Join-Path $BackupDir "restore_verify_$Timestamp.sql"
$VerifyText = Get-Content -LiteralPath $BackupFile -Raw
$VerifyText = $VerifyText.Replace('CREATE DATABASE /*!32312 IF NOT EXISTS*/ `wastewise_ai`', 'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `' + $RestoreDB + '`')
$VerifyText = $VerifyText.Replace('USE `wastewise_ai`;', 'USE `' + $RestoreDB + '`;')
Set-Content -LiteralPath $VerifyFile -Value $VerifyText -NoNewline

Get-Content -LiteralPath $VerifyFile -Raw | `
  & "$MySQLBin\mysql.exe" --host=$DBHost --port=$DBPort --user=$DBAUser -p

& "$MySQLBin\mysql.exe" --host=$DBHost --port=$DBPort --user=$DBAUser -p `
  --database=$RestoreDB `
  --execute="SELECT COUNT(*) AS restored_recommendations FROM recommendations; CHECK TABLE recommendations, inventory_batches;"
```

After review, remove only the disposable database:

```powershell
& "$MySQLBin\mysql.exe" --host=$DBHost --port=$DBPort --user=$DBAUser -p `
  --execute="DROP DATABASE ``$RestoreDB``;"
Remove-Item -LiteralPath $VerifyFile
```

## Execute the migration

Before execution, record the recommendation count and create a rollback point from the verified backup:

```powershell
& "$MySQLBin\mysql.exe" --host=$DBHost --port=$DBPort --user=$DBAUser -p `
  --database=$Database `
  --execute="SELECT COUNT(*) AS recommendation_count FROM recommendations;"

$MigrationFile = Join-Path $ProjectRoot 'database\migrations\20261102_extend_recommendation_types.sql'
Get-Item -LiteralPath $MigrationFile
```

Execute with the DBA account. MySQL will prompt for the password and continue reading migration SQL through standard input.

```powershell
Get-Content -LiteralPath $MigrationFile -Raw | `
  & "$MySQLBin\mysql.exe" --host=$DBHost --port=$DBPort --user=$DBAUser -p `
  --database=$Database --show-warnings
```

No output or success after procedure execution is insufficient. Run the verification script next.

## Post-migration verification

```powershell
$VerificationFile = Join-Path $ProjectRoot 'database\migrations\20261102_phase4_verification.sql'
Get-Content -LiteralPath $VerificationFile -Raw | `
  & "$MySQLBin\mysql.exe" --host=$DBHost --port=$DBPort --user=$DBAUser -p `
  --database=$Database --table
```

Verify:

- `recommendations.batch_id` exists as `bigint unsigned NULL`.
- `recommendations.applied_at` exists as `datetime NULL`.
- `recommendation_type` contains `restock`, `discount`, `transfer`, `donate`, `reorder`, and `remove`.
- `fk_recommendations_batch` references `inventory_batches.batch_id` and uses `ON DELETE SET NULL` and `ON UPDATE CASCADE`.
- Recommendation count matches the count recorded before migration.
- `orphaned_batch_references` is zero.
- `ix_recommendations_batch` exists.

## SQL verification script

The source of truth is [20261102_phase4_verification.sql](../database/migrations/20261102_phase4_verification.sql).

## Recovery procedure

If migration execution fails before completion, do not rerun while the error has not been resolved.

1. Capture the complete MySQL error and warning output.
2. Compare `recommendations` and `inventory_batches` metadata with the backup.
3. Confirm whether the failure occurred on `ENUM`, column, index, orphan check, or foreign-key creation.
4. Do not manually drop or truncate data.
5. If data or schema recovery is required, stop application traffic, stop database writes, and restore the verified backup to a controlled recovery database or server by an authorized DBA.
6. For restoring the original database, use only a maintenance window and a DBA-approved procedure after verifying the original backup:

```powershell
# The following line is intentionally a decision point, not a routine command:
# On an isolated recovery MySQL server, restore a copy and verify counts before promoting it.
Get-Content -LiteralPath $BackupFile -Raw | & "$MySQLBin\mysql.exe" --host=$RecoveryHost --port=$RecoveryPort --user=$DBAUser -p
```

7. Reconcile the recommendation count and `SHOW CREATE TABLE recommendations` after restoration.
8. Reapply migration only after the specific incompatibility is corrected and approved.

## DBA completion checklist

- [ ] MySQL server and database were verified before execution.
- [ ] No application account credentials were used.
- [ ] No password appears in source files or PowerShell command history.
- [ ] Pre-migration recommendation count was recorded.
- [ ] Timestamped full backup exists and is non-empty.
- [ ] SHA-256 hash was recorded.
- [ ] Backup dump contained both required tables.
- [ ] Disposable restore validation passed, or an approved equivalent backup validation was completed.
- [ ] Migration completed without errors.
- [ ] New columns exist with expected types.
- [ ] ENUM values are all correct.
- [ ] Foreign key and index are correct.
- [ ] Recommendation count is unchanged.
- [ ] Orphaned batch reference count is zero.
- [ ] Application backend and recommendation queries were smoke-tested.
- [ ] Rollback backup location and hash are attached to the change record.
