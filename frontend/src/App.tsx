import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  AlertTriangle,
  Bell,
  Box,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  Gauge,
  History,
  LayoutDashboard,
  Layers3,
  Leaf,
  LogOut,
  Menu,
  Moon,
  PackageCheck,
  Pencil,
  Plus,
  Recycle,
  Search,
  Settings,
  ShoppingCart,
  Sparkles,
  Tag,
  Trash2,
  TrendingUp,
  Users,
  UserRound,
  Sun,
  X,
} from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Inventory from "./pages/Inventory";
import BatchManagement from "./pages/BatchManagement";
import ExpiryAlerts from "./pages/ExpiryAlerts";
import SalesHistory from "./pages/SalesHistory";
import SalesPos from "./pages/SalesPos";
import DemandForecast from "./pages/DemandForecast";
import WasteReports from "./pages/WasteReports";
import UsersRoles from "./pages/UsersRoles";
import SettingsPage from "./pages/Settings";
import AuthPage from "./pages/AuthPage";
import LandingPage from "./pages/LandingPage";
import { canViewAuditLogs } from "./services/auditLogs";
import { canViewSystemHealth } from "./services/systemHealth";
import type { OperationsSection } from "./pages/OperationsConsole";
import Profile from "./pages/Profile";

const Recommendations = lazy(() => import("./pages/Recommendations"));
const ModelMetrics = lazy(() => import("./pages/ModelMetrics"));
const OperationsConsole = lazy(() => import("./pages/OperationsConsole"));
const NotificationBell = lazy(() => import("./components/NotificationBell"));
import ExpandedContentOverlay from "./components/ExpandedContentOverlay";
import ProductSymbol from "./components/ProductSymbol";
import ProductSuggestionAction from "./components/ProductSuggestionAction";
import { PRODUCT_CATEGORIES, PRODUCT_UNITS } from "./services/productSuggestions";
import { productSymbol } from "./services/productSymbols";
import { visiblePageNumbers } from "./services/pagination";
import { calculateSuggestedExpiryDate, configureShelfLifeDays, localDateIso } from "./services/expiryDates";
import { clearAccessToken, getAccessTokenExpiresAt, getCurrentUser, signOut as revokeSession } from "./services/auth";
import type { AuthenticatedUser } from "./services/auth";
import {
  createBatch,
  createProduct,
  getGeneralSettings,
  deleteProduct as deleteProductRequest,
  listInventorySummary,
  listProducts,
  listShelfLifeSettings,
  updateProduct,
} from "./services/business";
import type { ExpiryDateSource, ProductInput } from "./services/business";
import {
  configureGeneralSettings,
  DEFAULT_GENERAL_SETTINGS,
  formatAppDate,
  useGeneralSettings,
} from "./services/generalSettings";
import {
  applyAppearancePreferences,
  applyThemePreference,
  getResolvedTheme,
  getThemePreference,
  setThemePreference,
  themeChangeEventName,
} from "./services/appearance";
import type { ThemePreference } from "./services/appearance";

type Product = {
  id: number;
  emoji: string;
  name: string;
  category: string;
  sku: string;
  unit: string;
  price: number;
  stock: number;
  supplier: string;
  updated: string;
  updatedAt: number;
};

type ProductForm = {
  name: string;
  category: string;
  sku: string;
  unit: string;
  price: string;
  stock: string;
  supplier: string;
  receivedDate: string;
  expiryDate: string;
  expiryDateSource: ExpiryDateSource | "";
};

function productEmoji(name: string, category: string): string {
  return productSymbol(name, category);
}

const links = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Products", icon: Box },
  { label: "Inventory", icon: Boxes },
  { label: "Batch Management", icon: PackageCheck },
  { label: "Expiry Alerts", icon: AlertTriangle },
  { label: "Sales / POS", icon: ShoppingCart },
  { label: "Sales History", icon: History },
  { label: "Demand Forecast", icon: TrendingUp },
  { label: "Recommendations", icon: Sparkles },
  { label: "Waste Reports", icon: Recycle },
  { label: "Model Metrics", icon: Gauge },
  { label: "Users & Roles", icon: Users },
  { label: "Operations Console", icon: Layers3 },
  { label: "Settings", icon: Settings },
];
function App() {
  const generalSettings = useGeneralSettings();
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(getThemePreference);
  const [activePage, setActivePage] = useState("Dashboard");
  const [operationsSection, setOperationsSection] = useState<OperationsSection>("audit");
  const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null);
  const [restoringSession, setRestoringSession] = useState(() => getAccessTokenExpiresAt() !== null);
  const [routePath, setRoutePath] = useState(window.location.pathname);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [globalSearch, setGlobalSearch] = useState("");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [category, setCategory] = useState("All Categories");
  const [status, setStatus] = useState("All Status");
  const [supplier, setSupplier] = useState("All Suppliers");
  const [sortBy, setSortBy] = useState<"name" | "category" | "stock" | "price" | "updated">("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [modalProduct, setModalProduct] = useState<Product | null>(null);
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [skuSuggestionRefreshToken, setSkuSuggestionRefreshToken] = useState(0);
  const [toast, setToast] = useState("");
  const [form, setForm] = useState<ProductForm>(() => {
    const receivedDate = localDateIso();
    return {
      name: "",
      category: "Fruits",
      sku: "",
      unit: "Kilogram (kg)",
      price: "",
      stock: "",
      supplier: "",
      receivedDate,
      expiryDate: calculateSuggestedExpiryDate("Fruits", receivedDate) ?? "",
      expiryDateSource: "estimated",
    };
  });
  useEffect(() => {
    applyThemePreference(themePreference);
    applyAppearancePreferences();
    const handleThemeChange = (event: Event) => {
      setThemePreferenceState((event as CustomEvent<ThemePreference>).detail);
    };
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      if (themePreference === "system") applyThemePreference("system");
    };
    window.addEventListener(themeChangeEventName(), handleThemeChange);
    systemTheme.addEventListener("change", handleSystemThemeChange);
    return () => {
      window.removeEventListener(themeChangeEventName(), handleThemeChange);
      systemTheme.removeEventListener("change", handleSystemThemeChange);
    };
  }, [themePreference]);
  const [expiryDateManuallyEdited, setExpiryDateManuallyEdited] = useState(false);
  const categoryOptions = [...new Set([...PRODUCT_CATEGORIES, ...(modalProduct ? [modalProduct.category] : [])])];
  const unitOptions = [...new Set([...PRODUCT_UNITS, ...(modalProduct ? [modalProduct.unit] : [])])];

  const filtered = useMemo(
    () =>
      products.filter((product) => {
        const query = search.trim().toLowerCase();
        const matchesSearch =
          !query ||
          [product.name, product.category, product.sku, product.supplier].some((value) =>
            value.toLowerCase().includes(query),
          );
        const matchesCategory = category === "All Categories" || product.category === category;
        const matchesStatus =
          status === "All Status" ||
          (status === "Active"
            ? product.stock >= 20
            : product.stock < 20);
        const matchesSupplier = supplier === "All Suppliers" || product.supplier === supplier;
        return matchesSearch && matchesCategory && matchesStatus && matchesSupplier;
      }),
    [products, search, category, status, supplier],
  );
  const sortedProducts = [...filtered].sort((first, second) => {
    const firstValue = sortBy === "updated" ? first.updatedAt : first[sortBy];
    const secondValue = sortBy === "updated" ? second.updatedAt : second[sortBy];
    const comparison = typeof firstValue === "number" && typeof secondValue === "number"
      ? firstValue - secondValue
      : String(firstValue).localeCompare(String(secondValue), undefined, { numeric: true, sensitivity: "base" });
    return sortDirection === "asc" ? comparison : -comparison;
  });
  const pageSize = generalSettings.items_per_page;
  const totalPages = Math.max(1, Math.ceil(sortedProducts.length / pageSize));
  const visibleProductPages = visiblePageNumbers(page, totalPages, 4);
  const visibleProducts = sortedProducts.slice((page - 1) * pageSize, page * pageSize);
  const lowStock = products.filter((product) => product.stock < 20).length;
  const activeProducts = products.filter((product) => product.stock > 0).length;
  const categories = [...new Set(products.map((product) => product.category))];
  const categoryCount = categories.length;
  const suppliers = [...new Set(products.map((product) => product.supplier))];
  const canManageProducts = currentUser !== null && ["admin", "store_manager"].includes(currentUser.role);
  const canDeleteProducts = currentUser !== null && ["admin", "store_manager"].includes(currentUser.role);

  useEffect(() => { setPage(1); }, [pageSize]);

  async function refreshProducts() {
    const [records, inventory] = await Promise.all([listProducts(), listInventorySummary()]);
    const stockByProduct = new Map(inventory.map((item) => [item.product_id, item.quantity]));
    setProducts(records.map((record) => ({
      id: record.product_id,
      emoji: productEmoji(record.name, record.category),
      name: record.name,
      category: record.category,
      sku: record.sku,
      unit: record.unit,
      price: Number(record.price),
      stock: stockByProduct.get(record.product_id) ?? 0,
      supplier: record.supplier,
      updated: formatAppDate(record.updated_at),
      updatedAt: new Date(record.updated_at).getTime(),
    })));
  }

  useEffect(() => {
    if (!restoringSession) return;
    let active = true;
    getCurrentUser()
      .then((user) => { if (active) setCurrentUser(user); })
      .catch(() => { if (active) clearAccessToken(); })
      .finally(() => { if (active) setRestoringSession(false); });
    return () => { active = false; };
  }, [restoringSession]);

  useEffect(() => {
    function handleExpiredSession(event: Event) {
      setCurrentUser(null);
      setActivePage("Dashboard");
      window.history.replaceState(null, "", "/signin");
      setRoutePath("/signin");
      const message = event instanceof CustomEvent && typeof event.detail?.message === "string"
        ? event.detail.message
        : "Your session expired. Please sign in again.";
      notify(message);
    }
    window.addEventListener("wastewise:session-expired", handleExpiredSession);
    return () => window.removeEventListener("wastewise:session-expired", handleExpiredSession);
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    let active = true;
    Promise.all([listProducts(), listInventorySummary()])
      .then(([records, inventory]) => {
        if (!active) return;
        const stockByProduct = new Map(inventory.map((item) => [item.product_id, item.quantity]));
        setProducts(records.map((record) => ({
          id: record.product_id,
          emoji: productEmoji(record.name, record.category),
          name: record.name,
          category: record.category,
          sku: record.sku,
          unit: record.unit,
          price: Number(record.price),
          stock: stockByProduct.get(record.product_id) ?? 0,
          supplier: record.supplier,
          updated: formatAppDate(record.updated_at),
          updatedAt: new Date(record.updated_at).getTime(),
        })));
      })
      .catch((error: unknown) => {
        if (active) notify(error instanceof Error ? error.message : "Could not load products from the API.");
      });
    return () => { active = false; };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    let active = true;
    listShelfLifeSettings()
      .then((settings) => {
        if (!active) return;
        configureShelfLifeDays(settings);
        setForm((current) => current.expiryDateSource === "estimated"
          ? { ...current, expiryDate: calculateSuggestedExpiryDate(current.category, current.receivedDate) ?? "" }
          : current);
      })
      .catch((error: unknown) => {
        if (active) setToast(error instanceof Error ? error.message : "Could not load category shelf-life defaults.");
      });
    return () => { active = false; };
  }, [currentUser]);

  useEffect(() => {
    function syncRoute() {
      const pathname = window.location.pathname;
      setRoutePath(pathname);
      if (pathname === "/app/sales-pos") setActivePage("Sales / POS");
    }
    if (window.location.pathname === "/app/sales-pos") setActivePage("Sales / POS");

    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    document.title = currentUser
      ? `${activePage} | WasteWise AI`
      : routePath === "/signin"
        ? "Sign In | WasteWise AI"
        : routePath === "/signup"
          ? "Create Account | WasteWise AI"
          : "WasteWise AI | Smart Inventory, Less Waste";
  }, [activePage, currentUser, routePath]);

  useEffect(() => {
    if (!restoringSession && !currentUser && routePath !== "/" && routePath !== "/signin" && routePath !== "/signup") {
      window.history.replaceState(null, "", "/signin");
      setRoutePath("/signin");
    }
  }, [currentUser, restoringSession, routePath]);

  useEffect(() => {
    if (!currentUser) return;
    const expiresAt = getAccessTokenExpiresAt();
    if (expiresAt === null) return;

    const timeout = window.setTimeout(() => {
      endLocalSession();
      notify("Your session expired. Please sign in again.");
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [currentUser]);

  function navigateAuth(path: "/signin" | "/signup") {
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
    setRoutePath(path);
  }

  function handleAuthenticated(user: AuthenticatedUser) {
    setCurrentUser(user);
    window.history.replaceState(null, "", "/app");
    setRoutePath("/app");
  }

  function endLocalSession() {
    clearAccessToken();
    setCurrentUser(null);
    window.history.replaceState(null, "", "/signin");
    setRoutePath("/signin");
  }

  async function handleSignOut() {
    let logoutFailed = false;
    try {
      await revokeSession();
    } catch (error) {
      console.error("Could not revoke the WasteWise session on the server.", error);
      logoutFailed = true;
    } finally {
      endLocalSession();
    }
    if (logoutFailed) {
      notify("Signed out on this device. The server could not confirm sign-out; the token expires within 60 minutes.");
    }
  }

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  useEffect(() => {
    if (!currentUser) {
      configureGeneralSettings(DEFAULT_GENERAL_SETTINGS);
      return;
    }
    let active = true;
    configureGeneralSettings(DEFAULT_GENERAL_SETTINGS);
    getGeneralSettings()
      .then((settings) => { if (active) configureGeneralSettings(settings); })
      .catch((error: unknown) => {
        if (active) notify(error instanceof Error ? error.message : "Could not load general settings.");
      });
    return () => { active = false; };
  }, [currentUser?.user_id, notify]);

  function openAdd() {
    setModalProduct(null);
    setSkuSuggestionRefreshToken(0);
    const receivedDate = localDateIso();
    setForm({
      name: "",
      category: "Fruits",
      sku: "",
      unit: "Kilogram (kg)",
      price: "",
      stock: "0",
      supplier: "",
      receivedDate,
      expiryDate: calculateSuggestedExpiryDate("Fruits", receivedDate) ?? "",
      expiryDateSource: "estimated",
    });
    setExpiryDateManuallyEdited(false);
    setIsModalOpen(true);
  }

  function openEdit(product: Product) {
    setSkuSuggestionRefreshToken(0);
    setExpiryDateManuallyEdited(false);
    setModalProduct(product);
    setIsModalOpen(true);
    setForm({
      name: product.name,
      category: product.category,
      sku: product.sku,
      unit: product.unit,
      price: String(product.price),
      stock: String(product.stock),
      supplier: product.supplier,
      receivedDate: localDateIso(),
      expiryDate: "",
      expiryDateSource: "",
    });
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name.trim() || !form.sku.trim() || !form.supplier.trim()) {
      notify("Complete all required product details.");
      return;
    }
    if (!Number.isFinite(Number(form.price)) || Number(form.price) < 0) {
      notify("Enter a valid product price.");
      return;
    }
    if (!Number.isFinite(Number(form.stock)) || Number(form.stock) < 0) {
      notify("Enter a valid product stock quantity.");
      return;
    }
    if (Number(form.stock) > 0 && !form.expiryDate) {
      notify("No category shelf-life default is available. Verify and enter the actual batch expiry date.");
      return;
    }
    if (Number(form.stock) > 0 && form.expiryDate < form.receivedDate) {
      notify("Expiry date cannot be before received date.");
      return;
    }
    if (!categoryOptions.includes(form.category)) {
      notify("Select a category from the approved category list.");
      return;
    }
    if (!unitOptions.includes(form.unit)) {
      notify("Select a unit from the approved unit list.");
      return;
    }
    const payload: ProductInput = {
      name: form.name.trim(),
      category: form.category,
      sku: form.sku.trim(),
      unit: form.unit,
      price: Number(form.price),
      supplier: form.supplier.trim(),
    };
    try {
      if (modalProduct) {
        await updateProduct(modalProduct.id, payload);
      } else {
        const createdProduct = await createProduct(payload);
        const initialStock = Number(form.stock);
        if (initialStock > 0) {
          await createBatch({
            product_id: createdProduct.product_id,
            batch_code: `${payload.sku}-INITIAL-${Date.now().toString().slice(-6)}`,
            quantity_received: initialStock,
            quantity_remaining: initialStock,
            unit_cost: Number(payload.price),
            received_at: form.receivedDate,
            expiry_date: form.expiryDate,
            expiry_date_source: form.expiryDateSource || null,
            location: "Main Store",
            supplier: payload.supplier,
          });
        }
      }
      await refreshProducts();
      setIsModalOpen(false);
      setModalProduct(null);
      setPage(1);
      notify(modalProduct ? "Product updated" : "Product added");
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes("sku")) {
        if (!modalProduct) setSkuSuggestionRefreshToken((token) => token + 1);
        notify(modalProduct
          ? `${error.message} Your SKU was not changed; use Generate a different SKU to choose another.`
          : `${error.message} Your SKU was not changed; review the refreshed suggestion before retrying.`);
        return;
      }
      notify(error instanceof Error ? error.message : "Could not save product.");
    }
  }

  function exportProducts() {
    const header = ["Product Name", "Category", "SKU", "Unit", "Price", "Stock", "Supplier"];
    const rows = filtered.map((product) =>
      [product.name, product.category, product.sku, product.unit, product.price, product.stock, product.supplier]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wastewise-products.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    notify("Product list exported");
  }

  async function duplicateProduct(product: Product) {
    try {
      await createProduct({
        name: `${product.name} Copy`,
        category: product.category,
        sku: `${product.sku}-COPY`,
        unit: product.unit,
        price: product.price,
        supplier: product.supplier,
      });
      await refreshProducts();
      setPage(1);
      notify("Product duplicated");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not duplicate product.");
    }
  }

  async function deleteProduct(product: Product) {
    try {
      await deleteProductRequest(product.id);
      await refreshProducts();
      setSelected((current) => current.filter((id) => id !== product.id));
      notify(`${product.name} deleted`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not delete product.");
    }
  }

  function toggleAll() {
    const ids = visibleProducts.map((product) => product.id);
    setSelected((current) =>
      ids.every((id) => current.includes(id))
        ? current.filter((id) => !ids.includes(id))
        : [...new Set([...current, ...ids])],
    );
  }

  function navigateFromGlobalSearch() {
    const query = globalSearch.trim().toLowerCase();
    if (!query) return;
    const matchingProduct = products.find((item) => item.name.toLowerCase().includes(query));
    if (matchingProduct) setActivePage("Products");
    else if (/batch/.test(query)) setActivePage("Batch Management");
    else if (/expiry|expir/.test(query)) setActivePage("Expiry Alerts");
    else if (/waste|report/.test(query)) setActivePage("Waste Reports");
    else if (/sale|transaction/.test(query)) setActivePage("Sales History");
    else if (/forecast|demand/.test(query)) setActivePage("Demand Forecast");
    else if (/recommend/.test(query)) setActivePage("Recommendations");
    else if (/audit|notification|system health|operations/.test(query)) {
      setOperationsSection(/notification/.test(query) ? "notifications" : /health|system/.test(query) ? "health" : "audit");
      setActivePage("Operations Console");
    } else if (/inventory|stock/.test(query)) setActivePage("Inventory");
    else setActivePage("Products");
    setGlobalSearch("");
  }

  const productSearchMatches = globalSearch.trim()
    ? products.filter((item) => item.name.toLowerCase().includes(globalSearch.trim().toLowerCase())).slice(0, 5)
    : [];

  const searchDestinations = globalSearch.trim() ? [
    { label: "Batch Management", keywords: "batch batches inventory" },
    { label: "Expiry Alerts", keywords: "expiry expired expiration expiring" },
    { label: "Sales History", keywords: "sales sale transaction" },
    { label: "Demand Forecast", keywords: "demand forecast prediction" },
    { label: "Recommendations", keywords: "recommendations recommendation" },
    { label: "Waste Reports", keywords: "waste report reports" },
    { label: "Operations Console", keywords: "operations audit logs notifications system health monitoring status" },
  ].filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(globalSearch.trim().toLowerCase())).slice(0, 5) : [];

  if (restoringSession) {
    return <div className="auth-loading">Loading WasteWise AI…</div>;
  }

  if (!currentUser) {
    if (routePath === "/signin" || routePath === "/signup") {
      return <AuthPage onAuthenticated={handleAuthenticated} />;
    }
    return <LandingPage onNavigate={navigateAuth} />;
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <button
            className="sidebar-toggle"
            type="button"
            aria-label={sidebarCollapsed ? "Open sidebar" : "Close sidebar"}
            aria-controls="app-sidebar"
            aria-expanded={!sidebarCollapsed}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarCollapsed((collapsed) => !collapsed);
            }}
          >
            <Menu size={21} />
          </button>
          <a className="brand-home" href="#" aria-label={`${generalSettings.application_name} home`}>
            <span className="brand-leaf"><Leaf size={34} strokeWidth={1.8} /></span>
            <span className="brand-copy"><strong>{generalSettings.application_name}</strong><small>Smart Inventory&nbsp; • &nbsp;Less Waste&nbsp; • &nbsp;A Greener Tomorrow</small></span>
          </a>
        </div>
        <div className="global-search-wrap">
          <label className="global-search">
            <Search size={19} />
            <input value={globalSearch} onKeyDown={(event) => { if (event.key === "Enter") navigateFromGlobalSearch(); }} onChange={(event) => setGlobalSearch(event.target.value)} placeholder={activePage === "Users & Roles" ? "Search users, roles, or permissions..." : activePage === "Settings" ? "Search products, batches, users, or settings..." : "Search products, batches, or reports..."} />
            {globalSearch && <button type="button" onClick={() => setGlobalSearch("")} aria-label="Clear global search"><X size={15} /></button>}
          </label>
          {(productSearchMatches.length > 0 || searchDestinations.length > 0) && <div className="global-search-results" role="listbox">
            {productSearchMatches.map((product) => <button type="button" key={product.id} onClick={() => { setActivePage("Products"); setGlobalSearch(""); }}><span><ProductSymbol symbol={productSymbol(product.name, product.category)} /></span><div><b>{product.name}</b><small>Product • {product.category}</small></div></button>)}
            {searchDestinations.map((destination) => <button type="button" key={destination.label} onClick={() => { setActivePage(destination.label); setGlobalSearch(""); }}><span className="search-result-icon">⌕</span><div><b>{destination.label}</b><small>Open report or module</small></div></button>)}
          </div>}
        </div>
        <button
          className="theme-toggle"
          type="button"
          aria-label={getResolvedTheme(themePreference) === "dark" ? "Switch to day mode" : "Switch to night mode"}
          title={getResolvedTheme(themePreference) === "dark" ? "Switch to day mode" : "Switch to night mode"}
          onClick={() => {
            try {
              setThemePreference(getResolvedTheme(themePreference) === "dark" ? "light" : "dark");
            } catch {
              notify("Theme preference could not be saved in this browser.");
            }
          }}
        >
          {getResolvedTheme(themePreference) === "dark" ? <Sun size={19} /> : <Moon size={19} />}
        </button>
        {["admin", "store_manager"].includes(currentUser.role) && <Suspense fallback={<div className="notification-button" aria-label="Notifications loading"><Bell size={21} /></div>}>
          <NotificationBell onOpen={() => { setOperationsSection("notifications"); setActivePage("Operations Console"); }} onNotify={notify} />
        </Suspense>}
        <div className="profile-menu-wrap">
          <button
            className="profile-menu"
            type="button"
            onClick={() => setAccountMenuOpen((open) => !open)}
            aria-label={`Account menu for ${currentUser.full_name}`}
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
          >
            <span className="avatar">{currentUser.full_name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
            <span><b>{currentUser.full_name}</b><small>{currentUser.role.replace(/_/g, " ")}</small></span>
            <ChevronDown size={17} />
          </button>
          {accountMenuOpen && <div className="account-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setActivePage("Profile"); setAccountMenuOpen(false); }}>
              <UserRound size={16} /> My Profile
            </button>
            <button type="button" role="menuitem" onClick={() => { setAccountMenuOpen(false); void handleSignOut(); }}>
              <LogOut size={16} /> Sign out
            </button>
          </div>}
        </div>
      </header>

      <aside className="sidebar" id="app-sidebar">
        <nav aria-label="Main navigation">
          {links.filter(({ label }) =>
            (label !== "Users & Roles" || currentUser.role === "admin") &&
            (label !== "Operations Console" || (canViewAuditLogs(currentUser.role) && canViewSystemHealth(currentUser.role)))
          ).map(({ label, icon: Icon }) => (
            <a
              className={`nav-link ${label === activePage ? "active" : ""}`}
              href="#"
              key={label}
              onClick={(event) => {
                event.preventDefault();
                setActivePage(label);
                if (label === "Operations Console") setOperationsSection("audit");
                if (label === "Sales / POS") {
                  window.history.pushState(null, "", "/app/sales-pos");
                  setRoutePath("/app/sales-pos");
                }
                if (!["Products", "Dashboard", "Inventory", "Batch Management", "Expiry Alerts", "Sales / POS", "Sales History", "Demand Forecast", "Recommendations", "Waste Reports", "Model Metrics", "Users & Roles", "Operations Console", "Settings"].includes(label)) {
                  notify(`${label} view is coming soon`);
                }
              }}
              aria-current={label === activePage ? "page" : undefined}
              aria-label={label}
            >
              <Icon size={21} strokeWidth={2.2} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-promo">
          <span className="promo-leaves">🌿</span>
          <b>Together<br />for a<br />Waste-Free<br />Tomorrow</b>
          <span className="promo-spark">✦</span>
        </div>
      </aside>

      <main className="main-content">
        <ExpandedContentOverlay />
        {activePage === "Dashboard" ? <Dashboard userName={currentUser.full_name} onNotify={notify} /> : activePage === "Batch Management" ? (
          <BatchManagement onNotify={notify} canEdit={["admin", "store_manager"].includes(currentUser.role)} canDelete={["admin", "store_manager"].includes(currentUser.role)} canImport={currentUser.role === "admin"} />
        ) : activePage === "Expiry Alerts" ? (
          <ExpiryAlerts onNotify={notify} canManageRules={["admin", "store_manager"].includes(currentUser.role)} canExport={currentUser.role === "admin"} />
        ) : activePage === "Inventory" ? (
          <Inventory onNotify={notify} canEditBatchDates={["admin", "store_manager"].includes(currentUser.role)} canDeleteProducts={["admin", "store_manager"].includes(currentUser.role)} />
        ) : activePage === "Sales / POS" ? (
          ["admin", "store_manager"].includes(currentUser.role)
            ? <SalesPos onNotify={notify} />
            : <section className="coming-soon-card"><h1>POS access restricted</h1><p>Your role is not permitted to create sales.</p></section>
        ) : activePage === "Sales History" ? (
          <SalesHistory onNotify={notify} canExport={currentUser.role === "admin"} />
        ) : activePage === "Demand Forecast" ? (
          <DemandForecast onNotify={notify} canGenerate={["admin", "store_manager"].includes(currentUser.role)} />
        ) : activePage === "Recommendations" ? (
          <Suspense fallback={<div className="dashboard-state" role="status">Loading recommendations…</div>}>
            <Recommendations onNotify={notify} canApply={currentUser.role === "admin" || currentUser.role === "store_manager"} />
          </Suspense>
        ) : activePage === "Waste Reports" ? (
          <WasteReports onNotify={notify} canManage={["admin", "store_manager"].includes(currentUser.role)} canExport={currentUser.role === "admin"} />
        ) : activePage === "Model Metrics" ? (
          <Suspense fallback={<div className="dashboard-state" role="status">Loading model metrics…</div>}>
            <ModelMetrics onNotify={notify} canRetrain={currentUser.role === "admin"} />
          </Suspense>
        ) : activePage === "Users & Roles" ? (
          <UsersRoles onNotify={notify} />
        ) : activePage === "Operations Console" ? (
          canViewAuditLogs(currentUser.role) && canViewSystemHealth(currentUser.role)
            ? <Suspense fallback={<div className="dashboard-state" role="status">Loading Operations Console…</div>}>
              <OperationsConsole isAdmin={currentUser.role === "admin"} onNotify={notify} initialSection={operationsSection} />
            </Suspense>
            : <section className="coming-soon-card"><h1>Operations Console access restricted</h1><p>Your role is not permitted to view audit, notification, or system health details.</p></section>
        ) : activePage === "Settings" ? (
          <SettingsPage onNotify={notify} canManageShelfLife={currentUser.role === "admin"} />
        ) : activePage === "Profile" ? (
          <Profile
            onNotify={notify}
            onNameChange={(fullName) => setCurrentUser((user) => user ? { ...user, full_name: fullName } : user)}
            onPasswordChanged={() => endLocalSession()}
          />
        ) : activePage !== "Products" ? (
          <section className="coming-soon-card">
            <span><LayoutDashboard size={24} /></span>
            <h1>{activePage}</h1>
            <p>This section is ready to connect to your WasteWise inventory data.</p>
            <button onClick={() => setActivePage("Dashboard")}>Back to Dashboard</button>
          </section>
        ) : (
        <>
        <section className="page-banner">
          <div className="banner-copy">
            <span className="eyebrow">INVENTORY MANAGEMENT</span>
            <h1>Products</h1>
            <p>Manage all products in your inventory</p>
          </div>
          <div className="banner-art" aria-hidden="true">
            <span className="produce produce-one">🥬</span><span className="produce produce-two">🥖</span>
            <span className="produce produce-three">🥛</span><span className="produce produce-four">🥕</span>
            <span className="produce produce-five">🍅</span><span className="produce produce-six">🥦</span>
            <span className="art-leaf leaf-one">⌁</span><span className="art-leaf leaf-two">⌁</span>
          </div>
          {canManageProducts && <button className="add-button" onClick={openAdd}><Plus size={19} strokeWidth={2.5} /> Add Product</button>}
        </section>

        <section className="stats-grid" aria-label="Product summary">
          <StatCard icon={<Box size={29} />} color="green" label="Total Products" value={products.length} change="↑ 5%" note="All products" />
          <StatCard icon={<Tag size={29} />} color="blue" label="Active Products" value={activeProducts} change="↑ 8%" note="Currently available" />
          <StatCard icon={<AlertTriangle size={30} />} color="orange" label="Low Stock Products" value={lowStock} change="↑ 100%" note="Need restocking" />
          <StatCard icon={<Users size={29} />} color="purple" label="Categories" value={categoryCount} note="Product categories" />
        </section>

        <section className="products-panel">
          <div className="filter-toolbar">
            <label className="table-search">
              <Search size={18} />
              <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search products by name, category, or SKU..." />
              {search && <button aria-label="Clear search" onClick={() => setSearch("")}><X size={15} /></button>}
            </label>
            <select aria-label="Filter by category" value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}>
              <option>All Categories</option>{categories.map((item) => <option key={item}>{item}</option>)}
            </select>
            <select aria-label="Filter by status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
              <option>All Status</option><option>Active</option><option>Low Stock</option>
            </select>
            <select aria-label="Filter by supplier" value={supplier} onChange={(event) => { setSupplier(event.target.value); setPage(1); }}>
              <option>All Suppliers</option>{suppliers.map((item) => <option key={item}>{item}</option>)}
            </select>
            <label className="product-sort-control">Sort by
              <select aria-label="Sort products by" value={sortBy} onChange={(event) => { setSortBy(event.target.value as typeof sortBy); setPage(1); }}>
                <option value="name">Name</option><option value="category">Category</option><option value="stock">Stock</option><option value="price">Price</option><option value="updated">Last updated</option>
              </select>
            </label>
            <button type="button" className="product-sort-direction" aria-label={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`} onClick={() => setSortDirection((direction) => direction === "asc" ? "desc" : "asc")}>{sortDirection === "asc" ? "Ascending" : "Descending"}</button>
            {currentUser.role === "admin" && <button className="export-button" onClick={exportProducts}><Download size={18} /> Export</button>}
          </div>

          {canDeleteProducts && selected.length > 0 && (
            <div className="selection-bar">
              <span>{selected.length} product{selected.length === 1 ? "" : "s"} selected</span>
              <button onClick={async () => {
                try {
                  await Promise.all(selected.map((id) => deleteProductRequest(id)));
                  await refreshProducts();
                  setSelected([]);
                  notify("Selected products deleted");
                } catch (error) {
                  await refreshProducts();
                  notify(error instanceof Error ? error.message : "Could not delete all selected products.");
                }
              }}><Trash2 size={15} /> Delete selected</button>
            </div>
          )}

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="check-cell"><input type="checkbox" aria-label="Select all visible products" checked={visibleProducts.length > 0 && visibleProducts.every((product) => selected.includes(product.id))} onChange={toggleAll} /></th>
                  <th>#</th><th>Image</th><th>Product Name</th><th>Category</th><th>SKU</th><th>Unit</th><th>Price (₹)</th><th>Current Stock</th><th>Status</th><th>Supplier</th><th>Last Updated</th><th>Details / Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((product, index) => {
                  const isLow = product.stock < 20;
                  return (
                    <tr key={product.id}>
                      <td className="check-cell"><input type="checkbox" aria-label={`Select ${product.name}`} checked={selected.includes(product.id)} onChange={() => setSelected((current) => current.includes(product.id) ? current.filter((id) => id !== product.id) : [...current, product.id])} /></td>
                      <td>{(page - 1) * pageSize + index + 1}</td>
                      <td><span className="product-emoji"><ProductSymbol symbol={productSymbol(product.name, product.category)} /></span></td>
                      <td className="product-name">{product.name}</td>
                      <td>{product.category}</td>
                      <td className="sku-cell">{product.sku}</td>
                      <td>{product.unit}</td>
                      <td>₹ {product.price}</td>
                      <td>{product.stock}</td>
                      <td><span className={`status-pill ${isLow ? "low" : ""}`}>{isLow ? "Low Stock" : "Active"}</span></td>
                      <td>{product.supplier}</td>
                      <td>{product.updated}</td>
                      <td>
                        <div className="row-actions">
                          <button aria-label={`View ${product.name} details`} title="View details" onClick={() => setViewingProduct(product)}><Eye size={15} /></button>
                          {canManageProducts && <><button aria-label={`Edit ${product.name}`} title="Edit" onClick={() => openEdit(product)}><Pencil size={15} /></button>
                          <button aria-label={`Duplicate ${product.name}`} title="Duplicate" onClick={() => duplicateProduct(product)}><Copy size={15} /></button></>}
                          {canDeleteProducts && <button className="delete-action" aria-label={`Delete ${product.name}`} title="Delete" onClick={() => deleteProduct(product)}><Trash2 size={16} /></button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visibleProducts.length === 0 && (
                  <tr><td className="empty-state" colSpan={13}><Search size={24} /><b>No products found</b><span>Try adjusting your search or filters.</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
          <footer className="table-footer">
            <span>Showing {filtered.length ? (page - 1) * pageSize + 1 : 0} to {Math.min(page * pageSize, filtered.length)} of {filtered.length} products</span>
            <div className="pagination" aria-label="Pagination">
              <button aria-label="Previous page" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={18} /></button>
              {visibleProductPages.map((pageNumber) => <button key={pageNumber} className={page === pageNumber ? "current" : ""} aria-current={page === pageNumber ? "page" : undefined} onClick={() => setPage(pageNumber)}>{pageNumber}</button>)}
              {visibleProductPages[visibleProductPages.length - 1] < totalPages && <><span className="page-ellipsis">…</span><button onClick={() => setPage(totalPages)}>{totalPages}</button></>}
              <button aria-label="Next page" disabled={page === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}><ChevronRight size={18} /></button>
            </div>
          </footer>
        </section>
        <div className="mobile-caption">WasteWise AI · Smart inventory, less waste</div>
        </>
        )}
      </main>

      {isModalOpen ? (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsModalOpen(false); }}>
          <form className="product-modal" onSubmit={saveProduct}>
            <div className="modal-heading"><div><span className="modal-icon product-modal-symbol" aria-hidden="true"><ProductSymbol symbol={productSymbol(form.name, form.category)} /></span><div><h2>{modalProduct ? "Edit Product" : "Add Product"}</h2><p>Enter product details below.</p></div></div><button type="button" aria-label="Close" onClick={() => setIsModalOpen(false)}><X size={20} /></button></div>
            <label>Product name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Fresh apples" /></label>
            <ProductSuggestionAction
              productName={form.name}
              selectedCategory={form.category}
              savedSku={modalProduct?.sku}
              refreshToken={skuSuggestionRefreshToken}
              onApply={(suggestion, sku) => setForm((current) => ({
                ...current,
                category: suggestion.category,
                unit: suggestion.unit,
                expiryDate: expiryDateManuallyEdited
                  ? current.expiryDate
                  : calculateSuggestedExpiryDate(suggestion.category, current.receivedDate) ?? "",
                expiryDateSource: expiryDateManuallyEdited ? current.expiryDateSource : "estimated",
                ...(sku ? { sku } : {}),
              }))}
              onApplySku={(sku) => setForm((current) => ({ ...current, sku }))}
            />
            <div className="form-row"><label>Category<select value={form.category} onChange={(event) => { const nextCategory = event.target.value; setForm((current) => ({ ...current, category: nextCategory, expiryDate: expiryDateManuallyEdited ? current.expiryDate : calculateSuggestedExpiryDate(nextCategory, current.receivedDate) ?? "", expiryDateSource: expiryDateManuallyEdited ? current.expiryDateSource : "estimated" })); }}>{categoryOptions.map((item) => <option key={item}>{item}</option>)}</select></label><label>SKU<input required value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} placeholder="SKU001" /></label></div>
            <div className="form-row"><label>Unit<select value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })}>{unitOptions.map((item) => <option key={item}>{item}</option>)}</select></label><label>Price (₹)<input required min="0" type="number" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} placeholder="0.00" /></label></div>
            <div className="form-row"><label>Current stock<input required min="0" step="0.01" type="number" value={form.stock} onChange={(event) => setForm({ ...form, stock: event.target.value })} placeholder="0" />{!modalProduct && <small className="form-field-note">Initial stock will be added as the product's opening inventory batch.</small>}</label><label>Supplier<input required value={form.supplier} onChange={(event) => setForm({ ...form, supplier: event.target.value })} placeholder="Supplier name" /></label></div>
            {!modalProduct && <><div className="form-row"><label>Received date<input type="date" required={Number(form.stock) > 0} value={form.receivedDate} onChange={(event) => setForm((current) => ({ ...current, receivedDate: event.target.value, expiryDate: expiryDateManuallyEdited ? current.expiryDate : calculateSuggestedExpiryDate(current.category, event.target.value) ?? "", expiryDateSource: expiryDateManuallyEdited ? current.expiryDateSource : "estimated" }))} /></label><label>Expiry date<input aria-label="Opening batch expiry date" type="date" min={form.receivedDate} required={Number(form.stock) > 0} value={form.expiryDate} onChange={(event) => { setExpiryDateManuallyEdited(true); setForm((current) => ({ ...current, expiryDate: event.target.value, expiryDateSource: "manual_verified" })); }} />{calculateSuggestedExpiryDate(form.category, form.receivedDate) ? <small className="form-field-note">Suggested from {form.category} shelf life; verify against the manufacturer or batch label.</small> : <small className="form-field-note">No category default is available. Verify the manufacturer or batch expiry date manually.</small>}</label></div><label>Expiry date basis<select value={form.expiryDateSource} onChange={(event) => { const source = event.target.value as ExpiryDateSource; setExpiryDateManuallyEdited(source !== "estimated"); setForm((current) => ({ ...current, expiryDateSource: source, ...(source === "estimated" ? { expiryDate: calculateSuggestedExpiryDate(current.category, current.receivedDate) ?? "" } : {}) })); }}><option value="estimated">Category-based estimate</option><option value="manufacturer_verified">Manufacturer verified</option><option value="manual_verified">Manually verified</option></select></label></>}
            <div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setIsModalOpen(false)}>Cancel</button><button type="submit" className="save-button"><Check size={16} /> {modalProduct ? "Save Changes" : "Add Product"}</button></div>
          </form>
        </div>
      ) : null}
      {viewingProduct && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewingProduct(null); }}>
          <section className="product-modal product-detail-modal" role="dialog" aria-modal="true" aria-labelledby="product-detail-heading">
            <div className="modal-heading"><div><span className="modal-icon product-modal-symbol" aria-hidden="true"><ProductSymbol symbol={productSymbol(viewingProduct.name, viewingProduct.category)} /></span><div><h2 id="product-detail-heading">{viewingProduct.name}</h2><p>{viewingProduct.category} · SKU {viewingProduct.sku}</p></div></div><button type="button" aria-label="Close product details" onClick={() => setViewingProduct(null)}><X size={20} /></button></div>
            <dl className="product-detail-grid">
              <div><dt>Category</dt><dd>{viewingProduct.category}</dd></div>
              <div><dt>SKU</dt><dd>{viewingProduct.sku}</dd></div>
              <div><dt>Unit</dt><dd>{viewingProduct.unit}</dd></div>
              <div><dt>Price</dt><dd>₹ {viewingProduct.price}</dd></div>
              <div><dt>Current stock</dt><dd>{viewingProduct.stock}</dd></div>
              <div><dt>Supplier</dt><dd>{viewingProduct.supplier}</dd></div>
              <div><dt>Last updated</dt><dd>{viewingProduct.updated}</dd></div>
            </dl>
            <div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setViewingProduct(null)}>Close</button><button type="button" className="save-button" onClick={() => { setViewingProduct(null); openEdit(viewingProduct); }}><Pencil size={15} /> Edit Product</button></div>
          </section>
        </div>
      )}
      {toast && <div className="toast"><Check size={17} />{toast}</div>}
    </div>
  );
}

function StatCard({ icon, color, label, value, change, note }: { icon: ReactNode; color: string; label: string; value: number; change?: string; note: string }) {
  return (
    <article className="stat-card">
      <span className={`stat-icon ${color}`}>{icon}</span>
      <div className="stat-content"><span className="stat-label">{label}</span><div className="stat-value-row"><strong>{value}</strong>{change && <span className={`stat-change ${color === "orange" ? "negative" : ""}`}>{change}</span>}</div><span className="stat-note">{note}</span></div>
    </article>
  );
}

export default App;