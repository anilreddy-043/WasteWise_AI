import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "./Settings";
import * as business from "../services/business";
import { configureGeneralSettings, DEFAULT_GENERAL_SETTINGS } from "../services/generalSettings";
import * as auth from "../services/auth";

vi.mock("../services/auth", () => ({
  changePassword: vi.fn(),
  clearAccessToken: vi.fn(),
}));

vi.mock("../services/databaseBackups", () => ({
  listDatabaseBackups: vi.fn().mockResolvedValue([]),
  createDatabaseBackup: vi.fn(),
  downloadDatabaseBackup: vi.fn(),
  restoreDatabaseBackup: vi.fn(),
  uploadDatabaseBackup: vi.fn(),
}));

vi.mock("../services/business", () => ({
  getMySettings: vi.fn(),
  getGeneralSettings: vi.fn(),
  getNotificationSettings: vi.fn(),
  updateGeneralSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
  getStoreInformation: vi.fn(),
  getStoreLogoImage: vi.fn(),
  updateStoreInformation: vi.fn(),
  uploadStoreLogo: vi.fn(),
  listInventorySummary: vi.fn(),
  listProducts: vi.fn(),
  listSales: vi.fn(),
  listShelfLifeSettings: vi.fn(),
  updateShelfLifeSetting: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("wastewise.theme");
  localStorage.removeItem("wastewise.chart-color-theme");
  localStorage.removeItem("wastewise.accent-color");
  localStorage.removeItem("wastewise.corner-style");
  document.documentElement.dataset.theme = "light";
  delete document.documentElement.dataset.chartTheme;
  delete document.documentElement.dataset.accentColor;
  delete document.documentElement.dataset.cornerStyle;
  vi.mocked(auth.changePassword).mockResolvedValue();
  vi.mocked(business.getMySettings).mockResolvedValue({
    user_id: 1,
    full_name: "Test User",
    email: "test@example.com",
    role: "admin",
  });
  vi.mocked(business.getGeneralSettings).mockResolvedValue({
    application_name: "WasteWise AI",
    timezone: "Asia/Kolkata",
    date_format: "DD MMM YYYY",
    language: "en",
    items_per_page: 10,
  });
  vi.mocked(business.getNotificationSettings).mockResolvedValue({
    expiry_alerts: true,
    low_stock_alerts: true,
    high_demand_alerts: true,
    daily_reports: false,
    weekly_insights: true,
    system_notifications: true,
  });
  vi.mocked(business.updateNotificationSettings).mockImplementation(async (settings) => settings);
  vi.mocked(business.getStoreInformation).mockResolvedValue({
    store_id: 1,
    store_name: "",
    store_address: "",
    contact_number: "",
    email: "test@example.com",
    logo_path: null,
    logo_url: null,
  });
  vi.mocked(business.getStoreLogoImage).mockResolvedValue(new Blob(["logo"], { type: "image/png" }));
  vi.mocked(business.updateGeneralSettings).mockImplementation(async (settings) => settings);
  vi.mocked(business.updateStoreInformation).mockImplementation(async (settings) => ({
    store_id: 1,
    ...settings,
    logo_path: null,
    logo_url: null,
  }));
  vi.mocked(business.uploadStoreLogo).mockResolvedValue({
    store_id: 1,
    store_name: "Test Store",
    store_address: "Test address",
    contact_number: "+91 98765 43210",
    email: "test@example.com",
    logo_path: null,
    logo_url: null,
  });
  vi.mocked(business.listShelfLifeSettings).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  configureGeneralSettings(DEFAULT_GENERAL_SETTINGS);
});

describe("Settings", () => {
  it("renders all eight settings sections and links each section to its card", async () => {
    render(<Settings onNotify={vi.fn()} canManageShelfLife />);

    await screen.findByText(/Signed in as Test User/);
    const expectedSections = [
      ["General Settings", "general-settings"],
      ["Store Information", "store-settings"],
      ["Notification Settings", "notification-settings"],
      ["Data & Backup", "backup-settings"],
      ["Model Settings", "model-settings"],
      ["System Preferences", "system-preferences"],
      ["Security Settings", "security-settings"],
      ["Appearance", "appearance-settings"],
    ] as const;
    const navigation = screen.getByRole("navigation", { name: "Settings sections" });

    for (const [title, target] of expectedSections) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      expect(document.getElementById(target)).toBeInTheDocument();
      expect(within(navigation).getByRole("button", { name: title })).toHaveAttribute("aria-controls", target);
    }

    expect(await screen.findByRole("button", { name: "Create Backup" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Unavailable" })).not.toBeInTheDocument();
  });

  it("saves the appearance theme locally without implying backend persistence", async () => {
    const onNotify = vi.fn();
    render(<Settings onNotify={onNotify} />);
    await screen.findByText(/Signed in as Test User/);

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    const appearanceCard = document.getElementById("appearance-settings")!;
    fireEvent.change(within(appearanceCard).getByLabelText("Theme"), { target: { value: "Dark" } });
    fireEvent.click(within(appearanceCard).getByRole("button", { name: "Save Changes" }));

    expect(business.getMySettings).toHaveBeenCalledOnce();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("wastewise.theme")).toBe("dark");
    expect(onNotify).toHaveBeenCalledWith("Appearance preference saved in this browser.");
    expect(business.updateGeneralSettings).not.toHaveBeenCalled();
  });

  it("saves and applies chart palette, accent color, and corner style preferences locally", async () => {
    const onNotify = vi.fn();
    render(<Settings onNotify={onNotify} />);
    await screen.findByText(/Signed in as Test User/);

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    const appearanceCard = document.getElementById("appearance-settings")!;
    fireEvent.change(within(appearanceCard).getByLabelText("Inventory Chart Palette"), { target: { value: "blue" } });
    fireEvent.change(within(appearanceCard).getByLabelText("Accent Color"), { target: { value: "purple" } });
    fireEvent.change(within(appearanceCard).getByLabelText("Corner Style"), { target: { value: "square" } });
    fireEvent.click(within(appearanceCard).getByRole("button", { name: "Save Changes" }));

    expect(document.documentElement).toHaveAttribute("data-chart-theme", "blue");
    expect(document.documentElement).toHaveAttribute("data-accent-color", "purple");
    expect(document.documentElement).toHaveAttribute("data-corner-style", "square");
    expect(localStorage.getItem("wastewise.chart-color-theme")).toBe("blue");
    expect(localStorage.getItem("wastewise.accent-color")).toBe("purple");
    expect(localStorage.getItem("wastewise.corner-style")).toBe("square");
    expect(onNotify).toHaveBeenCalledWith("Appearance preference saved in this browser.");
  });

  it("loads saved general settings and persists edits", async () => {
    const onNotify = vi.fn();
    vi.mocked(business.getGeneralSettings).mockResolvedValue({
      application_name: "Fresh Market",
      timezone: "America/Los_Angeles",
      date_format: "YYYY-MM-DD",
      language: "hi",
      items_per_page: 50,
    });
    render(<Settings onNotify={onNotify} />);

    expect(await screen.findByDisplayValue("Fresh Market")).toBeInTheDocument();
    expect(screen.getByLabelText("Timezone")).toHaveValue("America/Los_Angeles");
    expect(screen.getByLabelText("Date Format")).toHaveValue("YYYY-MM-DD");
    expect(screen.getByLabelText("Language")).toHaveValue("hi");
    expect(screen.getByLabelText("Items Per Page")).toHaveValue("50");

    fireEvent.change(screen.getByLabelText("Application Name"), { target: { value: "  Fresh Mart  " } });
    fireEvent.change(screen.getByLabelText("Items Per Page"), { target: { value: "100" } });
    const generalCard = document.getElementById("general-settings")!;
    fireEvent.click(within(generalCard).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("General settings saved successfully."));
    expect(business.updateGeneralSettings).toHaveBeenCalledWith({
      application_name: "Fresh Mart",
      timezone: "America/Los_Angeles",
      date_format: "YYYY-MM-DD",
      language: "hi",
      items_per_page: 100,
    });
    expect(onNotify).toHaveBeenCalledWith("General settings saved successfully.");
  });

  it("validates the application name before making a save request", async () => {
    const onNotify = vi.fn();
    render(<Settings onNotify={onNotify} />);
    const applicationName = await screen.findByLabelText("Application Name");
    fireEvent.change(applicationName, { target: { value: "   " } });
    fireEvent.click(within(document.getElementById("general-settings")!).getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Application name must contain 1 to 120 characters.");
    expect(business.updateGeneralSettings).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith("Application name must contain 1 to 120 characters.");
  });

  it("surfaces API errors when saving general settings", async () => {
    const onNotify = vi.fn();
    vi.mocked(business.updateGeneralSettings).mockRejectedValueOnce(new Error("Settings could not be saved."));
    render(<Settings onNotify={onNotify} />);
    await screen.findByDisplayValue("WasteWise AI");
    fireEvent.click(within(document.getElementById("general-settings")!).getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Settings could not be saved.");
    expect(onNotify).toHaveBeenCalledWith("Settings could not be saved.");
  });

  it("loads shared store information and persists edits", async () => {
    const onNotify = vi.fn();
    vi.mocked(business.getStoreInformation).mockResolvedValue({
      store_id: 1,
      store_name: "Shared Store",
      store_address: "10 Market Road",
      contact_number: "+91 98765 43210",
      email: "shared@example.com",
      logo_path: null,
      logo_url: null,
    });
    render(<Settings onNotify={onNotify} />);

    expect(await screen.findByDisplayValue("Shared Store")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Store Name"), { target: { value: "Updated Shared Store" } });
    const storeCard = document.getElementById("store-settings")!;
    fireEvent.click(within(storeCard).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(business.updateStoreInformation).toHaveBeenCalledWith({
      store_name: "Updated Shared Store",
      store_address: "10 Market Road",
      contact_number: "+91 98765 43210",
      email: "shared@example.com",
    }));
    expect(onNotify).toHaveBeenCalledWith("Store information saved successfully.");
  });

  it("surfaces API errors when saving shared store information", async () => {
    const onNotify = vi.fn();
    vi.mocked(business.getStoreInformation).mockResolvedValue({
      store_id: 1,
      store_name: "Shared Store",
      store_address: "10 Market Road",
      contact_number: "+91 98765 43210",
      email: "shared@example.com",
      logo_path: null,
      logo_url: null,
    });
    vi.mocked(business.updateStoreInformation).mockRejectedValueOnce(new Error("Store information could not be saved."));
    render(<Settings onNotify={onNotify} />);

    await screen.findByDisplayValue("Shared Store");
    fireEvent.click(within(document.getElementById("store-settings")!).getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Store information could not be saved.");
    expect(onNotify).toHaveBeenCalledWith("Store information could not be saved.");
  });

  it("loads the saved store logo through the authenticated image service", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:store-logo"),
      revokeObjectURL: vi.fn(),
    });
    vi.mocked(business.getStoreInformation).mockResolvedValue({
      store_id: 1,
      store_name: "Shared Store",
      store_address: "10 Market Road",
      contact_number: "+91 98765 43210",
      email: "shared@example.com",
      logo_path: "uploads/store/1.png",
      logo_url: "/api/v1/settings/store/logo?v=123",
    });
    render(<Settings onNotify={vi.fn()} />);

    expect(await screen.findByAltText("Store logo preview")).toHaveAttribute("src", "blob:store-logo");
    expect(business.getStoreLogoImage).toHaveBeenCalledWith("/api/v1/settings/store/logo?v=123");
  });

  it("loads saved notification preferences and persists toggle changes", async () => {
    const onNotify = vi.fn();
    vi.mocked(business.getNotificationSettings).mockResolvedValue({
      expiry_alerts: false,
      low_stock_alerts: true,
      high_demand_alerts: true,
      daily_reports: true,
      weekly_insights: false,
      system_notifications: true,
    });
    render(<Settings onNotify={onNotify} />);

    const expiryToggle = await screen.findByRole("switch", { name: "Expiry Alerts notifications" });
    expect(expiryToggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Daily Reports notifications" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Weekly Insights notifications" })).toHaveAttribute("aria-checked", "false");

    fireEvent.click(expiryToggle);
    fireEvent.click(within(document.getElementById("notification-settings")!).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("Notification settings saved successfully."));
    expect(business.updateNotificationSettings).toHaveBeenCalledWith({
      expiry_alerts: true,
      low_stock_alerts: true,
      high_demand_alerts: true,
      daily_reports: true,
      weekly_insights: false,
      system_notifications: true,
    });
  });

  it("shows a clear error if notification settings cannot be saved", async () => {
    const onNotify = vi.fn();
    vi.mocked(business.updateNotificationSettings).mockRejectedValueOnce(new Error("Preferences could not be saved."));
    render(<Settings onNotify={onNotify} />);

    await screen.findByRole("switch", { name: "Expiry Alerts notifications" });
    fireEvent.click(within(document.getElementById("notification-settings")!).getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Preferences could not be saved.");
    expect(onNotify).toHaveBeenCalledWith("Preferences could not be saved.");
  });

  it("verifies and changes the password, then ends the revoked browser session", async () => {
    const onNotify = vi.fn();
    const expired = vi.fn();
    window.addEventListener("wastewise:session-expired", expired);
    render(<Settings onNotify={onNotify} />);
    await screen.findByText(/Signed in as Test User/);

    fireEvent.change(screen.getByLabelText("Current Password"), { target: { value: "OldPass123!" } });
    fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "NewPass456!" } });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), { target: { value: "NewPass456!" } });
    fireEvent.click(screen.getByRole("button", { name: "Change Password" }));

    await waitFor(() => expect(auth.changePassword).toHaveBeenCalledWith("OldPass123!", "NewPass456!"));
    expect(auth.clearAccessToken).toHaveBeenCalled();
    expect(expired).toHaveBeenCalled();
    expect(expired.mock.calls[0][0]).toMatchObject({
      detail: { message: "Password changed successfully. Please sign in again." },
    });
    window.removeEventListener("wastewise:session-expired", expired);
  });

  it("keeps backup and data-transfer controls out of the store-manager settings UI", async () => {
    vi.mocked(business.getMySettings).mockResolvedValue({
      user_id: 2,
      full_name: "Store Manager",
      email: "manager@example.com",
      role: "store_manager",
    });
    render(<Settings onNotify={vi.fn()} />);
    await screen.findByText(/Signed in as Store Manager/);

    expect(screen.queryByRole("button", { name: "Data & Backup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Data & Backup" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Security Settings" })).toBeInTheDocument();
  });
});
