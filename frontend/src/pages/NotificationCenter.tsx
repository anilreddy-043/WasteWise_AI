import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bell, Check, CheckCheck, ChevronLeft, ChevronRight, Circle, RefreshCw } from "lucide-react";
import { formatAppDateTime } from "../services/generalSettings";
import {
  listNotifications,
  markAllNotificationsRead,
  setNotificationRead,
} from "../services/notifications";
import type {
  NotificationCategory,
  NotificationItem,
  NotificationReadFilter,
} from "../services/notifications";

type Props = {
  isAdmin: boolean;
  onNotify: (message: string) => void;
  compact?: boolean;
};

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  expiry: "Expiry",
  inventory: "Low stock",
  demand: "High demand",
  import: "Imports",
  system: "System",
};
const PAGE_SIZE = 20;

function NotificationCard({
  item,
  onToggleRead,
}: {
  item: NotificationItem;
  onToggleRead: (item: NotificationItem) => void;
}) {
  return (
    <article className={`notification-card ${item.is_read ? "read" : "unread"} priority-${item.priority}`}>
      <span className={`notification-priority-mark ${item.priority}`} aria-label={`${item.priority} priority`}>
        {item.priority === "critical" || item.priority === "high" ? <AlertTriangle size={18} /> : <Bell size={18} />}
      </span>
      <div className="notification-card-content">
        <div className="notification-card-heading">
          <strong>{item.title}</strong>
          <span className={`notification-category ${item.category}`}>{CATEGORY_LABELS[item.category]}</span>
          <span className={`notification-priority-label ${item.priority}`}>{item.priority}</span>
        </div>
        <p>{item.description}</p>
        <time dateTime={item.occurred_at}>{formatAppDateTime(item.occurred_at)}</time>
      </div>
      <button
        type="button"
        className="notification-read-toggle"
        onClick={() => onToggleRead(item)}
        aria-label={item.is_read ? `Mark ${item.title} unread` : `Mark ${item.title} read`}
        title={item.is_read ? "Mark unread" : "Mark read"}
      >
        {item.is_read ? <Circle size={17} /> : <Check size={17} />}
      </button>
    </article>
  );
}

export default function NotificationCenter({ isAdmin, onNotify, compact = false }: Props) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [category, setCategory] = useState<NotificationCategory | "">("");
  const [readStatus, setReadStatus] = useState<NotificationReadFilter>("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [readCount, setReadCount] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const loadNotifications = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const response = await listNotifications({
        category,
        read_status: readStatus,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      setItems(response.items);
      setTotal(response.total);
      setUnreadCount(response.unread_count);
      setReadCount(typeof response.read_count === "number" ? response.read_count : null);
      window.dispatchEvent(new Event("wastewise:notifications-changed"));
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Notifications could not be loaded.";
      setError(message);
      onNotify(message);
    } finally {
      setIsLoading(false);
    }
  }, [category, readStatus, page, onNotify]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  async function toggleRead(item: NotificationItem) {
    try {
      await setNotificationRead(item.notification_id, !item.is_read);
      window.dispatchEvent(new Event("wastewise:notifications-changed"));
      await loadNotifications();
    } catch (updateError) {
      onNotify(updateError instanceof Error ? updateError.message : "Notification status could not be updated.");
    }
  }

  async function markAllRead() {
    try {
      await markAllNotificationsRead();
      window.dispatchEvent(new Event("wastewise:notifications-changed"));
      await loadNotifications();
      onNotify("All notifications marked as read.");
    } catch (updateError) {
      onNotify(updateError instanceof Error ? updateError.message : "Notifications could not be marked as read.");
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className={`notification-center-page ${compact ? "notification-center-compact" : ""}`}>
      {!compact && <section className="page-banner notification-center-banner">
        <div className="banner-copy">
          <span className="eyebrow">LIVE ACCOUNT ALERTS</span>
          <h1>Notification Center</h1>
          <p>Operational and system notifications from your WasteWise data</p>
        </div>
        <div className="notification-center-banner-icon" aria-hidden="true"><Bell size={48} /></div>
      </section>}

      <section className="notification-center-toolbar" aria-label="Notification filters">
        <div className="notification-center-counts" aria-label="Notification counts">
          <div className="notification-center-count">
            <strong>{readCount === null ? "—" : unreadCount + readCount}</strong><span>Total</span>
          </div>
          <div className="notification-center-count">
            <strong>{unreadCount}</strong><span>Unread</span>
          </div>
          <div className="notification-center-count">
            <strong>{readCount ?? "—"}</strong><span>Read</span>
          </div>
        </div>
        <label><span>Category</span>
          <select value={category} onChange={(event) => { setPage(1); setCategory(event.target.value as NotificationCategory | ""); }}>
            <option value="">All categories</option>
            <option value="expiry">Expiry</option>
            <option value="inventory">Low stock</option>
            <option value="demand">High demand</option>
            {isAdmin && <option value="import">Imports</option>}
            {isAdmin && <option value="system">System</option>}
          </select>
        </label>
        <label><span>Status</span>
          <select value={readStatus} onChange={(event) => { setPage(1); setReadStatus(event.target.value as NotificationReadFilter); }}>
            <option value="all">All</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
        </label>
        <button type="button" className="notification-refresh-button" onClick={() => void loadNotifications()} disabled={isLoading}>
          <RefreshCw size={15} className={isLoading ? "spinning" : ""} /> Refresh
        </button>
        <button type="button" className="notification-mark-all-button" onClick={() => void markAllRead()} disabled={isLoading || unreadCount === 0}>
          <CheckCheck size={15} /> Mark all read
        </button>
      </section>

      {error && <p className="notification-center-error" role="alert">{error}</p>}
      {isLoading && items.length === 0 ? <p className="notification-center-empty" role="status">Loading notifications…</p> : items.length ? (
        <section className="notification-list" aria-label="Notifications">
          {items.map((item) => <NotificationCard key={item.notification_id} item={item} onToggleRead={(selected) => void toggleRead(selected)} />)}
        </section>
      ) : !error ? (
        <section className="notification-center-empty">
          <span><Bell size={27} /></span>
          <h2>No notifications to show</h2>
          <p>Current alerts will appear here when live inventory or system activity meets your notification preferences.</p>
        </section>
      ) : null}
      {total > PAGE_SIZE && (
        <nav className="notification-pagination" aria-label="Notification pages">
          <span>Page {page} of {totalPages}</span>
          <button
            type="button"
            aria-label="Previous notification page"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page <= 1 || isLoading}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            aria-label="Next notification page"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page >= totalPages || isLoading}
          >
            <ChevronRight size={16} />
          </button>
        </nav>
      )}
    </div>
  );
}
