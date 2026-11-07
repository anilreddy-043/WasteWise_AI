import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken, setAccessToken } from "./auth";
import { listNotifications, markAllNotificationsRead, setNotificationRead } from "./notifications";

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  sessionStorage.clear();
});

describe("notification API client", () => {
  it("requests notifications with category, read state, and pagination filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [],
      total: 0,
      unread_count: 0,
      read_count: 0,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("notification-token", 60);

    await listNotifications({ category: "expiry", read_status: "unread", limit: 25, offset: 50 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/notifications?category=expiry&read_status=unread&limit=25&offset=50");
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer notification-token");
  });

  it("uses the authenticated read-state endpoints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        notification_id: 8,
        title: "Expiry approaching",
        description: "Live batch expiry",
        category: "expiry",
        priority: "high",
        occurred_at: "2026-11-06T00:00:00Z",
        is_read: true,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("notification-token", 60);

    await expect(setNotificationRead(8, true)).resolves.toMatchObject({ is_read: true });
    await expect(markAllNotificationsRead()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/notifications/8/read");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/notifications/read-all");
  });
});
