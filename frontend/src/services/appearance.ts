export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export type ChartColorTheme = "green" | "blue" | "purple";
export type AccentColor = "green" | "blue" | "purple" | "orange";
export type CornerStyle = "soft" | "square";

export type AppearancePreferences = {
	chartColorTheme: ChartColorTheme;
	accentColor: AccentColor;
	cornerStyle: CornerStyle;
};

const THEME_STORAGE_KEY = "wastewise.theme";
const THEME_CHANGE_EVENT = "wastewise:theme-changed";
const CHART_COLOR_THEME_STORAGE_KEY = "wastewise.chart-color-theme";
const ACCENT_COLOR_STORAGE_KEY = "wastewise.accent-color";
const CORNER_STYLE_STORAGE_KEY = "wastewise.corner-style";

const defaultAppearancePreferences: AppearancePreferences = {
	chartColorTheme: "green",
	accentColor: "green",
	cornerStyle: "soft",
};

export function getThemePreference(): ThemePreference {
	try {
		const preference = localStorage.getItem(THEME_STORAGE_KEY);
		return preference === "light" || preference === "dark" || preference === "system"
			? preference
			: "light";
	} catch {
		return "light";
	}
}

export function getResolvedTheme(preference = getThemePreference()): ResolvedTheme {
	if (preference !== "system") return preference;
	return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyThemePreference(preference: ThemePreference): void {
	const theme = getResolvedTheme(preference);
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
	document.querySelector('meta[name="theme-color"]')?.setAttribute(
		"content",
		theme === "dark" ? "#101b16" : "#004332",
	);
}

export function getAppearancePreferences(): AppearancePreferences {
	try {
		const chartColorTheme = localStorage.getItem(CHART_COLOR_THEME_STORAGE_KEY);
		const accentColor = localStorage.getItem(ACCENT_COLOR_STORAGE_KEY);
		const cornerStyle = localStorage.getItem(CORNER_STYLE_STORAGE_KEY);
		return {
			chartColorTheme: chartColorTheme === "blue" || chartColorTheme === "purple"
				? chartColorTheme
				: defaultAppearancePreferences.chartColorTheme,
			accentColor: accentColor === "blue" || accentColor === "purple" || accentColor === "orange"
				? accentColor
				: defaultAppearancePreferences.accentColor,
			cornerStyle: cornerStyle === "square" ? "square" : defaultAppearancePreferences.cornerStyle,
		};
	} catch {
		return defaultAppearancePreferences;
	}
}

export function applyAppearancePreferences(preferences = getAppearancePreferences()): void {
	document.documentElement.dataset.chartTheme = preferences.chartColorTheme;
	document.documentElement.dataset.accentColor = preferences.accentColor;
	document.documentElement.dataset.cornerStyle = preferences.cornerStyle;
}

export function saveAppearancePreferences(preferences: AppearancePreferences): void {
	localStorage.setItem(CHART_COLOR_THEME_STORAGE_KEY, preferences.chartColorTheme);
	localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, preferences.accentColor);
	localStorage.setItem(CORNER_STYLE_STORAGE_KEY, preferences.cornerStyle);
	applyAppearancePreferences(preferences);
}

export function setThemePreference(preference: ThemePreference): void {
	localStorage.setItem(THEME_STORAGE_KEY, preference);
	applyThemePreference(preference);
	window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: preference }));
}

export function themeChangeEventName(): string {
	return THEME_CHANGE_EVENT;
}
