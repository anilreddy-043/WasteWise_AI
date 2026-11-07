import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, HardDrive, RefreshCw, RotateCcw, Upload } from "lucide-react";
import {
  createDatabaseBackup,
  downloadDatabaseBackup,
  listDatabaseBackups,
  restoreDatabaseBackup,
  uploadDatabaseBackup,
} from "../services/databaseBackups";
import type { DatabaseBackup } from "../services/databaseBackups";

const RESTORE_CONFIRMATION = "RESTORE DATABASE";
const MAX_BACKUP_FILE_BYTES = 256 * 1024 * 1024;

type DatabaseBackupPanelProps = {
  onNotify: (message: string) => void;
  canManageBackups: boolean;
};

function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function DatabaseBackupPanel({ onNotify, canManageBackups }: DatabaseBackupPanelProps) {
  const [backups, setBackups] = useState<DatabaseBackup[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [selectedRestore, setSelectedRestore] = useState<DatabaseBackup | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [error, setError] = useState("");
  const [selectedUpload, setSelectedUpload] = useState<File | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  async function refreshHistory() {
    setLoading(true);
    setError("");
    try {
      setBackups(await listDatabaseBackups());
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not load database backup history.";
      setError(message);
      onNotify(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canManageBackups) void refreshHistory();
  }, [canManageBackups]);

  async function createBackup() {
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      const backup = await createDatabaseBackup();
      onNotify(`Database backup created: ${backup.filename}`);
      await refreshHistory();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Database backup could not be created.";
      setError(message);
      onNotify(message);
    } finally {
      setCreating(false);
    }
  }

  async function downloadBackup(backup: DatabaseBackup) {
    if (!backup.backup_id || downloading) return;
    setDownloading(backup.backup_id);
    setError("");
    try {
      const blob = await downloadDatabaseBackup(backup.backup_id);
      downloadBlob(blob, backup.filename);
      onNotify(`Backup downloaded: ${backup.filename}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Backup download failed.";
      setError(message);
      onNotify(message);
    } finally {
      setDownloading(null);
    }
  }

  function chooseBackupFile(file?: File) {
    setError("");
    setSelectedUpload(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".wwbackup")) {
      setError("Choose a WasteWise .wwbackup file. SQL, ZIP, and other files are not accepted.");
      return;
    }
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      setError("Backup files must be 256 MB or smaller.");
      return;
    }
    setSelectedUpload(file);
  }

  async function uploadBackup() {
    if (!selectedUpload || uploading) return;
    setUploading(true);
    setError("");
    try {
      const backup = await uploadDatabaseBackup(selectedUpload);
      setSelectedUpload(null);
      if (uploadInput.current) uploadInput.current.value = "";
      onNotify(`Verified backup added: ${backup.filename}`);
      await refreshHistory();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The backup file could not be validated.";
      setError(message);
      onNotify(message);
    } finally {
      setUploading(false);
    }
  }

  async function restoreSelectedBackup() {
    if (!selectedRestore?.backup_id || confirmationText !== RESTORE_CONFIRMATION || restoring) return;
    setRestoring(true);
    setError("");
    try {
      await restoreDatabaseBackup(selectedRestore.backup_id, confirmationText);
      setSelectedRestore(null);
      setConfirmationText("");
      onNotify("Database restore completed. A pre-restore safety backup was created.");
      await refreshHistory();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Database restore failed.";
      setError(message);
      onNotify(message);
    } finally {
      setRestoring(false);
    }
  }

  if (!canManageBackups) {
    return <p className="backup-admin-note">Database backups are available to administrators only.</p>;
  }

  return (
    <div className="database-backup-panel">
      <div className="database-backup-controls">
        <div className="database-backup-heading">
          <h3><HardDrive size={17} /> Database Backup &amp; Restore</h3>
          <p>Private, encrypted, integrity-checked snapshots of the current database records.</p>
        </div>
        <div className="database-backup-buttons">
          <button type="button" className="database-backup-create" onClick={() => { void createBackup(); }} disabled={creating || loading || uploading}>
            <HardDrive size={15} /> {creating ? "Creating backup…" : "Create Backup"}
          </button>
          <input
            ref={uploadInput}
            className="database-backup-file-input"
            type="file"
            accept=".wwbackup,application/octet-stream"
            aria-label="Select WasteWise backup file"
            onChange={(event) => chooseBackupFile(event.target.files?.[0])}
          />
          <button type="button" className="database-backup-upload-select" onClick={() => uploadInput.current?.click()} disabled={creating || loading || uploading}>
            <Upload size={15} /> Select Backup
          </button>
        </div>
      </div>
      {selectedUpload && (
        <div className="database-backup-upload-row">
          <span>{selectedUpload.name}</span>
          <button type="button" onClick={() => { void uploadBackup(); }} disabled={uploading || creating}>
            {uploading ? "Validating and importing…" : "Upload Backup"}
          </button>
        </div>
      )}
      <p className="database-backup-scope">
        Backups contain data for the current schema. Restores replace live records and require typing <b>{RESTORE_CONFIRMATION}</b>.
        A safety backup is created before each restore. Upload only signature-verified encrypted WasteWise backups (256 MB max).
      </p>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="database-backup-history-heading">
        <h4>Backup history</h4>
        <button type="button" onClick={() => { void refreshHistory(); }} disabled={loading || creating || uploading || restoring} aria-label="Refresh backup history">
          <RefreshCw size={14} /> {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {loading && backups.length === 0 ? (
        <p className="database-backup-empty" role="status">Loading backup history…</p>
      ) : backups.length === 0 ? (
        <p className="database-backup-empty">No database backups have been created.</p>
      ) : (
        <div className="database-backup-table-wrap">
          <table className="database-backup-table">
            <thead><tr><th>Filename</th><th>Date</th><th>Size</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{backups.map((backup) => (
              <tr key={backup.backup_id ?? `${backup.status}-${backup.created_at}-${backup.filename}`}>
                <td>{backup.filename}</td>
                <td>{formatDate(backup.created_at)}</td>
                <td>{formatSize(backup.size_bytes)}</td>
                <td><span className={`database-backup-status ${backup.status}`}>{backup.status}</span></td>
                <td className="database-backup-actions">
                  <button type="button" disabled={backup.status !== "available" || downloading !== null || creating || uploading || restoring} onClick={() => { void downloadBackup(backup); }}>
                    <Download size={13} /> {downloading === backup.backup_id ? "Downloading…" : "Download"}
                  </button>
                  <button type="button" className="database-backup-restore" disabled={backup.status !== "available" || creating || uploading || restoring} onClick={() => { setSelectedRestore(backup); setConfirmationText(""); }}>
                    <RotateCcw size={13} /> Restore
                  </button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {selectedRestore && (
        <div className="database-restore-backdrop">
          <section className="database-restore-dialog" role="dialog" aria-modal="true" aria-labelledby="database-restore-title">
            <h3 id="database-restore-title"><AlertTriangle size={18} /> Confirm database restore</h3>
            <p>This will replace the live database records with <b>{selectedRestore.filename}</b>. This action cannot be undone. A pre-restore safety backup will be created first.</p>
            <label htmlFor="database-restore-confirmation">Type {RESTORE_CONFIRMATION} to continue</label>
            <input id="database-restore-confirmation" value={confirmationText} onChange={(event) => setConfirmationText(event.target.value)} autoComplete="off" />
            <div className="database-restore-actions">
              <button type="button" disabled={restoring} onClick={() => { setSelectedRestore(null); setConfirmationText(""); }}>Cancel</button>
              <button type="button" className="database-restore-confirm" disabled={restoring || confirmationText !== RESTORE_CONFIRMATION} onClick={() => { void restoreSelectedBackup(); }}>
                {restoring ? "Restoring…" : "Confirm restore"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
