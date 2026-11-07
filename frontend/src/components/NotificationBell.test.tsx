import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NotificationBell from "./NotificationBell";
import * as notifications from "../services/notifications";

vi.mock("../services/notifications", () => ({
  listNotifications: vi.fn(),
}));

describe("NotificationBell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(notifications.listNotifications).mockResolvedValue({
      items: [],
      total: 3,
      unread_count: 3,
      read_count: 0,
    });
  });

  it("shows unread count, navigates to the center, and refreshes after read state changes", async () => {
    const onOpen = vi.fn();
    render(<NotificationBell onOpen={onOpen} onNotify={vi.fn()} />);

    const button = await screen.findByRole("button", { name: "Notifications, 3 unread" });
    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();

    vi.mocked(notifications.listNotifications).mockResolvedValueOnce({
      items: [],
      total: 3,
      unread_count: 1,
      read_count: 2,
    });
    window.dispatchEvent(new Event("wastewise:notifications-changed"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeInTheDocument());
  });
});
