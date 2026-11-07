import { afterEach, describe, expect, it } from "vitest";
import {
  configureGeneralSettings,
  DEFAULT_GENERAL_SETTINGS,
  formatAppDate,
  formatAppDateTime,
} from "./generalSettings";

afterEach(() => {
  configureGeneralSettings(DEFAULT_GENERAL_SETTINGS);
});

describe("general settings date formatting", () => {
  it("uses the saved date format", () => {
    configureGeneralSettings({
      ...DEFAULT_GENERAL_SETTINGS,
      date_format: "YYYY-MM-DD",
    });

    expect(formatAppDate("2026-03-07")).toBe("2026-03-07");
  });

  it("uses the saved timezone when formatting timestamps", () => {
    const timestamp = "2026-03-07T01:30:00Z";
    configureGeneralSettings({
      ...DEFAULT_GENERAL_SETTINGS,
      timezone: "America/Los_Angeles",
      date_format: "MM/DD/YYYY",
    });

    const formatted = formatAppDateTime(timestamp);
    expect(formatted).toContain("03/06/2026");
    expect(formatted).toMatch(/05:30/i);
  });
});
