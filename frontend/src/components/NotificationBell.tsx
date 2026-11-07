import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { listNotifications } from "../services/notifications";

type Props = {
  onOpen: () => void;
  onNotify: (message: string) => void;
};

export default function NotificationBell({ onOpen, onNotify }: Props) {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let active = true;
    const refreshCount = async () => {
      try {
        const response = await listNotifications({ limit: 1 });
        if (active) setUnreadCount(response.unread_count);
      } catch (error) {
        if (active) onNotify(error instanceof Error ? error.message : "Notification count could not be loaded.");
      }
    };
    const handleNotificationsChanged = () => void refreshCount();
    void refreshCount();
    const interval = window.setInterval(() => void refreshCount(), 60_000);
    window.addEventListener("wastewise:notifications-changed", handleNotificationsChanged);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("wastewise:notifications-changed", handleNotificationsChanged);
    };
  }, [onNotify]);

  return (
    <div className="notification-wrap">
      <button
        className="notification-button"
        type="button"
        aria-label={`Notifications, ${unreadCount} unread`}
        onClick={onOpen}
      >
        <Bell size={21} />
        {unreadCount > 0 && <span aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
    </div>
  );
}
