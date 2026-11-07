import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OperationsConsole from "./OperationsConsole";

vi.mock("./AuditLogs", () => ({ default: () => <div data-testid="audit-embed" /> }));
vi.mock("./NotificationCenter", () => ({ default: () => <div data-testid="notifications-embed" /> }));
vi.mock("./SystemHealth", () => ({ default: () => <div data-testid="health-embed" /> }));

describe("OperationsConsole", () => {
  it("renders all three sections and lets the section selectors navigate to them", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(<OperationsConsole isAdmin={false} onNotify={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Operations Console" })).toBeInTheDocument();
    expect(screen.getByTestId("audit-embed")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-embed")).toBeInTheDocument();
    expect(screen.getByTestId("health-embed")).toBeInTheDocument();

    const healthTab = screen.getByRole("button", { name: "System Health" });
    fireEvent.click(healthTab);
    expect(healthTab).toHaveAttribute("aria-current", "location");
    expect(scrollIntoView).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Notification Center" }));
    expect(screen.getByRole("button", { name: "Notification Center" })).toHaveAttribute("aria-current", "location");
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
