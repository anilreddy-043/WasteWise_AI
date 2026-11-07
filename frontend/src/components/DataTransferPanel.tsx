import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import {
  downloadExport,
  importCsv,
} from "../services/dataTransfer";
import type {
  ExportDataset,
  ExportFormat,
  ImportDataset,
  ImportSummary,
} from "../services/dataTransfer";

type DataTransferPanelProps = {
  onNotify: (message: string) => void;
  canImport: boolean;
  canExport: boolean;
};

const importOptions: { dataset: ImportDataset; label: string; hint: string }[] = [
  { dataset: "products", label: "Products", hint: "Product name, category, SKU, unit, price, supplier" },
  { dataset: "inventory", label: "Inventory", hint: "Existing product ID or name/SKU, batch, quantities, and dates" },
  { dataset: "sales", label: "Sales", hint: "Product ID, optional batch ID, timestamp, quantity, unit price" },
];

const exportOptions: { dataset: ExportDataset; label: string }[] = [
  { dataset: "products", label: "Products" },
  { dataset: "inventory", label: "Inventory" },
  { dataset: "sales", label: "Sales" },
  { dataset: "waste", label: "Waste Records" },
  { dataset: "reports", label: "Reports" },
];

const importTemplates: Record<ImportDataset, string[]> = {
  products: ["product_name", "category", "sku", "unit", "price", "supplier"],
  inventory: [
    "product_name", "sku", "category", "unit", "price", "batch_code",
    "quantity_received", "quantity_remaining", "unit_cost", "received_at",
    "expiry_date", "location", "supplier",
  ],
  sales: ["product_id", "batch_id", "sold_at", "quantity", "unit_price"],
};

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export default function DataTransferPanel({ onNotify, canImport, canExport }: DataTransferPanelProps) {
  const [selected, setSelected] = useState<{ dataset: ImportDataset; file: File } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [dragging, setDragging] = useState<ImportDataset | null>(null);
  const inputRefs = useRef<Partial<Record<ImportDataset, HTMLInputElement>>>({});

  function chooseFile(dataset: ImportDataset, file?: File) {
    setImportError("");
    setSummary(null);
    setSelected(null);
    if (!file) return;
    if (!canImport) {
      setImportError("Only administrators can import data.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setImportError("Choose a CSV file. Excel and other file formats are not accepted for imports.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setImportError("CSV files must be 5 MB or smaller.");
      return;
    }
    setSelected({ dataset, file });
  }

  async function runImport() {
    if (!selected || importing) return;
    setImporting(true);
    setImportError("");
    setSummary(null);
    try {
      const result = await importCsv(selected.dataset, selected.file);
      setSummary(result);
      if (result.failed_records > 0) {
        onNotify(`Import rejected: ${result.failed_records} invalid record(s); no rows were committed.`);
      } else if (result.successful_records === 0 && result.skipped_records > 0) {
        onNotify(`Import complete: all ${result.skipped_records} record(s) were already imported or existed.`);
      } else {
        onNotify(`Import complete: ${result.successful_records} record(s) imported, ${result.skipped_records} skipped.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The CSV import could not be completed.";
      setImportError(message);
      onNotify(message);
    } finally {
      setImporting(false);
    }
  }

  function downloadTemplate(dataset: ImportDataset) {
    const header = importTemplates[dataset].map(csvCell).join(",");
    downloadBlob(
      new Blob([`\uFEFF${header}\r\n`], { type: "text/csv;charset=utf-8" }),
      `wastewise-${dataset}-template.csv`,
    );
    onNotify(`${dataset[0].toUpperCase()}${dataset.slice(1)} CSV template downloaded.`);
  }

  async function runExport(dataset: ExportDataset, format: ExportFormat) {
    const key = `${dataset}-${format}`;
    setExporting(key);
    try {
      const blob = await downloadExport(dataset, format);
      downloadBlob(blob, `wastewise-${dataset}-export.${format}`);
      onNotify(`${dataset === "waste" ? "Waste records" : dataset[0].toUpperCase() + dataset.slice(1)} ${format.toUpperCase()} export downloaded.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "The data export could not be downloaded.");
    } finally {
      setExporting(null);
    }
  }

  function downloadErrorReport() {
    if (!summary?.errors.length) return;
    const rows = [
      ["Row", "Validation errors"].map(csvCell).join(","),
      ...summary.errors.map((item) => [item.row, item.errors.join("; ")].map(csvCell).join(",")),
    ];
    downloadBlob(
      new Blob([`\uFEFF${rows.join("\r\n")}`], { type: "text/csv;charset=utf-8" }),
      `wastewise-${summary.dataset}-import-errors.csv`,
    );
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, dataset: ImportDataset) {
    event.preventDefault();
    setDragging(null);
    chooseFile(dataset, event.dataTransfer.files[0]);
  }

  return (
    <div className="data-transfer-panel">
      <section className="data-transfer-import" aria-labelledby="data-import-heading">
        <header className="data-transfer-heading">
          <Upload size={17} />
          <div><h3 id="data-import-heading">Import Data</h3><p>CSV only · up to 5 MB and 5,000 rows · existing records are never overwritten</p></div>
        </header>
        {!canImport && <p className="data-transfer-note">Imports are available to administrators only.</p>}
        <div className="data-import-options">
          {importOptions.map(({ dataset, label, hint }) => (
            <div
              className={`data-import-option ${dragging === dataset ? "dragging" : ""}`}
              key={dataset}
              onDragOver={(event) => { event.preventDefault(); setDragging(dataset); }}
              onDragLeave={() => setDragging(null)}
              onDrop={(event) => handleDrop(event, dataset)}
            >
              <input
                ref={(element) => { if (element) inputRefs.current[dataset] = element; }}
                type="file"
                accept=".csv,text/csv"
                hidden
                aria-label={`Choose ${label} CSV file`}
                onChange={(event) => {
                  chooseFile(dataset, event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <div><b>{label}</b><small>{hint}</small></div>
              <div className="data-import-actions">
                <button type="button" className="data-transfer-link" onClick={() => downloadTemplate(dataset)}>Template</button>
                <button
                  type="button"
                  className="data-transfer-select"
                  disabled={!canImport || importing}
                  onClick={() => inputRefs.current[dataset]?.click()}
                >
                  Choose CSV
                </button>
              </div>
            </div>
          ))}
        </div>
        {selected && <p className="data-transfer-selected">Selected: <b>{selected.file.name}</b> ({Math.ceil(selected.file.size / 1024)} KB · {importOptions.find((option) => option.dataset === selected.dataset)?.label})</p>}
        {importError && <p className="data-transfer-error" role="alert">{importError}</p>}
        {importing && <div className="data-transfer-progress"><progress /><span>Uploading and validating CSV…</span></div>}
        {selected && <button type="button" className="data-transfer-primary" disabled={importing || !canImport} onClick={() => { void runImport(); }}>
          <Upload size={14} /> {importing ? "Importing…" : `Import ${selected.dataset[0].toUpperCase()}${selected.dataset.slice(1)}`}
        </button>}
        {summary && <div className="data-import-summary" role="status">
          <b>{summary.failed_records > 0 ? "Import not applied" : "Import summary"}</b>
          <span>Total: {summary.total_records}</span>
          <span>Successful: {summary.successful_records}</span>
          <span>Skipped: {summary.skipped_records}</span>
          <span>Failed: {summary.failed_records}</span>
          {summary.errors.length > 0 && <button type="button" className="data-transfer-link" onClick={downloadErrorReport}>Download error report</button>}
          {summary.errors.slice(0, 5).map((item) => <small key={item.row}>Row {item.row}: {item.errors.join(" ")}</small>)}
          {summary.errors.length > 5 && <small>{summary.errors.length - 5} additional failed rows are included in the error report.</small>}
        </div>}
      </section>

      <section className="data-transfer-export" aria-labelledby="data-export-heading">
        <header className="data-transfer-heading">
          <Download size={17} />
          <div><h3 id="data-export-heading">Export MySQL Data</h3><p>Download current operational records with source fields and timestamps</p></div>
        </header>
        {!canExport && <p className="data-transfer-note">Exports are available to administrators only.</p>}
        <div className="data-export-options">
          {exportOptions.map(({ dataset, label }) => (
            <div className="data-export-option" key={dataset}>
              <span><FileSpreadsheet size={14} /> {label}</span>
              <button type="button" disabled={!canExport || exporting !== null} onClick={() => { void runExport(dataset, "csv"); }}>
                {exporting === `${dataset}-csv` ? "Preparing…" : "CSV"}
              </button>
              <button type="button" disabled={!canExport || exporting !== null} onClick={() => { void runExport(dataset, "xlsx"); }}>
                {exporting === `${dataset}-xlsx` ? "Preparing…" : "Excel"}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
