import { requestAuthenticatedJson } from "./auth";

export type NotificationCategory = "expiry" | "inventory" | "demand" | "import" | "system";
export type NotificationPriority = "low" | "medium" | "high" | "critical";
export type NotificationReadFilter = "all" | "read" | "unread";

export type NotificationItem = {
  notification_id: number;
  title: string;
  description: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  occurred_at: string;
  is_read: boolean;
};

export type NotificationPageResponse = {
  items: NotificationItem[];
  total: number;
  unread_count: number;
  read_count: number;
};

export type NotificationFilters = {
  category?: NotificationCategory | "";
  read_status?: NotificationReadFilter;
  limit?: number;
  offset?: number;
};

export async function listNotifications(filters: NotificationFilters = {}): Promise<NotificationPageResponse> {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.read_status && filters.read_status !== "all") params.set("read_status", filters.read_status);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));
  const query = params.size ? `?${params.toString()}` : "";
  return requestAuthenticatedJson<NotificationPageResponse>(`/api/v1/notifications${query}`);
}

export async function setNotificationRead(notificationId: number, is_read: boolean): Promise<NotificationItem> {
  return requestAuthenticatedJson<NotificationItem>(`/api/v1/notifications/${notificationId}/read`, {
    method: "PATCH",
    body: JSON.stringify({ is_read }),
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  await requestAuthenticatedJson<void>("/api/v1/notifications/read-all", { method: "POST" });
}
