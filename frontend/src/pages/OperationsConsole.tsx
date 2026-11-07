import { useEffect, useState } from "react";
import { Activity, Bell, ClipboardList, Layers3 } from "lucide-react";
import AuditLogs from "./AuditLogs";
import NotificationCenter from "./NotificationCenter";
import SystemHealth from "./SystemHealth";

export type OperationsSection = "audit" | "notifications" | "health";

const SECTIONS: { id: OperationsSection; label: string; icon: typeof ClipboardList }[] = [
  { id: "audit", label: "Audit Logs", icon: ClipboardList },
  { id: "notifications", label: "Notification Center", icon: Bell },
  { id: "health", label: "System Health", icon: Activity },
];

export default function OperationsConsole({
  isAdmin,
  onNotify,
  initialSection = "audit",
}: {
  isAdmin: boolean;
  onNotify: (message: string) => void;
  initialSection?: OperationsSection;
}) {
  const [selectedSection, setSelectedSection] = useState(initialSection);

  useEffect(() => {
    setSelectedSection(initialSection);
    if (initialSection === "audit") return;
    requestAnimationFrame(() => {
      document.getElementById(`operations-${initialSection}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [initialSection]);

  function selectSection(section: OperationsSection) {
    setSelectedSection(section);
    document.getElementById(`operations-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="operations-console">
      <header className="operations-console-banner">
        <div className="operations-console-mark" aria-hidden="true"><Layers3 size={28} /></div>
        <div>
          <span className="eyebrow">WASTEWISE AI • STORE OPERATIONS</span>
          <h1>Operations Console</h1>
          <p>Audit activity, notifications and system status in one place.</p>
        </div>
      </header>

      <nav className="operations-console-tabs" aria-label="Operations Console sections">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            className={selectedSection === id ? "active" : ""}
            aria-current={selectedSection === id ? "location" : undefined}
            aria-controls={`operations-${id}`}
            onClick={() => selectSection(id)}
          >
            <Icon size={16} aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>

      <section id="operations-audit" className="operations-console-section" aria-labelledby="operations-audit-heading">
        <h2 id="operations-audit-heading"><ClipboardList size={18} /> Audit Logs</h2>
        <AuditLogs onNotify={onNotify} compact />
      </section>

      <section id="operations-notifications" className="operations-console-section" aria-labelledby="operations-notifications-heading">
        <h2 id="operations-notifications-heading"><Bell size={18} /> Notification Center</h2>
        <NotificationCenter isAdmin={isAdmin} onNotify={onNotify} compact />
      </section>

      <section id="operations-health" className="operations-console-section" aria-labelledby="operations-health-heading">
        <h2 id="operations-health-heading"><Activity size={18} /> System Health</h2>
        <SystemHealth onNotify={onNotify} isAdmin={isAdmin} compact />
      </section>
    </div>
  );
}
