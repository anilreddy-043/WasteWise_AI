import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DatabaseBackupPanel from "./DatabaseBackupPanel";
import * as backups from "../services/databaseBackups";

vi.mock("../services/databaseBackups", () => ({
  listDatabaseBackups: vi.fn(),
  createDatabaseBackup: vi.fn(),
  downloadDatabaseBackup: vi.fn(),
  restoreDatabaseBackup: vi.fn(),
  uploadDatabaseBackup: vi.fn(),
}));

const availableBackup: backups.DatabaseBackup = {
  backup_id: "a".repeat(32),
  filename: "wastewise-db-20261106T120000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.wwbackup",
  created_at: "2026-11-06T12:00:00+00:00",
  size_bytes: 4096,
  row_count: 12,
  status: "available",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(backups.listDatabaseBackups).mockResolvedValue([]);
  vi.mocked(backups.createDatabaseBackup).mockResolvedValue({
    ...availableBackup,
    backup_id: availableBackup.backup_id!,
  });
  vi.mocked(backups.downloadDatabaseBackup).mockResolvedValue(new Blob(["backup"]));
  vi.mocked(backups.restoreDatabaseBackup).mockResolvedValue();
  vi.mocked(backups.uploadDatabaseBackup).mockResolvedValue({
    ...availableBackup,
    backup_id: availableBackup.backup_id!,
  });
});

describe("DatabaseBackupPanel", () => {
  it("limits backup controls to administrators", () => {
    render(<DatabaseBackupPanel onNotify={vi.fn()} canManageBackups={false} />);

    expect(screen.getByText("Database backups are available to administrators only.")).toBeInTheDocument();
    expect(backups.listDatabaseBackups).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Create Backup" })).not.toBeInTheDocument();
  });

  it("loads real history and creates a backup with visible loading and success feedback", async () => {
    const onNotify = vi.fn();
    vi.mocked(backups.listDatabaseBackups).mockResolvedValue([availableBackup]);
    render(<DatabaseBackupPanel onNotify={onNotify} canManageBackups />);

    expect(await screen.findByText(availableBackup.filename)).toBeInTheDocument();
    expect(screen.getByText("4.0 KB")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));
    await waitFor(() => expect(backups.createDatabaseBackup).toHaveBeenCalledOnce());
    expect(onNotify).toHaveBeenCalledWith(`Database backup created: ${availableBackup.filename}`);
    expect(backups.listDatabaseBackups).toHaveBeenCalledTimes(2);
  });

  it("downloads a selected available backup through the authenticated service", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    const createObjectUrl = vi.fn().mockReturnValue("blob:test-backup");
    const revokeObjectUrl = vi.fn();
    const anchorClick = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    Object.defineProperty(HTMLAnchorElement.prototype, "click", { configurable: true, value: anchorClick });
    vi.mocked(backups.listDatabaseBackups).mockResolvedValue([availableBackup]);
    const onNotify = vi.fn();
    render(<DatabaseBackupPanel onNotify={onNotify} canManageBackups />);
    await screen.findByText(availableBackup.filename);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(backups.downloadDatabaseBackup).toHaveBeenCalledWith(availableBackup.backup_id));
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(onNotify).toHaveBeenCalledWith(`Backup downloaded: ${availableBackup.filename}`);
    await waitFor(() => expect(revokeObjectUrl).toHaveBeenCalledWith("blob:test-backup"));

    if (originalCreateObjectUrl) {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
    if (originalRevokeObjectUrl) {
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
    } else {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
    Object.defineProperty(HTMLAnchorElement.prototype, "click", { configurable: true, value: originalAnchorClick });
  });

  it("accepts only .wwbackup files and uploads selected backups", async () => {
    const onNotify = vi.fn();
    const { rerender } = render(<DatabaseBackupPanel onNotify={onNotify} canManageBackups />);
    const input = screen.getByLabelText("Select WasteWise backup file");
    const invalidFile = new File(["sql"], "backup.sql", { type: "application/sql" });
    fireEvent.change(input, { target: { files: [invalidFile] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a WasteWise .wwbackup file.");
    expect(backups.uploadDatabaseBackup).not.toHaveBeenCalled();

    rerender(<DatabaseBackupPanel onNotify={onNotify} canManageBackups />);
    const validFile = new File(["encrypted-backup"], "server-backup.wwbackup", { type: "application/octet-stream" });
    fireEvent.change(screen.getByLabelText("Select WasteWise backup file"), { target: { files: [validFile] } });
    fireEvent.click(await screen.findByRole("button", { name: "Upload Backup" }));

    await waitFor(() => expect(backups.uploadDatabaseBackup).toHaveBeenCalledWith(validFile));
    expect(onNotify).toHaveBeenCalledWith(`Verified backup added: ${availableBackup.filename}`);
  });

  it("requires typing the exact restore confirmation before submitting", async () => {
    const onNotify = vi.fn();
    vi.mocked(backups.listDatabaseBackups).mockResolvedValue([availableBackup]);
    render(<DatabaseBackupPanel onNotify={onNotify} canManageBackups />);
    await screen.findByText(availableBackup.filename);

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByRole("dialog", { name: "Confirm database restore" })).toBeInTheDocument();
    const confirmButton = screen.getByRole("button", { name: "Confirm restore" });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type RESTORE DATABASE to continue"), { target: { value: "RESTORE DATABASE" } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(backups.restoreDatabaseBackup).toHaveBeenCalledWith(
      availableBackup.backup_id,
      "RESTORE DATABASE",
    ));
    expect(onNotify).toHaveBeenCalledWith("Database restore completed. A pre-restore safety backup was created.");
  });

  it("displays backup service errors rather than reporting a successful backup", async () => {
    vi.mocked(backups.listDatabaseBackups).mockRejectedValueOnce(new Error("Backup storage is unavailable."));
    render(<DatabaseBackupPanel onNotify={vi.fn()} canManageBackups />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Backup storage is unavailable.");
    expect(backups.createDatabaseBackup).not.toHaveBeenCalled();
  });
});
