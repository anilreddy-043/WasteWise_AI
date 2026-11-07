import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  Eye,
  Leaf,
  ListFilter,
  FileUp,
  Package,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  createBatch,
  deleteBatch,
  listBatches,
  getExpirySuggestion,
  confirmInventoryBatchImport,
  listInventoryBatchImports,
  previewInventoryBatchImport,
  listProducts,
  updateBatch,
  uploadProductImage,
  deleteProductImage,
} from "../services/business";
import type {
  BatchImportHistoryRecord,
  BatchImportPreview,
  BatchImportRow,
  ExpiryDateSource,
  InventoryBatchRecord,
  ProductRecord,
} from "../services/business";
import ProductSymbolIcon from "../components/ProductSymbol";
import { productSymbol } from "../services/productSymbols";
import { findExistingProduct, PRODUCT_CATEGORIES } from "../services/productSuggestions";
import { prepareProductImage } from "../services/productImageUpload";
import { visiblePageNumbers } from "../services/pagination";
import { useGeneralSettings } from "../services/generalSettings";
import { formatAppDate } from "../services/generalSettings";
import { formatAppDateTime } from "../services/generalSettings";

type Batch = {
  id: number;
  productId: number;
  batchId: string;
  emoji: string;
  product: string;
  category: string;
  quantityReceived: number;
  quantity: number;
  receivedDate: string;
  expiryDate: string;
  daysLeft: number;
  location: string;
  supplier: string;
  expiryDateSource: InventoryBatchRecord["expiry_date_source"];
};

type BatchForm = {
  product: string;
  category: string;
  quantity: string;
  receivedDate: string;
  expiryDate: string;
  expiryDateSource: ExpiryDateSource | "";
  location: string;
  supplier: string;
};

type BatchManagementProps = { onNotify: (message: string) => void; canEdit?: boolean; canDelete?: boolean; canImport?: boolean };

const BATCH_IMPORT_COLUMNS = [
  "product_name", "sku", "category", "unit", "price", "batch_code", "quantity_received",
  "quantity_remaining", "unit_cost", "received_at", "expiry_date", "location", "supplier",
];

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function serializeImportRows(rows: BatchImportRow[]): string {
  return [
    BATCH_IMPORT_COLUMNS.join(","),
    ...rows.map((row) => BATCH_IMPORT_COLUMNS.map((column) => csvCell(row.values[column] ?? "")).join(",")),
  ].join("\r\n");
}

function todayIso(): string {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function daysUntil(value: string): number {
  const target = new Date(`${value}T00:00:00Z`).getTime();
  const today = new Date(`${todayIso()}T00:00:00Z`).getTime();
  return Math.round((target - today) / 86400000);
}

function newBatchCode(): string {
  const secureId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `BCH-${secureId}`;
}

function toBatch(
  batch: InventoryBatchRecord,
  product: ProductRecord | undefined,
): Batch {
  return {
    id: batch.batch_id,
    productId: batch.product_id,
    batchId: batch.batch_code,
    emoji: productSymbol(product?.name ?? `Product #${batch.product_id}`, product?.category),
    product: product?.name ?? `Product #${batch.product_id}`,
    category: product?.category ?? "Uncategorized",
    quantityReceived: Number(batch.quantity_received),
    quantity: Number(batch.quantity_remaining),
    receivedDate: batch.received_at,
    expiryDate: batch.expiry_date,
    expiryDateSource: batch.expiry_date_source,
    daysLeft: daysUntil(batch.expiry_date),
    location: batch.location,
    supplier: batch.supplier ?? product?.supplier ?? "Not recorded",
  };
}

function formatDate(date: string) {
  return formatAppDate(date);
}

function getBatchStatus(batch: Pick<Batch, "daysLeft" | "quantity">) {
  if (batch.quantity <= 0) return "Consumed/Sold";
  if (batch.daysLeft < 0) return "Expired";
  if (batch.daysLeft <= 7) return "Expiring Soon";
  return "Fresh";
}

function expirySourceLabel(source: Batch["expiryDateSource"]): string {
  if (source === "estimated") return "Estimated";
  if (source === "manufacturer_verified") return "Manufacturer verified";
  if (source === "manual_verified") return "Manually verified";
  if (source === "imported") return "Imported";
  return "Unverified legacy date";
}

export default function BatchManagement({ onNotify, canEdit = true, canDelete = true, canImport = true }: BatchManagementProps) {
  const { items_per_page: pageSize } = useGeneralSettings();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [query, setQuery] = useState("");
  const [productFilter, setProductFilter] = useState("All Products");
  const [statusFilter, setStatusFilter] = useState("All Status");
  const [locationFilter, setLocationFilter] = useState("All Locations");
  const [categoryFilter, setCategoryFilter] = useState("All Categories");
  const [categoryFilterOpen, setCategoryFilterOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [pageSize]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Batch | null>(null);
  const [viewing, setViewing] = useState<Batch | null>(null);
  const [form, setForm] = useState<BatchForm>(() => {
    const receivedDate = todayIso();
    return {
      product: "",
      category: "Fruits",
      quantity: "",
      receivedDate,
      expiryDate: "",
      expiryDateSource: "estimated" as const,
      location: "Unassigned",
      supplier: "",
    };
  });
  const [expiryDateManuallyEdited, setExpiryDateManuallyEdited] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [savingProductImage, setSavingProductImage] = useState(false);
  const [expirySuggestionDays, setExpirySuggestionDays] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const productImageInput = useRef<HTMLInputElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<BatchImportPreview | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importId, setImportId] = useState("");
  const [importError, setImportError] = useState("");
  const [draggingImport, setDraggingImport] = useState(false);
  const importDragDepth = useRef(0);
  const [createMissingProducts, setCreateMissingProducts] = useState(false);
  const [importHistory, setImportHistory] = useState<BatchImportHistoryRecord[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(true);

  useEffect(() => {
    const product = findExistingProduct(products, form.product);
    if (!product || product.category !== form.category || !form.receivedDate) {
      setExpirySuggestionDays(null);
      return;
    }
    const receiptDateChanged = !editing || form.receivedDate !== editing.receivedDate;
    if (
      expiryDateManuallyEdited
      || form.expiryDateSource !== "estimated"
      || (editing && !receiptDateChanged)
    ) return;
    let active = true;
    getExpirySuggestion(product.product_id, form.receivedDate)
      .then((suggestion) => {
        if (!active) return;
        setExpirySuggestionDays(suggestion.default_shelf_life_days);
        setForm((current) => ({
          ...current,
          expiryDate: suggestion.expiry_date ?? "",
          expiryDateSource: "estimated",
        }));
      })
      .catch((error: unknown) => {
        if (active) onNotify(error instanceof Error ? error.message : "Could not load the category shelf-life suggestion.");
      });
    return () => { active = false; };
  }, [products, form.product, form.category, form.receivedDate, form.expiryDateSource, expiryDateManuallyEdited, editing, onNotify]);

  async function refreshBatches() {
    const [productRows, batchRows] = await Promise.all([listProducts(), listBatches()]);
    setProducts(productRows);
    const productsById = new Map(productRows.map((product) => [product.product_id, product]));
    setBatches(batchRows.map((batch) => toBatch(batch, productsById.get(batch.product_id))));
  }

  useEffect(() => {
    let active = true;
    Promise.all([listProducts(), listBatches()])
      .then(([productRows, batchRows]) => {
        if (!active) return;
        setProducts(productRows);
        const productsById = new Map(productRows.map((product) => [product.product_id, product]));
        setBatches(batchRows.map((batch) => toBatch(batch, productsById.get(batch.product_id))));
      })
      .catch((error: unknown) => {
        if (active) onNotify(error instanceof Error ? error.message : "Could not load inventory batches.");
      })
      .finally(() => { if (active) setLoadingBatches(false); });
    return () => { active = false; };
  }, [onNotify]);

  const filteredBatches = useMemo(() => batches.filter((batch) => {
    const needle = query.trim().toLowerCase();
    const matchesQuery = !needle || [batch.batchId, batch.product, batch.supplier, batch.category].some((value) => value.toLowerCase().includes(needle));
    const status = getBatchStatus(batch);
    const matchesDates = (!dateFrom || batch.receivedDate >= dateFrom) && (!dateTo || batch.receivedDate <= dateTo);
    return matchesQuery && (productFilter === "All Products" || batch.product === productFilter)
      && (statusFilter === "All Status" || status === statusFilter)
      && (locationFilter === "All Locations" || batch.location === locationFilter)
      && (categoryFilter === "All Categories" || batch.category === categoryFilter)
      && matchesDates;
  }), [batches, query, productFilter, statusFilter, locationFilter, categoryFilter, dateFrom, dateTo]);

  const totalPages = Math.max(1, Math.ceil(filteredBatches.length / pageSize));
  const visibleBatches = filteredBatches.slice((page - 1) * pageSize, page * pageSize);
  const productOptions = [...new Set([
    ...products.map((product) => product.name),
    ...batches.map((batch) => batch.product),
  ])];
  const categoryOptions = [...new Set([
    ...PRODUCT_CATEGORIES,
    ...products.map((product) => product.category).filter(Boolean),
    ...batches.map((batch) => batch.category).filter(Boolean),
  ])];
  const locationOptions = [...new Set(["Unassigned", ...batches.map((batch) => batch.location)])];
  const selectedProduct = findExistingProduct(products, form.product);
  const imageProduct = editing
    ? products.find((product) => product.product_id === editing.productId)
    : undefined;
  const upcoming = batches.filter((batch) => batch.quantity > 0 && batch.daysLeft >= 0 && batch.daysLeft <= 7).slice(0, 5);
  const expiredCount = batches.filter((batch) => batch.quantity > 0 && batch.daysLeft < 0).length;
  const expiringCount = batches.filter((batch) => batch.quantity > 0 && batch.daysLeft >= 0 && batch.daysLeft <= 7).length;
  const depletedCount = batches.filter((batch) => batch.quantity <= 0).length;
  const freshCount = Math.max(0, batches.length - expiredCount - expiringCount - depletedCount);
  const locationStats = [...new Set(batches.map((batch) => batch.location))].map((name) => {
    const matching = batches.filter((batch) => batch.location === name);
    return {
      name,
      batches: matching.length,
      quantity: matching.reduce((total, batch) => total + batch.quantity, 0),
      products: [...new Map(matching.map((batch) => [batch.product, { name: batch.product, emoji: batch.emoji }])).values()],
    };
  });
  const distributionTotal = Math.max(1, batches.length);
  const distribution = [
    { name: "Fresh", count: freshCount, color: "#18a65a" },
    { name: "Expiring Soon", count: expiringCount, color: "#f7b52d" },
    { name: "Expired", count: expiredCount, color: "#ed5a5a" },
    { name: "Consumed/Sold", count: depletedCount, color: "#438ff1" },
  ];
  const donutGradient = batches.length === 0 ? "conic-gradient(#e9eef2 0% 100%)" : `conic-gradient(${distribution.map((item, index) => {
    const start = distribution.slice(0, index).reduce((sum, previous) => sum + previous.count, 0) / distributionTotal * 100;
    const end = start + item.count / distributionTotal * 100;
    return `${item.color} ${start}% ${end}%`;
  }).join(", ")})`;

  function openAdd() {
    if (!canEdit) {
      onNotify("Your role cannot create or edit inventory batches.");
      return;
    }
    setEditing(null);
    const category = categoryOptions[0] ?? "";
    const receivedDate = todayIso();
    setExpiryDateManuallyEdited(false);
    setForm({
      product: "",
      category,
      quantity: "",
      receivedDate,
      expiryDate: "",
      expiryDateSource: "estimated",
      location: locationOptions[0] ?? "Unassigned",
      supplier: "",
    });
    setModalOpen(true);
  }

  async function removeBatches(ids: number[]) {
    if (!canDelete) {
      onNotify("Your role cannot delete inventory batches.");
      return;
    }
    let removed = 0;
    try {
      for (const id of ids) {
        await deleteBatch(id);
        removed += 1;
      }
      await refreshBatches();
      onNotify(`${removed} batch${removed === 1 ? "" : "es"} deleted`);
    } catch (error) {
      try {
        await refreshBatches();
      } catch (refreshError) {
        onNotify(refreshError instanceof Error ? refreshError.message : "The batch list could not be refreshed.");
      }
      onNotify(
        removed
          ? `${removed} batch${removed === 1 ? "" : "es"} deleted. ${error instanceof Error ? error.message : "The remaining batches could not be deleted."}`
          : error instanceof Error ? error.message : "Could not delete batch.",
      );
    } finally {
      setSelected([]);
      setPage(1);
    }
  }

  function openEdit(batch: Batch) {
    if (!canEdit) {
      onNotify("Your role cannot create or edit inventory batches.");
      return;
    }
    setEditing(batch);
    setExpiryDateManuallyEdited(batch.expiryDateSource !== "estimated");
    setForm({ product: batch.product, category: batch.category, quantity: String(batch.quantity), receivedDate: batch.receivedDate, expiryDate: batch.expiryDate, expiryDateSource: batch.expiryDateSource ?? "", location: batch.location, supplier: batch.supplier });
    setModalOpen(true);
  }

  async function handleProductImageUpload(file?: File) {
    if (!file || !editing || !imageProduct) return;
    if (!file.type.startsWith("image/")) {
      onNotify("Choose an image file.");
      return;
    }
    setSavingProductImage(true);
    try {
      const optimizedImage = await prepareProductImage(file);
      const result = await uploadProductImage(imageProduct.product_id, optimizedImage);
      setProducts((current) => current.map((product) => product.product_id === imageProduct.product_id
        ? { ...product, image_url: result.image_url }
        : product));
      onNotify("Product image uploaded. It will appear in Sales / POS only.");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Could not upload the product image.");
    } finally {
      setSavingProductImage(false);
      if (productImageInput.current) productImageInput.current.value = "";
    }
  }

  async function handleProductImageRemove() {
    if (!editing || !imageProduct || savingProductImage) return;
    setSavingProductImage(true);
    try {
      await deleteProductImage(imageProduct.product_id);
      setProducts((current) => current.map((product) => product.product_id === imageProduct.product_id
        ? { ...product, image_url: null }
        : product));
      onNotify("Product image removed.");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Could not remove the product image.");
    } finally {
      setSavingProductImage(false);
    }
  }

  async function saveBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) {
      onNotify("Your role cannot create or edit inventory batches.");
      return;
    }

    if (saving) return;
    const product = findExistingProduct(products, form.product);
    if (!product) {
      onNotify("Select an existing product. Create new products in Products first.");
      return;
    }
    if (product.category !== form.category) {
      onNotify("The batch category must match the selected product. Change the product category in Products.");
      return;
    }
    const quantity = Number(form.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      onNotify("Quantity must be greater than zero.");
      return;
    }
    if (form.expiryDate < form.receivedDate) {
      onNotify("Expiry date cannot be before received date.");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateBatch(editing.id, {
          quantity_remaining: quantity,
          received_at: form.receivedDate,
          expiry_date: form.expiryDate,
          expiry_date_source: form.expiryDateSource || null,
          location: form.location,
          supplier: form.supplier.trim() || null,
        });
      } else {
        await createBatch({
          product_id: product.product_id,
          batch_code: newBatchCode(),
          quantity_received: Number(form.quantity),
          quantity_remaining: Number(form.quantity),
          unit_cost: 0,
          received_at: form.receivedDate,
          expiry_date: form.expiryDate,
          expiry_date_source: form.expiryDateSource || "estimated",
          location: form.location,
          supplier: form.supplier.trim() || product.supplier,
        });
      }
      await refreshBatches();
      setModalOpen(false);
      setEditing(null);
      setPage(1);
      onNotify(editing ? "Batch updated" : "Batch added");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Could not save batch.");
    } finally {
      setSaving(false);
    }
  }

  function openImportDialog() {
    if (!canImport) {
      onNotify("Only administrators can import inventory batches.");
      return;
    }
    setImportOpen(true);
    setImportPreview(null);
    setImportFileName("");
    setImportId("");
    setImportError("");
    setCreateMissingProducts(false);
    listInventoryBatchImports()
      .then(setImportHistory)
      .catch((error: unknown) => setImportError(error instanceof Error ? error.message : "Could not load import history."));
  }

  async function handleBatchImport(file?: File) {
    if (!file) return;
    if (!canImport) {
      onNotify("Only administrators can import inventory batches.");
      return;
    }
    const isCsv = file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv";
    if (!isCsv) {
      setImportError("Please select a CSV file.");
      if (importInput.current) importInput.current.value = "";
      return;
    }
    if (file.size > 1024 * 1024) {
      setImportError("The CSV file must be 1 MB or smaller.");
      if (importInput.current) importInput.current.value = "";
      return;
    }
    setImporting(true);
    setImportError("");
    try {
      const csvText = await file.text();
      const preview = await previewInventoryBatchImport(csvText);
      setImportFileName(file.name);
      setImportPreview(preview);
      setImportId(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not read or validate the CSV file.");
    } finally {
      setImporting(false);
      if (importInput.current) importInput.current.value = "";
    }
  }

  function updateImportRow(rowNumber: number, field: string, value: string) {
    setImportPreview((current) => current && ({
      ...current,
      rows: current.rows.map((row) => row.row_number === rowNumber
        ? { ...row, values: { ...row.values, [field]: value } }
        : row),
    }));
  }

  async function revalidateImport() {
    if (!importPreview) return;
    setImporting(true);
    setImportError("");
    const csvText = serializeImportRows(importPreview.rows);
    try {
      const preview = await previewInventoryBatchImport(csvText);
      setImportPreview(preview);
      setCreateMissingProducts(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not validate corrected CSV rows.");
    } finally {
      setImporting(false);
    }
  }

  async function confirmImport() {
    if (!importPreview || !importId || importPreview.invalid_count > 0) return;
    if (importPreview.missing_product_count && !createMissingProducts) {
      setImportError("Confirm creation of missing products before importing.");
      return;
    }
    setImporting(true);
    setImportError("");
    try {
      const csvText = serializeImportRows(importPreview.rows);
      const result = await confirmInventoryBatchImport(csvText, importId, createMissingProducts);
      await refreshBatches();
      setImportHistory(await listInventoryBatchImports());
      setImportOpen(false);
      onNotify(`${result.inserted} batches imported${result.products_created ? `; ${result.products_created} products created` : ""}.`);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Batch import could not be completed.");
    } finally {
      setImporting(false);
    }
  }

  function downloadImportTemplate() {
    const template = [
      BATCH_IMPORT_COLUMNS.join(","),
      ["Example product", "SKU-001", "Fruits", "kg", "10.00", "BATCH-001", "25", "25", "4.50", "2026-01-01", "2026-01-10", "Cold storage", "Example supplier"].map(csvCell).join(","),
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([template], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wastewise-batch-import-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function downloadImportErrors() {
    if (!importPreview) return;
    const columns = ["row_number", ...BATCH_IMPORT_COLUMNS, "errors"];
    const records = importPreview.rows.filter((row) => row.errors.length > 0).map((row) => [
      String(row.row_number),
      ...BATCH_IMPORT_COLUMNS.map((column) => row.values[column] ?? ""),
      row.errors.join("; "),
    ]);
    const content = [columns, ...records].map((record) => record.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wastewise-batch-import-errors.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportBatches() {
    const header = ["Batch ID", "Product", "Category", "Quantity Received", "Quantity Remaining", "Received Date", "Expiry Date", "Expiry Date Basis", "Days Left", "Status", "Location", "Supplier"];
    const rows = filteredBatches.map((batch) => [batch.batchId, batch.product, batch.category, batch.quantityReceived, batch.quantity, batch.receivedDate, batch.expiryDate, expirySourceLabel(batch.expiryDateSource), batch.daysLeft, getBatchStatus(batch), batch.location, batch.supplier]
      .map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","));
    const url = URL.createObjectURL(new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wastewise-batches.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    onNotify("Batch report exported");
  }

  function clearFilters() {
    setQuery("");
    setProductFilter("All Products");
    setStatusFilter("All Status");
    setLocationFilter("All Locations");
    setCategoryFilter("All Categories");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  }

  function toggleAll() {
    const ids = visibleBatches.map((batch) => batch.id);
    setSelected((current) => ids.every((id) => current.includes(id)) ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])]);
  }

  return (
    <div className="batch-page">
      <section className="batch-banner">
        <div className="batch-banner-copy"><span className="batch-eyebrow">INVENTORY MANAGEMENT</span><h1>Batch Management</h1><p>Track product batches, quantities, and expiry dates</p></div>
        <div className="batch-banner-art" aria-hidden="true"><span className="batch-plant plant-left">🌿</span><span className="batch-cartons">📦 📦</span><span className="batch-clipboard">▤</span><span className="batch-plant plant-right">🌿</span></div>
        {(canEdit || canImport) && <div className="batch-banner-actions">
          {canEdit && <button type="button" className="batch-add-button" onClick={openAdd}><Plus size={18} /> Add Batch</button>}
          {canImport && <button type="button" className="batch-add-button" onClick={openImportDialog}><FileUp size={18} /> Import Batches CSV</button>}
          <input ref={importInput} type="file" accept=".csv,text/csv" hidden onChange={(event) => { void handleBatchImport(event.target.files?.[0]); }} />
        </div>}
      </section>

      <section className="batch-stats" aria-label="Batch summary">
        <BatchStat icon={<ClipboardList size={25} />} color="green" title="Total Batches" value={String(batches.length)} change="" note="Actual inventory records" />
        <BatchStat icon={<CalendarDays size={24} />} color="indigo" title="Expiring Soon" value={String(expiringCount)} change="" alert note="Within 7 days" />
        <BatchStat icon={<Package size={25} />} color="green" title="Fresh Batches" value={String(freshCount)} change="" note="Good condition" />
        <BatchStat icon={<AlertTriangle size={25} />} color="orange" title="Expired Batches" value={String(expiredCount)} change="" alert note="Need disposal" />
      </section>

      <section className="batch-main-grid">
        <article className="batch-list-card">
          <div className="batch-toolbar">
            <label className="batch-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search by batch ID, product name, or supplier..." />{query && <button aria-label="Clear batch search" onClick={() => setQuery("")}><X size={13} /></button>}</label>
            <select aria-label="Filter product" value={productFilter} onChange={(event) => { setProductFilter(event.target.value); setPage(1); }}><option>All Products</option>{productOptions.map((product) => <option key={product}>{product}</option>)}</select>
            <select aria-label="Filter batch status" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}><option>All Status</option><option>Fresh</option><option>Expiring Soon</option><option>Expired</option></select>
            <select aria-label="Filter batch location" value={locationFilter} onChange={(event) => { setLocationFilter(event.target.value); setPage(1); }}><option>All Locations</option>{locationOptions.map((location) => <option key={location}>{location}</option>)}</select>
            <div className="batch-date-range"><CalendarDays size={14} /><input aria-label="Date range start" type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setPage(1); }} /><span>–</span><input aria-label="Date range end" type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setPage(1); }} /></div>
            <button className={`batch-export-button batch-filter-button${categoryFilter !== "All Categories" ? " active" : ""}`} type="button" onClick={() => setCategoryFilterOpen(true)}><ListFilter size={14} /> Filter{categoryFilter !== "All Categories" && <span>{categoryFilter}</span>}</button>
            <button className="batch-export-button" onClick={exportBatches}><Download size={14} /> Export</button>
          </div>
          {canDelete && selected.length > 0 && <div className="batch-selection"><span>{selected.length} batches selected</span><button onClick={() => { void removeBatches(selected); }}>Remove selected</button></div>}
          <div className="batch-table-scroll">
            <table className="batch-table">
              <thead><tr><th className="batch-select-cell"><input type="checkbox" aria-label="Select visible batches" checked={visibleBatches.length > 0 && visibleBatches.every((batch) => selected.includes(batch.id))} onChange={toggleAll} /></th><th>#</th><th>Batch ID</th><th></th><th>Product</th><th>Category</th><th>Quantity Received</th><th>Quantity Remaining</th><th>Received Date</th><th>Expiry Date</th><th>Days Left</th><th>Status</th><th>Location</th><th>Supplier</th><th>Action</th></tr></thead>
              <tbody>{visibleBatches.map((batch, index) => {
                const batchStatus = getBatchStatus(batch);
                return <tr key={batch.id}><td className="batch-select-cell"><input type="checkbox" aria-label={`Select ${batch.batchId}`} checked={selected.includes(batch.id)} onChange={() => setSelected((current) => current.includes(batch.id) ? current.filter((id) => id !== batch.id) : [...current, batch.id])} /></td><td>{(page - 1) * pageSize + index + 1}</td><td>{batch.batchId}</td><td className="batch-emoji"><span className="batch-product-icon" aria-hidden="true"><ProductSymbolIcon symbol={batch.emoji} /></span></td><td className="batch-product-name">{batch.product}</td><td>{batch.category}</td><td>{batch.quantityReceived}</td><td>{batch.quantity}</td><td>{formatDate(batch.receivedDate)}</td><td className={batch.daysLeft < 0 ? "batch-expired-date" : batch.daysLeft <= 7 ? "batch-expiry-soon" : "batch-expiry-fresh"}>{formatDate(batch.expiryDate)}<small className="form-field-note">{expirySourceLabel(batch.expiryDateSource)}</small></td><td className={batch.daysLeft < 0 ? "batch-days-urgent" : batch.daysLeft <= 7 ? "batch-days-urgent" : "batch-days-fresh"}>{batch.quantity <= 0 ? "—" : batch.daysLeft < 0 ? "Expired" : batch.daysLeft}</td><td><span className={`batch-status ${batchStatus.toLowerCase().replace(/ /g, "-").replace("/", "-")}`}>{batchStatus}</span></td><td>{batch.location}</td><td>{batch.supplier}</td><td><div className="batch-actions"><button aria-label={`View ${batch.batchId}`} title="View" onClick={() => setViewing(batch)}><Eye size={14} /></button><button aria-label={`Edit ${batch.batchId}`} title="Edit" onClick={() => openEdit(batch)}><Pencil size={14} /></button><button className="batch-delete-action" aria-label={`Delete ${batch.batchId}`} title="Delete" onClick={() => { void removeBatches([batch.id]); }}><Trash2 size={14} /></button></div></td></tr>;
              })}{visibleBatches.length === 0 && <tr><td colSpan={15} className="batch-empty"><Search size={22} /><b>No batches found</b><span>Try another search, status, or date range.</span><button onClick={clearFilters}>Clear filters</button></td></tr>}</tbody>
            </table>
          </div>
          <footer className="batch-list-footer"><span>Showing {filteredBatches.length ? (page - 1) * pageSize + 1 : 0} to {Math.min(page * pageSize, filteredBatches.length)} of {filteredBatches.length} batches <em>· Actual data</em></span><div className="batch-pagination"><button aria-label="Previous batch page" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={15} /></button>{visiblePageNumbers(page, totalPages, 5).map((pageNumber) => <button key={pageNumber} className={pageNumber === page ? "current" : ""} aria-current={pageNumber === page ? "page" : undefined} onClick={() => setPage(pageNumber)}>{pageNumber}</button>)}<button aria-label="Next batch page" disabled={page === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}><ChevronRight size={15} /></button></div></footer>
        </article>

        <section className="batch-bottom-grid">
          <article className="batch-bottom-card batch-distribution-card batch-chart-card" aria-label="Batch Status Distribution chart" title="Double-click or focus and press Enter to expand" tabIndex={0}>
            <div className="batch-bottom-heading"><h2>Batch Status Distribution</h2></div>
            {loadingBatches ? <p className="batch-chart-empty" role="status">Loading batch status…</p> : batches.length === 0
              ? <p className="batch-chart-empty">No batch data available to chart.</p>
              : <div className="batch-distribution-content"><div className="batch-donut" style={{ background: donutGradient }}><div><b>{batches.length}</b><span>Batches</span></div></div><div className="batch-status-legend">{distribution.map((item, index) => <div key={item.name}><i className={["fresh-dot", "expiring-dot", "expired-dot", "consumed-dot"][index]} /><span>{item.name}{item.name === "Expiring Soon" ? " (≤ 7 days)" : ""}</span><b>{item.count} ({Math.round(item.count / distributionTotal * 100)}%)</b></div>)}</div></div>}
          </article>
          <article className="batch-bottom-card batch-upcoming-card">
            <div className="batch-bottom-heading"><h2>Upcoming Expiries (Next 7 Days)</h2><button onClick={() => { setStatusFilter("Expiring Soon"); setPage(1); }}>View All</button></div>
            <div className="batch-bottom-table-scroll"><table><thead><tr><th>Product</th><th>Batch ID</th><th>Expiry Date</th><th>Days Left</th><th>Qty. Remaining</th><th>Action</th></tr></thead><tbody>{upcoming.map((batch) => <tr key={batch.id}><td><span className="batch-mini-product"><i aria-hidden="true"><ProductSymbolIcon symbol={batch.emoji} /></i>{batch.product}</span></td><td>{batch.batchId}</td><td className="batch-expiry-soon">{formatDate(batch.expiryDate)}</td><td className="batch-days-urgent">{batch.daysLeft}</td><td>{batch.quantity}</td><td><button className="batch-view-button" onClick={() => setViewing(batch)}>View</button></td></tr>)}</tbody></table></div>
          </article>
          <article className="batch-bottom-card batch-location-card">
            <div className="batch-bottom-heading"><h2>Batch Locations</h2><button onClick={() => setLocationFilter("All Locations")}>View All</button></div>
            <div className="batch-location-table"><div className="batch-location-head"><b>Location</b><b>Batches</b><b>Qty. Left</b><b>Products</b></div>{locationStats.map((item) => <div className="batch-location-row" key={item.name}><span>{item.name}</span><span>{item.batches}</span><span>{item.quantity}</span><span className="batch-location-products" aria-label={`Products at ${item.name}: ${item.products.map((product) => product.name).join(", ")}`}>{item.products.map((product) => <span key={product.name} title={product.name} aria-hidden="true"><ProductSymbolIcon symbol={product.emoji} /></span>)}</span></div>)}</div>
          </article>
        </section>
      </section>

      {modalOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModalOpen(false); }}>
        <form className="product-modal batch-modal" onSubmit={saveBatch}>
          <div className="modal-heading"><div><span className="modal-icon"><ClipboardList size={20} /></span><div><h2>{editing ? "Edit Batch" : "Add Batch"}</h2><p>Enter batch quantities and expiry details.</p></div></div><button type="button" aria-label="Close" onClick={() => setModalOpen(false)}><X size={20} /></button></div>
          <label>Product name<div className="batch-product-select"><span className="batch-form-product-icon" aria-hidden="true"><ProductSymbolIcon symbol={productSymbol(selectedProduct?.name ?? form.product, selectedProduct?.category ?? form.category)} /></span><input aria-label="Product name" required list="batch-product-options" value={form.product} onChange={(event) => {
            const product = findExistingProduct(products, event.target.value);
            setExpiryDateManuallyEdited(false);
            setForm((current) => ({
              ...current,
              product: event.target.value,
              category: product?.category ?? current.category,
              expiryDate: "",
              expiryDateSource: "estimated",
              supplier: product?.supplier ?? current.supplier,
            }));
          }} placeholder="Product name" /></div><datalist id="batch-product-options">{products.map((product) => <option key={product.product_id} value={product.name} />)}</datalist>{selectedProduct && <small className="form-field-note batch-product-saved-details">Saved product details · SKU {selectedProduct.sku} · {selectedProduct.category} · {selectedProduct.unit}</small>}</label>
          <div className="form-row">
            <label>Category<select value={form.category} onChange={(event) => {
              const nextCategory = event.target.value;
              setExpiryDateManuallyEdited(false);
              setForm((current) => ({ ...current, category: nextCategory, expiryDate: "", expiryDateSource: "estimated" }));
            }}>{categoryOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>Quantity<input required min="0.001" step="0.001" type="number" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} placeholder="0" /></label>
          </div>
          <div className="form-row">
            <label>Received date<input required type="date" value={form.receivedDate} onChange={(event) => {
              setForm((current) => ({
                ...current,
                receivedDate: event.target.value,
                expiryDateSource: expiryDateManuallyEdited ? current.expiryDateSource : "estimated",
              }));
            }} /></label>
            <label>Expiry date<input aria-label="Batch expiry date" required type="date" min={form.receivedDate} value={form.expiryDate} onChange={(event) => {
              setExpiryDateManuallyEdited(true);
              setForm((current) => ({ ...current, expiryDate: event.target.value, expiryDateSource: "manual_verified" }));
            }} />
              <small className="form-field-note">{expirySuggestionDays !== null
                ? `Estimated suggestion: ${expirySuggestionDays} days after receipt. Verify against the manufacturer or batch label.`
                : "No default is configured or a product is not selected. Enter the actual batch expiry date."}</small>
            </label>
          </div>
          <label>Expiry date basis<select value={form.expiryDateSource} onChange={(event) => {
            const source = event.target.value as NonNullable<InventoryBatchRecord["expiry_date_source"]> | "";
            setExpiryDateManuallyEdited(source !== "estimated");
            setForm((current) => ({ ...current, expiryDateSource: source }));
          }}>
            <option value="estimated">Category-based estimate</option>
            <option value="manufacturer_verified">Manufacturer verified</option>
            <option value="manual_verified">Manually verified</option>
            {editing && form.expiryDateSource === "" && <option value="">Unverified / legacy</option>}
          </select></label>
          <label>Location<input required list="batch-location-options" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} placeholder="Storage location" /><datalist id="batch-location-options">{locationOptions.map((item) => <option key={item} value={item} />)}</datalist></label>
          <label>Supplier<input required value={form.supplier} onChange={(event) => setForm({ ...form, supplier: event.target.value })} placeholder="Supplier name" /></label>
          {editing && imageProduct && <div className="batch-image-field">
            <span className="batch-image-label">Product image</span>
            <small className="form-field-note">Any image dimensions or shape are accepted. Large images are optimized and fitted in Sales / POS; other pages keep their symbols.</small>
            <div className="batch-image-actions">
              <label className="batch-image-upload-button">
                <Upload size={15} /> {savingProductImage ? "Uploading…" : imageProduct.image_url ? "Replace image" : "Upload image"}
                <input
                  ref={productImageInput}
                  type="file"
                  accept="image/*"
                  aria-label="Upload product image"
                  disabled={savingProductImage}
                  onChange={(event) => { void handleProductImageUpload(event.target.files?.[0]); }}
                />
              </label>
              {imageProduct.image_url && <button type="button" className="batch-image-remove-button" disabled={savingProductImage} onClick={() => { void handleProductImageRemove(); }}>
                <Trash2 size={14} /> Remove image
              </button>}
              {imageProduct.image_url && <span className="batch-image-saved-status">Image saved</span>}
            </div>
          </div>}
          <div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setModalOpen(false)}>Cancel</button><button className="save-button" type="submit" disabled={saving || savingProductImage}><Check size={16} /> {saving ? "Saving…" : "Save Batch"}</button></div>
        </form>
      </div>}
      {importOpen && <div className="modal-backdrop batch-import-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !importing) setImportOpen(false); }}>
        <section className="batch-import-modal" role="dialog" aria-modal="true" aria-labelledby="batch-import-title">
          <div className="modal-heading">
            <div><span className="modal-icon"><FileUp size={20} /></span><div><h2 id="batch-import-title">Import Batches CSV</h2><p>Preview and validate inventory before committing any changes.</p></div></div>
            <button type="button" aria-label="Close batch import" disabled={importing} onClick={() => setImportOpen(false)}><X size={20} /></button>
          </div>
          <div className={`batch-import-dropzone${draggingImport ? " is-dragging" : ""}`}
            role="button"
            tabIndex={0}
            aria-label="Drop a CSV file here or browse files"
            onClick={() => { if (!importing) importInput.current?.click(); }}
            onKeyDown={(event) => { if (!importing && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); importInput.current?.click(); } }}
            onDragEnter={(event) => { event.preventDefault(); importDragDepth.current += 1; setDraggingImport(true); }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = importing ? "none" : "copy"; }}
            onDragLeave={(event) => { event.preventDefault(); importDragDepth.current = Math.max(0, importDragDepth.current - 1); if (importDragDepth.current === 0) setDraggingImport(false); }}
            onDrop={(event) => {
              event.preventDefault();
              importDragDepth.current = 0;
              setDraggingImport(false);
              if (!importing) void handleBatchImport(event.dataTransfer.files.item(0) ?? undefined);
            }}>
            <FileUp size={25} />
            <b>Drop a CSV file here or <button type="button" className="batch-import-link" onClick={(event) => { event.stopPropagation(); importInput.current?.click(); }}>browse files</button></b>
            <span>CSV only · up to 5,000 rows and 1 MB</span>
            {importFileName && <small>Selected: {importFileName}</small>}
          </div>
          <div className="batch-import-tools">
            <button type="button" className="batch-export-button" onClick={downloadImportTemplate}><Download size={14} /> Download template</button>
            {importPreview && <button type="button" className="batch-export-button" disabled={importing} onClick={() => { void revalidateImport(); }}>Validate corrections</button>}
            {importPreview && importPreview.invalid_count > 0 && <button type="button" className="batch-export-button" onClick={downloadImportErrors}><Download size={14} /> Download error report</button>}
          </div>
          {importing && <p className="batch-import-progress" role="status">Reading and validating CSV…</p>}
          {importError && <p className="batch-import-error" role="alert">{importError}</p>}
          {importPreview && <>
            <div className="batch-import-summary" aria-label="CSV validation summary">
              <span><b>{importPreview.row_count}</b> rows</span><span className="valid"><b>{importPreview.valid_count}</b> valid</span>
              <span className={importPreview.invalid_count ? "invalid" : "valid"}><b>{importPreview.invalid_count}</b> invalid</span>
              <span><b>{importPreview.missing_product_count}</b> missing products</span>
            </div>
            <div className="batch-import-table-scroll">
              <table className="batch-import-table">
                <thead><tr><th>Row</th><th>Product name</th><th>SKU</th><th>Category</th><th>Unit</th><th>Price</th><th>Batch no.</th><th>Quantity</th><th>Remaining</th><th>Unit cost</th><th>Received</th><th>Expiry</th><th>Location</th><th>Supplier</th><th>Match / validation</th></tr></thead>
                <tbody>{importPreview.rows.map((row) => <tr key={row.row_number} className={row.errors.length ? "has-errors" : "is-valid"}>
                  <td>{row.row_number}</td>
                  {BATCH_IMPORT_COLUMNS.map((field) => <td key={field}>
                    <input aria-label={`Row ${row.row_number} ${field.replace(/_/g, " ")}`} type={field === "received_at" || field === "expiry_date" ? "date" : "text"}
                      value={row.values[field] ?? ""} onChange={(event) => updateImportRow(row.row_number, field, event.target.value)} />
                  </td>)}
                  <td><span className={`batch-import-match ${row.errors.length ? "invalid" : "valid"}`}>
                    {row.errors.length ? "Invalid row · " : "Valid row · "}
                    {row.matched_product
                      ? `${row.matched_product.name} (${row.matched_product.sku}) matched ${row.product_status.replace("matched_by_", "by ")}`
                      : row.product_status === "missing" ? "Product will be created after confirmation" : row.product_status}
                  </span>
                    {row.errors.length > 0 && <ul>{row.errors.map((error) => <li key={error}>{error}</li>)}</ul>}</td>
                </tr>)}</tbody>
              </table>
            </div>
            {importPreview.missing_product_count > 0 && <label className="batch-import-confirm-products">
              <input type="checkbox" checked={createMissingProducts} onChange={(event) => setCreateMissingProducts(event.target.checked)} />
              I confirm creation of the {importPreview.missing_product_count} missing product(s) using the CSV product details.
            </label>}
          </>}
          {importHistory.length > 0 && <details className="batch-import-history"><summary>Recent import history</summary>
            <ul>{importHistory.slice(0, 5).map((record) => <li key={record.import_id}>
              <span>{formatAppDateTime(record.created_at)}</span>
              <b>{record.inserted} batches</b><span>{record.products_created} products created</span>
            </li>)}</ul>
          </details>}
          <div className="modal-actions">
            <button type="button" className="cancel-button" disabled={importing} onClick={() => setImportOpen(false)}>Cancel</button>
            {importPreview && <button type="button" className="save-button" disabled={importing || importPreview.valid_count === 0 || importPreview.invalid_count > 0 || (importPreview.missing_product_count > 0 && !createMissingProducts)} onClick={() => { void confirmImport(); }}>
              <Check size={16} /> {importing ? "Importing…" : `Import ${importPreview.valid_count} valid batches`}
            </button>}
          </div>
        </section>
      </div>}
      {categoryFilterOpen && <div className="modal-backdrop batch-category-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCategoryFilterOpen(false); }}>
        <section className="batch-category-modal" role="dialog" aria-modal="true" aria-labelledby="batch-category-filter-title">
          <div className="modal-heading">
            <div><span className="modal-icon"><ListFilter size={20} /></span><div><h2 id="batch-category-filter-title">Filter Batches by Category</h2><p>Select a category to filter the batch list.</p></div></div>
            <button type="button" aria-label="Close category filter" onClick={() => setCategoryFilterOpen(false)}><X size={20} /></button>
          </div>
          <div className="batch-category-options">
            {["All Categories", ...categoryOptions].map((category) => {
              const count = category === "All Categories" ? batches.length : batches.filter((batch) => batch.category === category).length;
              return <label key={category} className={categoryFilter === category ? "selected" : ""}><input type="radio" name="batch-category-filter" checked={categoryFilter === category} onChange={() => setCategoryFilter(category)} /><span>{category}</span><small>{count}</small></label>;
            })}
          </div>
          <div className="modal-actions">
            <button type="button" className="cancel-button" onClick={() => { setCategoryFilter("All Categories"); setPage(1); }}>Reset</button>
            <button type="button" className="save-button" onClick={() => { setPage(1); setCategoryFilterOpen(false); }}><Check size={16} /> Apply Filter</button>
          </div>
        </section>
      </div>}
      {viewing && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewing(null); }}><section className="batch-detail-modal"><div className="modal-heading"><div><span className="modal-icon"><Leaf size={20} /></span><div><h2>Batch Details</h2><p>{viewing.batchId}</p></div></div><button aria-label="Close batch details" onClick={() => setViewing(null)}><X size={20} /></button></div><div className="batch-detail-product"><span aria-hidden="true"><ProductSymbolIcon symbol={viewing.emoji} /></span><div><b>{viewing.product}</b><small>{viewing.category} · {viewing.supplier}</small></div><span className={`batch-status ${getBatchStatus(viewing).toLowerCase().replace(/ /g, "-").replace("/", "-")}`}>{getBatchStatus(viewing)}</span></div><div className="batch-detail-grid"><span>Quantity received<b>{viewing.quantityReceived} units</b></span><span>Quantity remaining<b>{viewing.quantity} units</b></span><span>Received date<b>{formatDate(viewing.receivedDate)}</b></span><span>Expiry date<b>{formatDate(viewing.expiryDate)} · {expirySourceLabel(viewing.expiryDateSource)}</b></span><span>Days left<b>{viewing.daysLeft}</b></span><span>Storage location<b>{viewing.location}</b></span></div><button className="save-button batch-detail-close" onClick={() => setViewing(null)}>Close</button></section></div>}
    </div>
  );
}

function BatchStat({ icon, color, title, value, change, alert = false, note }: { icon: ReactNode; color: string; title: string; value: string; change: string; alert?: boolean; note: string }) {
  return <article className="batch-stat-card"><span className={`batch-stat-icon ${color}`}>{icon}</span><div className="batch-stat-copy"><span>{title}</span><div><b>{value}</b><i className={alert ? "alert" : ""}>{change}</i></div><small>{note}</small></div></article>;
}