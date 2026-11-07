import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NotificationCenter from "./NotificationCenter";
import * as notifications from "../services/notifications";

vi.mock("../services/notifications", () => ({
  listNotifications: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  setNotificationRead: vi.fn(),
}));

const notificationRecord: notifications.NotificationItem = {
  notification_id: 42,
  title: "Product nearing expiry",
  description: "Fresh Greens, batch EG-1, expires soon.",
  category: "expiry",
  priority: "high",
  occurred_at: "2026-11-06T12:00:00Z",
  is_read: false,
};

describe("NotificationCenter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(notifications.listNotifications).mockResolvedValue({
      items: [notificationRecord],
      total: 1,
      unread_count: 1,
      read_count: 0,
    });
    vi.mocked(notifications.setNotificationRead).mockResolvedValue({ ...notificationRecord, is_read: true });
    vi.mocked(notifications.markAllNotificationsRead).mockResolvedValue();
  });

  it("shows actual notification details, role-based filters, timestamp, and unread count", async () => {
    render(<NotificationCenter isAdmin={false} onNotify={vi.fn()} />);

    expect(await screen.findByText("Product nearing expiry")).toBeInTheDocument();
    expect(screen.getByText("Fresh Greens, batch EG-1, expires soon.")).toBeInTheDocument();
    expect(screen.getAllByText("Expiry").length).toBeGreaterThan(0);
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("Total").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Unread", { selector: "span" }).parentElement).toHaveTextContent("1");
    expect(screen.getByText("Read", { selector: "span" }).parentElement).toHaveTextContent("0");
    expect(screen.getByLabelText("Category")).not.toHaveTextContent("System");
    expect(notifications.listNotifications).toHaveBeenCalledWith({
      category: "",
      read_status: "all",
      limit: 20,
      offset: 0,
    });
  });

  it("filters by category and read state", async () => {
    render(<NotificationCenter isAdmin onNotify={vi.fn()} />);
    await screen.findByText("Product nearing expiry");

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "import" } });
    await waitFor(() => expect(notifications.listNotifications).toHaveBeenLastCalledWith({
      category: "import",
      read_status: "all",
      limit: 20,
      offset: 0,
    }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "read" } });
    await waitFor(() => expect(notifications.listNotifications).toHaveBeenLastCalledWith({
      category: "import",
      read_status: "read",
      limit: 20,
      offset: 0,
    }));
  });

  it("loads separate pages and resets to the first page when filters change", async () => {
    vi.mocked(notifications.listNotifications).mockImplementation(async (params) => ({
      items: [{
        ...notificationRecord,
        notification_id: params?.offset ? 43 : 42,
        title: params?.offset ? "Second page notification" : "Product nearing expiry",
      }],
      total: 21,
      unread_count: 21,
      read_count: 0,
    }));
    render(<NotificationCenter isAdmin onNotify={vi.fn()} />);

    expect(await screen.findByText("Product nearing expiry")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next notification page" }));
    expect(await screen.findByText("Second page notification")).toBeInTheDocument();
    await waitFor(() => expect(notifications.listNotifications).toHaveBeenLastCalledWith({
      category: "",
      read_status: "all",
      limit: 20,
      offset: 20,
    }));

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "expiry" } });
    await waitFor(() => expect(notifications.listNotifications).toHaveBeenLastCalledWith({
      category: "expiry",
      read_status: "all",
      limit: 20,
      offset: 0,
    }));
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
  });

  it("marks an individual notification and all notifications as read", async () => {
    const notify = vi.fn();
    render(<NotificationCenter isAdmin onNotify={notify} />);
    await screen.findByText("Product nearing expiry");

    fireEvent.click(screen.getByRole("button", { name: "Mark Product nearing expiry read" }));
    await waitFor(() => expect(notifications.setNotificationRead).toHaveBeenCalledWith(42, true));

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(notifications.markAllNotificationsRead).toHaveBeenCalledOnce());
    expect(notify).toHaveBeenCalledWith("All notifications marked as read.");
  });

  it("shows the backend failure instead of presenting a healthy empty list", async () => {
    vi.mocked(notifications.listNotifications).mockRejectedValueOnce(new Error("Notifications are unavailable."));
    const notify = vi.fn();
    render(<NotificationCenter isAdmin onNotify={notify} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Notifications are unavailable.");
    expect(notify).toHaveBeenCalledWith("Notifications are unavailable.");
    expect(screen.queryByText("No notifications to show")).not.toBeInTheDocument();
  });
});
