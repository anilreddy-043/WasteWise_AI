import { useSyncExternalStore } from "react";

export type GeneralSettings = {
  application_name: string;
  timezone: string;
  date_format: "DD MMM YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
  language: "en" | "hi" | "te" | "mr";
  items_per_page: 10 | 20 | 50 | 100;
};

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  application_name: "WasteWise AI",
  timezone: "Asia/Kolkata",
  date_format: "DD MMM YYYY",
  language: "en",
  items_per_page: 10,
};

let currentSettings = DEFAULT_GENERAL_SETTINGS;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): GeneralSettings {
  return currentSettings;
}

export function useGeneralSettings(): GeneralSettings {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function getCurrentGeneralSettings(): GeneralSettings {
  return currentSettings;
}

export function configureGeneralSettings(settings: GeneralSettings): void {
  currentSettings = settings;
  listeners.forEach((listener) => listener());
}

function parseDate(value: string | Date): { date: Date; dateOnly: boolean } {
  if (value instanceof Date) return { date: value, dateOnly: false };
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return { date: new Date(dateOnly ? `${value}T12:00:00Z` : value), dateOnly };
}

function dateParts(value: string | Date): { day: string; month: string; year: string; date: Date; dateOnly: boolean } {
  const { date, dateOnly } = parseDate(value);
  const parts = new Intl.DateTimeFormat(currentSettings.language === "en" ? "en-IN" : `${currentSettings.language}-IN`, {
    day: "2-digit",
    month: currentSettings.date_format === "DD MMM YYYY" ? "short" : "2-digit",
    year: "numeric",
    timeZone: dateOnly ? "UTC" : currentSettings.timezone,
  }).formatToParts(date);
  return {
    day: parts.find((part) => part.type === "day")?.value ?? "",
    month: parts.find((part) => part.type === "month")?.value ?? "",
    year: parts.find((part) => part.type === "year")?.value ?? "",
    date,
    dateOnly,
  };
}

export function formatAppDate(value: string | Date): string {
  const { day, month, year } = dateParts(value);
  if (currentSettings.date_format === "YYYY-MM-DD") return `${year}-${month}-${day}`;
  if (currentSettings.date_format === "MM/DD/YYYY") return `${month}/${day}/${year}`;
  return `${day} ${month} ${year}`;
}

export function formatAppDateTime(value: string | Date): string {
  const { date, dateOnly } = parseDate(value);
  const time = new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: dateOnly ? "UTC" : currentSettings.timezone,
  }).format(date);
  return `${formatAppDate(value)} ${time}`;
}

export function formatAppTime(value: string | Date): string {
  const { date, dateOnly } = parseDate(value);
  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: dateOnly ? "UTC" : currentSettings.timezone,
  }).format(date);
}
