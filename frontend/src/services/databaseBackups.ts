import { requestAuthenticatedBlob, requestAuthenticatedJson } from "./auth";

export type DatabaseBackup = {
  backup_id: string | null;
  filename: string;
  created_at: string;
  size_bytes: number;
  row_count: number;
  status: "available" | "invalid" | "failed" | "missing";
};

export type CreatedDatabaseBackup = Omit<DatabaseBackup, "backup_id"> & {
  backup_id: string;
};

export async function listDatabaseBackups(): Promise<DatabaseBackup[]> {
  return requestAuthenticatedJson<DatabaseBackup[]>("/api/v1/backups");
}

export async function createDatabaseBackup(): Promise<CreatedDatabaseBackup> {
  return requestAuthenticatedJson<CreatedDatabaseBackup>("/api/v1/backups", { method: "POST" });
}

export async function uploadDatabaseBackup(file: File): Promise<CreatedDatabaseBackup> {
  const form = new FormData();
  form.append("file", file);
  return requestAuthenticatedJson<CreatedDatabaseBackup>("/api/v1/backups/upload", {
    method: "POST",
    body: form,
  });
}

export function downloadDatabaseBackup(backupId: string): Promise<Blob> {
  return requestAuthenticatedBlob(`/api/v1/backups/${encodeURIComponent(backupId)}/download`);
}

export async function restoreDatabaseBackup(backupId: string, confirmationText: string): Promise<void> {
  await requestAuthenticatedJson<{ status: string }>(`/api/v1/backups/${encodeURIComponent(backupId)}/restore`, {
    method: "POST",
    body: JSON.stringify({
      confirm_restore: true,
      confirmation_text: confirmationText,
    }),
  });
}
