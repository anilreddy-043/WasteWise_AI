import { requestAuthenticatedBlob, requestAuthenticatedJson } from "./auth";

export type ImportDataset = "products" | "inventory" | "sales";
export type ExportDataset = ImportDataset | "waste" | "reports";
export type ExportFormat = "csv" | "xlsx";

export type ImportError = {
  row: number;
  errors: string[];
};

export type ImportSummary = {
  dataset: ImportDataset;
  import_id: string;
  total_records: number;
  successful_records: number;
  skipped_records: number;
  failed_records: number;
  errors: ImportError[];
};

export function importCsv(dataset: ImportDataset, file: File): Promise<ImportSummary> {
  const formData = new FormData();
  formData.append("file", file);
  return requestAuthenticatedJson(`/api/v1/data/imports/${dataset}`, {
    method: "POST",
    body: formData,
  });
}

export function downloadExport(dataset: ExportDataset, format: ExportFormat): Promise<Blob> {
  const query = new URLSearchParams({ format });
  return requestAuthenticatedBlob(`/api/v1/data/exports/${dataset}?${query.toString()}`);
}
