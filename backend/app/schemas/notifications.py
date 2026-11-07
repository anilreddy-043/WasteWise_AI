from datetime import datetime
from typing import Literal

from pydantic import BaseModel


NotificationCategory = Literal["expiry", "inventory", "demand", "import", "system"]
NotificationPriority = Literal["low", "medium", "high", "critical"]


class NotificationItem(BaseModel):
    notification_id: int
    title: str
    description: str
    category: NotificationCategory
    priority: NotificationPriority
    occurred_at: datetime
    is_read: bool


class NotificationPage(BaseModel):
    items: list[NotificationItem]
    total: int
    unread_count: int
    read_count: int


class NotificationReadUpdate(BaseModel):
    is_read: bool
