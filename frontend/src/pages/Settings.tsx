import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  BarChart3,
  Bell,
  CalendarDays,
  ChevronDown,
  Database,
  Leaf,
  Palette,
  Save,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Store,
} from "lucide-react";
import { changePassword, clearAccessToken } from "../services/auth";
import {
  getGeneralSettings,
  getMySettings,
  getNotificationSettings,
  getStoreInformation,
  getStoreLogoImage,
  listShelfLifeSettings,
  updateShelfLifeSetting,
  updateGeneralSettings,
  updateNotificationSettings,
  updateStoreInformation,
  uploadStoreLogo,
} from "../services/business";
import type { NotificationSettingsRecord, ShelfLifeSettingRecord } from "../services/business";
import DataTransferPanel from "../components/DataTransferPanel";
import DatabaseBackupPanel from "../components/DatabaseBackupPanel";
import { configureShelfLifeDays } from "../services/expiryDates";
import {
  configureGeneralSettings,
  DEFAULT_GENERAL_SETTINGS,
} from "../services/generalSettings";
import type { GeneralSettings } from "../services/generalSettings";
import {
  getAppearancePreferences,
  saveAppearancePreferences,
  getThemePreference,
  setThemePreference,
  themeChangeEventName,
} from "../services/appearance";
import type { AccentColor, ChartColorTheme, CornerStyle, ThemePreference } from "../services/appearance";

type SettingsProps = { onNotify: (message: string) => void; canManageShelfLife?: boolean };
type NotificationKey = keyof NotificationSettingsRecord;

const settingsTabs = [
  { name: "General Settings", icon: SettingsIcon, target: "general-settings" },
  { name: "Store Information", icon: Store, target: "store-settings" },
  { name: "Notification Settings", icon: Bell, target: "notification-settings" },
  { name: "Data & Backup", icon: Database, target: "backup-settings" },
  { name: "Model Settings", icon: BarChart3, target: "model-settings" },
  { name: "System Preferences", icon: SlidersHorizontal, target: "system-preferences" },
  { name: "Security Settings", icon: ShieldCheck, target: "security-settings" },
  { name: "Appearance", icon: Palette, target: "appearance-settings" },
];

const timezoneOptions = [
  "Asia/Kolkata", "UTC", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Asia/Shanghai",
  "Asia/Hong_Kong", "Asia/Bangkok", "Asia/Jakarta", "Asia/Kathmandu", "Asia/Colombo",
  "Asia/Dhaka", "Asia/Karachi", "Asia/Kabul", "Asia/Jerusalem", "Asia/Riyadh",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Rome", "Europe/Madrid",
  "Europe/Moscow", "America/New_York", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "America/Toronto", "America/Vancouver", "America/Sao_Paulo",
  "Australia/Sydney", "Australia/Melbourne", "Pacific/Auckland", "Africa/Johannesburg",
  "Africa/Cairo", "Africa/Nairobi",
];

const notificationDefaults: NotificationSettingsRecord = {
  expiry_alerts: true,
  low_stock_alerts: true,
  high_demand_alerts: true,
  daily_reports: false,
  weekly_insights: true,
  system_notifications: true,
};

const notificationItems: { key: NotificationKey; title: string; description: string; tone: string }[] = [
  { key: "expiry_alerts", title: "Expiry Alerts", description: "Notify when products are nearing expiry", tone: "red" },
  { key: "low_stock_alerts", title: "Low Stock Alerts", description: "Notify when stock is below threshold", tone: "orange" },
  { key: "high_demand_alerts", title: "High Demand Alerts", description: "Notify for high demand predictions", tone: "blue" },
  { key: "daily_reports", title: "Daily Reports", description: "Receive daily summary reports", tone: "purple" },
  { key: "weekly_insights", title: "Weekly Insights", description: "Receive weekly AI insights", tone: "green" },
  { key: "system_notifications", title: "System Notifications", description: "Important system updates and maintenance", tone: "info" },
];

function SelectField({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: Array<string | { value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean }) {
  return <label className="settings-field"><span>{label}</span><div className="settings-select-wrap"><select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => {
    const optionValue = typeof option === "string" ? option : option.value;
    const optionLabel = typeof option === "string" ? option : option.label;
    return <option key={optionValue} value={optionValue}>{optionLabel}</option>;
  })}</select><ChevronDown size={13} /></div></label>;
}

function SaveButton({ onClick, disabled = false, label = "Save Changes" }: { onClick: () => void; disabled?: boolean; label?: string }) {
  return <div className="settings-save-row"><button type="button" className="settings-save-button" disabled={disabled} onClick={onClick}><Save size={13} /> {label}</button></div>;
}

function SettingsCardHeading({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return <header className="settings-card-heading"><span>{icon}</span><div><h2>{title}</h2><p>{description}</p></div></header>;
}

export default function Settings({ onNotify, canManageShelfLife = false }: SettingsProps) {
  const [profile, setProfile] = useState<{ full_name: string; email: string; role: string } | null>(null);
  const [activeTab, setActiveTab] = useState("General Settings");
  const [notifications, setNotifications] = useState(notificationDefaults);
  const [loadingNotificationSettings, setLoadingNotificationSettings] = useState(true);
  const [savingNotificationSettings, setSavingNotificationSettings] = useState(false);
  const [notificationSettingsError, setNotificationSettingsError] = useState("");
  const [applicationName, setApplicationName] = useState(DEFAULT_GENERAL_SETTINGS.application_name);
  const [timezone, setTimezone] = useState(DEFAULT_GENERAL_SETTINGS.timezone);
  const [dateFormat, setDateFormat] = useState<GeneralSettings["date_format"]>(DEFAULT_GENERAL_SETTINGS.date_format);
  const [language, setLanguage] = useState<GeneralSettings["language"]>(DEFAULT_GENERAL_SETTINGS.language);
  const [itemsPerPage, setItemsPerPage] = useState(String(DEFAULT_GENERAL_SETTINGS.items_per_page));
  const [loadingGeneralSettings, setLoadingGeneralSettings] = useState(true);
  const [savingGeneralSettings, setSavingGeneralSettings] = useState(false);
  const [generalSettingsError, setGeneralSettingsError] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeAddress, setStoreAddress] = useState("");
  const [contactNumber, setContactNumber] = useState("");
  const [email, setEmail] = useState("");
  const [logoName, setLogoName] = useState("");
  const [storeLogoPreview, setStoreLogoPreview] = useState<string | null>(null);
  const [storeLogoFile, setStoreLogoFile] = useState<File | null>(null);
  const [savingStoreSettings, setSavingStoreSettings] = useState(false);
  const [storeSettingsError, setStoreSettingsError] = useState("");
  const [forecastModel, setForecastModel] = useState("Random Forest");
  const [forecastPeriod, setForecastPeriod] = useState("30");
  const [expiryThreshold, setExpiryThreshold] = useState("7");
  const [discountModel, setDiscountModel] = useState("Gradient Boosting");
  const [minimumDiscount, setMinimumDiscount] = useState("10");
  const [maximumDiscount, setMaximumDiscount] = useState("50");
  const [theme, setTheme] = useState(() => {
    const preference = getThemePreference();
    return preference === "light" ? "Light (Default)" : preference === "dark" ? "Dark" : "System";
  });
  const [chartTheme, setChartTheme] = useState<ChartColorTheme>(() => getAppearancePreferences().chartColorTheme);
  const [accentColor, setAccentColor] = useState<AccentColor>(() => getAppearancePreferences().accentColor);
  const [cornerStyle, setCornerStyle] = useState<CornerStyle>(() => getAppearancePreferences().cornerStyle);
  const [defaultView, setDefaultView] = useState("Dashboard");
  const [currency, setCurrency] = useState("Indian Rupee (₹)");
  const [weightUnit, setWeightUnit] = useState("Kilograms (kg)");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordChangeError, setPasswordChangeError] = useState("");
  const [shelfLifeSettings, setShelfLifeSettings] = useState<ShelfLifeSettingRecord[]>([]);
  const [shelfLifeDays, setShelfLifeDays] = useState<Record<string, string>>({});
  useEffect(() => {
    const syncTheme = (event: Event) => {
      const preference = (event as CustomEvent<ThemePreference>).detail;
      setTheme(preference === "light" ? "Light (Default)" : preference === "dark" ? "Dark" : "System");
    };
    window.addEventListener(themeChangeEventName(), syncTheme);
    return () => window.removeEventListener(themeChangeEventName(), syncTheme);
  }, []);
  const logoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    getGeneralSettings()
      .then((settings) => {
        if (!active) return;
        setApplicationName(settings.application_name);
        setTimezone(settings.timezone);
        setDateFormat(settings.date_format);
        setLanguage(settings.language);
        setItemsPerPage(String(settings.items_per_page));
        configureGeneralSettings(settings);
        setGeneralSettingsError("");
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Could not load general settings.";
        setGeneralSettingsError(message);
        onNotify(message);
      })
      .finally(() => { if (active) setLoadingGeneralSettings(false); });
    getMySettings()
      .then((value) => { if (active) setProfile(value); })
      .catch((error: unknown) => onNotify(error instanceof Error ? error.message : "Could not load account settings."));
    return () => { active = false; };
  }, [onNotify]);

  useEffect(() => {
    if (!profile || !["admin", "store_manager"].includes(profile.role)) return;
    let active = true;
    getStoreInformation()
      .then((store) => {
        if (!active) return;
        setStoreName(store.store_name ?? "");
        setStoreAddress(store.store_address ?? "");
        setContactNumber(store.contact_number ?? "");
        setEmail(store.email ?? "");
        setLogoName(store.logo_path ? store.logo_path.split("/").pop() ?? "logo" : "");
        setStoreLogoPreview(null);
        setStoreLogoFile(null);
        setStoreSettingsError("");
        if (store.logo_url) {
          getStoreLogoImage(store.logo_url)
            .then((image) => {
              if (active) setStoreLogoPreview(URL.createObjectURL(image));
            })
            .catch((error: unknown) => {
              if (!active) return;
              const message = error instanceof Error ? error.message : "Store logo could not be loaded.";
              setStoreSettingsError(message);
              onNotify(message);
            });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Could not load store information.";
        setStoreSettingsError(message);
        onNotify(message);
      });
    return () => { active = false; };
  }, [onNotify, profile]);

  useEffect(() => {
    let active = true;
    getNotificationSettings()
      .then((settings) => {
        if (!active) return;
        setNotifications(settings);
        setNotificationSettingsError("");
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Could not load notification settings.";
        setNotificationSettingsError(message);
        onNotify(message);
      })
      .finally(() => { if (active) setLoadingNotificationSettings(false); });
    return () => { active = false; };
  }, [onNotify]);

  async function saveGeneralSettings() {
    const applicationNameValue = applicationName.trim();
    if (!applicationNameValue || applicationNameValue.length > 120) {
      const message = "Application name must contain 1 to 120 characters.";
      setGeneralSettingsError(message);
      onNotify(message);
      return;
    }
    const pageSize = Number(itemsPerPage);
    if (![10, 20, 50, 100].includes(pageSize)) {
      const message = "Items per page must be 10, 20, 50, or 100.";
      setGeneralSettingsError(message);
      onNotify(message);
      return;
    }
    setSavingGeneralSettings(true);
    setGeneralSettingsError("");
    try {
      const saved = await updateGeneralSettings({
        application_name: applicationNameValue,
        timezone,
        date_format: dateFormat,
        language,
        items_per_page: pageSize as GeneralSettings["items_per_page"],
      });
      setApplicationName(saved.application_name);
      setTimezone(saved.timezone);
      setDateFormat(saved.date_format);
      setLanguage(saved.language);
      setItemsPerPage(String(saved.items_per_page));
      configureGeneralSettings(saved);
      onNotify("General settings saved successfully.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "General settings could not be saved.";
      setGeneralSettingsError(message);
      onNotify(message);
    } finally {
      setSavingGeneralSettings(false);
    }
  }

  async function saveNotificationSettings() {
    setSavingNotificationSettings(true);
    setNotificationSettingsError("");
    try {
      const saved = await updateNotificationSettings(notifications);
      setNotifications(saved);
      onNotify("Notification settings saved successfully.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Notification settings could not be saved.";
      setNotificationSettingsError(message);
      onNotify(message);
    } finally {
      setSavingNotificationSettings(false);
    }
  }

  async function saveStoreSettings() {
    const trimmedName = storeName.trim();
    const trimmedAddress = storeAddress.trim();
    const trimmedContact = contactNumber.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName || trimmedName.length > 160) {
      const message = "Store name must contain 1 to 160 characters.";
      setStoreSettingsError(message);
      onNotify(message);
      return;
    }
    if (!trimmedAddress || trimmedAddress.length > 255) {
      const message = "Store address must contain 1 to 255 characters.";
      setStoreSettingsError(message);
      onNotify(message);
      return;
    }
    if (!/^\+?[0-9()\-\s.]{7,32}$/.test(trimmedContact) || !/[0-9]/.test(trimmedContact)) {
      const message = "Contact number must be a valid phone number with 7 to 32 characters.";
      setStoreSettingsError(message);
      onNotify(message);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      const message = "Email address must be valid.";
      setStoreSettingsError(message);
      onNotify(message);
      return;
    }

    setSavingStoreSettings(true);
    setStoreSettingsError("");
    try {
      const saved = await updateStoreInformation({
        store_name: trimmedName,
        store_address: trimmedAddress,
        contact_number: trimmedContact,
        email: trimmedEmail,
      });

      let finalLogoUrl = storeLogoPreview;
      if (storeLogoFile) {
        const uploaded = await uploadStoreLogo(storeLogoFile);
        setLogoName(uploaded.logo_path ? uploaded.logo_path.split("/").pop() ?? "logo" : storeLogoFile.name);
      }

      setStoreName(saved.store_name ?? trimmedName);
      setStoreAddress(saved.store_address ?? trimmedAddress);
      setContactNumber(saved.contact_number ?? trimmedContact);
      setEmail(saved.email ?? trimmedEmail);
      setStoreLogoPreview(finalLogoUrl ?? null);
      setStoreLogoFile(null);
      setStoreSettingsError("");
      onNotify("Store information saved successfully.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Store information could not be saved.";
      setStoreSettingsError(message);
      onNotify(message);
    } finally {
      setSavingStoreSettings(false);
    }
  }

  useEffect(() => {
    return () => {
      if (storeLogoPreview?.startsWith("blob:")) {
        URL.revokeObjectURL(storeLogoPreview);
      }
    };
  }, [storeLogoPreview]);

  useEffect(() => {
    if (!canManageShelfLife) return;
    let active = true;
    listShelfLifeSettings()
      .then((settings) => {
        if (!active) return;
        setShelfLifeSettings(settings);
        setShelfLifeDays(Object.fromEntries(settings.map((setting) => [setting.category, String(setting.days)])));
        configureShelfLifeDays(settings);
      })
      .catch((error: unknown) => {
        if (active) onNotify(error instanceof Error ? error.message : "Could not load shelf-life settings.");
      });
    return () => { active = false; };
  }, [canManageShelfLife, onNotify]);

  async function saveShelfLifeSetting(category: string) {
    const days = Number(shelfLifeDays[category]);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      onNotify("Shelf life must be a whole number between 1 and 3650 days.");
      return;
    }
    try {
      const saved = await updateShelfLifeSetting(category, days);
      setShelfLifeSettings((current) => current.map((setting) => setting.category === category ? saved : setting));
      configureShelfLifeDays([saved]);
      onNotify(`${category} shelf life saved`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Shelf-life setting could not be saved.");
    }
  }

  function saveSettings(section: string) {
    if (section === "Appearance") {
      const preference: ThemePreference = theme === "Dark" ? "dark" : theme === "System" ? "system" : "light";
      try {
        setThemePreference(preference);
        saveAppearancePreferences({ chartColorTheme: chartTheme, accentColor, cornerStyle });
        onNotify("Appearance preference saved in this browser.");
      } catch {
        onNotify("Appearance preference could not be saved in this browser.");
      }
      return;
    }
    onNotify(`${section} preferences are not saved: the backend currently exposes account profile data only.`);
  }

  async function savePasswordChange() {
    setPasswordChangeError("");
    if (newPassword !== confirmPassword) {
      setPasswordChangeError("New password and confirmation do not match.");
      return;
    }
    if (
      newPassword.length < 8 ||
      !/[A-Za-z]/.test(newPassword) ||
      !/[0-9]/.test(newPassword) ||
      !/[^A-Za-z0-9]/.test(newPassword)
    ) {
      setPasswordChangeError("Use at least 8 characters, including a letter, a number, and a special character.");
      return;
    }
    setChangingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      clearAccessToken();
      window.dispatchEvent(new CustomEvent("wastewise:session-expired", {
        detail: { message: "Password changed successfully. Please sign in again." },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Password could not be changed.";
      setPasswordChangeError(message);
      onNotify(message);
    } finally {
      setChangingPassword(false);
    }
  }

  function chooseTab(name: string, target: string) {
    setActiveTab(name);
    document.getElementById(target)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }

  function toggleNotification(key: NotificationKey) {
    setNotifications((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <div className="settings-page">
      <section className="settings-banner">
        <div><h1>Settings</h1><p>Configure your store, system preferences, and application settings</p></div>
        <div className="settings-banner-art" aria-hidden="true">
          <span className="settings-banner-leaf leaf-a">🌿</span><span className="settings-banner-leaf leaf-b">🌱</span>
          <div className="settings-banner-gear"><SettingsIcon size={64} /></div>
          <span className="settings-banner-leaf leaf-c">🌿</span>
          <div className="settings-banner-message"><Leaf size={27} /><b>Customize WasteWise AI<br />for a Smarter,<br />Greener Store</b></div>
        </div>
      </section>
      <div className="form-field-note" role="status">{profile ? `Signed in as ${profile.full_name} (${profile.email}) · ${profile.role.replace(/_/g, " ")}` : "Account profile is loading. Settings and data exports use the authenticated backend."}</div>

      <nav className="settings-tabs" aria-label="Settings sections">
        {settingsTabs.filter(({ name }) => name !== "Data & Backup" || profile?.role === "admin").map(({ name, icon: Icon, target }) => <button key={name} type="button" className={activeTab === name ? "active" : ""} aria-controls={target} aria-current={activeTab === name ? "page" : undefined} onClick={() => chooseTab(name, target)}><Icon size={16} /><span>{name}</span></button>)}
      </nav>

      <div className="settings-grid">
        <section className="settings-card general-settings-card" id="general-settings">
          <SettingsCardHeading icon={<SettingsIcon size={23} />} title="General Settings" description="Your personal defaults for display, dates, language, and tables" />
          {generalSettingsError && <p className="settings-general-error" role="alert">{generalSettingsError}</p>}
          <div className="settings-fields">
            <label className="settings-field"><span>Application Name</span><input maxLength={120} disabled={loadingGeneralSettings || savingGeneralSettings} value={applicationName} onChange={(event) => setApplicationName(event.target.value)} /></label>
            <SelectField label="Timezone" value={timezone} options={[...new Set([...timezoneOptions, timezone])]} onChange={setTimezone} disabled={loadingGeneralSettings || savingGeneralSettings} />
            <SelectField label="Date Format" value={dateFormat} options={["DD MMM YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]} onChange={(value) => setDateFormat(value as GeneralSettings["date_format"])} disabled={loadingGeneralSettings || savingGeneralSettings} />
            <SelectField label="Language" value={language} options={[{ value: "en", label: "English" }, { value: "hi", label: "हिन्दी" }, { value: "te", label: "తెలుగు" }, { value: "mr", label: "मराठी" }]} onChange={(value) => setLanguage(value as GeneralSettings["language"])} disabled={loadingGeneralSettings || savingGeneralSettings} />
            <SelectField label="Items Per Page" value={itemsPerPage} options={["10", "20", "50", "100"]} onChange={setItemsPerPage} disabled={loadingGeneralSettings || savingGeneralSettings} />
          </div>
          <SaveButton onClick={() => { void saveGeneralSettings(); }} disabled={loadingGeneralSettings || savingGeneralSettings} label={savingGeneralSettings ? "Saving…" : "Save Changes"} />
        </section>

        <section className="settings-card store-settings-card" id="store-settings">
          <SettingsCardHeading icon={<Store size={23} />} title="Store Information" description="Shared details for this physical store" />
          {storeSettingsError && <p className="settings-general-error" role="alert">{storeSettingsError}</p>}
          <div className="settings-fields">
            <label className="settings-field"><span>Store Name</span><input disabled={profile?.role !== "admin" && profile?.role !== "store_manager"} value={storeName} onChange={(event) => setStoreName(event.target.value)} /></label>
            <label className="settings-field"><span>Store Address</span><input disabled={profile?.role !== "admin" && profile?.role !== "store_manager"} value={storeAddress} onChange={(event) => setStoreAddress(event.target.value)} /></label>
            <label className="settings-field"><span>Contact Number</span><input disabled={profile?.role !== "admin" && profile?.role !== "store_manager"} value={contactNumber} onChange={(event) => setContactNumber(event.target.value)} /></label>
            <label className="settings-field"><span>Email Address</span><input type="email" disabled={profile?.role !== "admin" && profile?.role !== "store_manager"} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <div className="settings-field settings-logo-row"><span>Store Logo</span><div>
              <button type="button" className="settings-logo-preview" disabled={profile?.role !== "admin" && profile?.role !== "store_manager"} onClick={() => logoInput.current?.click()}>
                {storeLogoPreview ? <img src={storeLogoPreview} alt="Store logo preview" /> : <Leaf size={25} />}
                <b>{logoName || "WasteWise"}<small>Store preview</small></b>
              </button>
              {(profile?.role === "admin" || profile?.role === "store_manager") && <button type="button" className="settings-secondary-button" onClick={() => logoInput.current?.click()}>Change Logo</button>}
              <input
                ref={logoInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
                    const message = "Only PNG, JPG, JPEG, and WebP images are supported.";
                    setStoreSettingsError(message);
                    onNotify(message);
                    event.target.value = "";
                    return;
                  }
                  if (file.size > 2 * 1024 * 1024) {
                    const message = "Logo image must be 2 MB or smaller.";
                    setStoreSettingsError(message);
                    onNotify(message);
                    event.target.value = "";
                    return;
                  }
                  setStoreLogoFile(file);
                  setLogoName(file.name.replace(/\.[^.]+$/, ""));
                  setStoreLogoPreview(URL.createObjectURL(file));
                  setStoreSettingsError("");
                  onNotify("Store logo selected.");
                }}
              />
            </div><small>Recommended size: 200 x 200 px · PNG, JPG, JPEG, or WebP</small></div>
          </div>
          {(profile?.role === "admin" || profile?.role === "store_manager") && <SaveButton onClick={() => { void saveStoreSettings(); }} disabled={savingStoreSettings} label={savingStoreSettings ? "Saving…" : "Save Changes"} />}
        </section>

        <section className="settings-card notification-settings-card" id="notification-settings">
          <SettingsCardHeading icon={<Bell size={23} />} title="Notification Settings" description="Manage alerts and notifications" />
          {notificationSettingsError && <p className="settings-error" role="alert">{notificationSettingsError}</p>}
          <div className="notification-list">{notificationItems.map((item) => <div className="notification-setting-row" key={item.key}><span className={`notification-setting-icon ${item.tone}`}>{item.key === "expiry_alerts" ? "▣" : item.key === "low_stock_alerts" ? "⬡" : item.key === "high_demand_alerts" ? "⌁" : item.key === "daily_reports" ? "▤" : item.key === "weekly_insights" ? "✉" : "●"}</span><div><b>{item.title}</b><small>{item.description}</small></div><button type="button" role="switch" aria-checked={notifications[item.key]} aria-label={`${item.title} notifications`} className={`settings-switch ${notifications[item.key] ? "on" : ""}`} disabled={loadingNotificationSettings || savingNotificationSettings} onClick={() => toggleNotification(item.key)}><i /></button></div>)}</div>
          <SaveButton onClick={() => { void saveNotificationSettings(); }} disabled={loadingNotificationSettings || savingNotificationSettings} label={savingNotificationSettings ? "Saving…" : "Save Changes"} />
        </section>

        {profile?.role === "admin" && <section className="settings-card backup-settings-card" id="backup-settings">
          <SettingsCardHeading icon={<Database size={23} />} title="Data & Backup" description="Import, export, and securely back up database records" />
          <DataTransferPanel onNotify={onNotify} canImport canExport />
          <DatabaseBackupPanel onNotify={onNotify} canManageBackups />
        </section>}

        <section className="settings-card model-settings-card" id="model-settings">
          <SettingsCardHeading icon={<BarChart3 size={23} />} title="Model Settings" description="Configure ML model parameters" />
          <div className="settings-fields model-settings-fields">
            <SelectField label="Demand Forecast Model" value={forecastModel} options={["Random Forest", "XGBoost", "Linear Regression"]} onChange={setForecastModel} />
            <SelectField label="Forecast Period (Days)" value={forecastPeriod} options={["7", "14", "30", "60", "90"]} onChange={setForecastPeriod} />
            <SelectField label="Expiry Risk Threshold (Days)" value={expiryThreshold} options={["3", "5", "7", "10", "14"]} onChange={setExpiryThreshold} />
            <SelectField label="Discount Recommendation" value={discountModel} options={["Gradient Boosting", "Random Forest", "XGBoost"]} onChange={setDiscountModel} />
            <label className="settings-field"><span>Minimum Discount (%)</span><input type="number" min="0" max="100" value={minimumDiscount} onChange={(event) => setMinimumDiscount(event.target.value)} /></label>
            <label className="settings-field"><span>Maximum Discount (%)</span><input type="number" min="0" max="100" value={maximumDiscount} onChange={(event) => setMaximumDiscount(event.target.value)} /></label>
          </div>
          {canManageShelfLife && <div className="settings-shelf-life">
            <SettingsCardHeading icon={<CalendarDays size={19} />} title="Category Shelf Life" description="Live defaults used for expiry estimates" />
            <div className="settings-fields">
              {shelfLifeSettings.map((setting) => <label className="settings-field" key={setting.category}>
                <span>{setting.category} (days)</span>
                <div className="settings-select-wrap">
                  <input type="number" min="1" max="3650" step="1" value={shelfLifeDays[setting.category] ?? String(setting.days)} onChange={(event) => setShelfLifeDays((current) => ({ ...current, [setting.category]: event.target.value }))} />
                  <button type="button" className="settings-save-button" onClick={() => { void saveShelfLifeSetting(setting.category); }}><Save size={13} /> Save</button>
                </div>
              </label>)}
            </div>
            {shelfLifeSettings.length === 0 && <p className="form-field-note">No category shelf-life settings are available.</p>}
          </div>}
          <SaveButton onClick={() => saveSettings("Model")} />
        </section>

        <section className="settings-card preference-settings-card" id="system-preferences">
          <SettingsCardHeading icon={<SlidersHorizontal size={22} />} title="System Preferences" description="Application behavior and regional defaults" />
          <div className="preferences-fields">
            <SelectField label="Currency" value={currency} options={["Indian Rupee (₹)", "US Dollar ($)", "Euro (€)", "British Pound (£)"]} onChange={setCurrency} />
            <SelectField label="Weight Unit" value={weightUnit} options={["Kilograms (kg)", "Pounds (lb)"]} onChange={setWeightUnit} />
            <SelectField label="Default View" value={defaultView} options={["Dashboard", "Inventory", "Demand Forecast"]} onChange={setDefaultView} />
          </div>
          <SaveButton onClick={() => saveSettings("System preference")} />
        </section>

        <section className="settings-card security-settings-card" id="security-settings">
          <SettingsCardHeading icon={<ShieldCheck size={21} />} title="Security Settings" description="Change your password after verifying your current credentials" />
          {passwordChangeError && <p className="settings-general-error" role="alert">{passwordChangeError}</p>}
          <div className="settings-fields">
            <label className="settings-field"><span>Current Password</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={changingPassword} /></label>
            <label className="settings-field"><span>New Password</span><input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={changingPassword} /></label>
            <label className="settings-field"><span>Confirm New Password</span><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={changingPassword} /></label>
          </div>
          <SaveButton onClick={() => { void savePasswordChange(); }} disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword} label={changingPassword ? "Changing…" : "Change Password"} />
        </section>

        <section className="settings-card appearance-settings-card" id="appearance-settings">
          <SettingsCardHeading icon={<Palette size={22} />} title="Appearance" description="Choose visual preferences for this workspace" />
          <div className="settings-fields">
            <SelectField label="Theme" value={theme} options={["Light (Default)", "Dark", "System"]} onChange={setTheme} />
            <SelectField label="Inventory Chart Palette" value={chartTheme} options={[{ value: "green", label: "Green (Default)" }, { value: "blue", label: "Blue" }, { value: "purple", label: "Purple" }]} onChange={(value) => setChartTheme(value as ChartColorTheme)} />
            <SelectField label="Accent Color" value={accentColor} options={[{ value: "green", label: "WasteWise Green" }, { value: "blue", label: "Ocean Blue" }, { value: "purple", label: "Royal Purple" }, { value: "orange", label: "Warm Orange" }]} onChange={(value) => setAccentColor(value as AccentColor)} />
            <SelectField label="Corner Style" value={cornerStyle} options={[{ value: "soft", label: "Soft (Default)" }, { value: "square", label: "Square" }]} onChange={(value) => setCornerStyle(value as CornerStyle)} />
          </div>
          <div className="appearance-preview" aria-hidden="true">
            <span className="appearance-preview-sidebar"><i /><i /><i /></span>
            <span className="appearance-preview-content"><i /><i /><i /></span>
            <span className="appearance-preview-caption"><Leaf size={14} /> Preview updates when you save</span>
          </div>
          <SaveButton onClick={() => saveSettings("Appearance")} />
        </section>
      </div>
    </div>
  );
}
