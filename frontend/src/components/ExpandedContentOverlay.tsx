import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const expandableSelector = "main .dashboard-page .dashboard-chart-card, main .batch-page .batch-chart-card, main .waste-reports-page .waste-chart-card, main .inventory-page .category-value-card";

type AttributeSnapshot = Record<"role" | "aria-modal" | "aria-label", string | null>;

function containerTitle(element: HTMLElement): string {
  const heading = element.querySelector("h1, h2, h3, [role='heading']");
  return heading?.textContent?.trim() || element.getAttribute("aria-label") || "Expanded content";
}

export default function ExpandedContentOverlay() {
  const [content, setContent] = useState<HTMLElement | null>(null);
  const [closing, setClosing] = useState(false);
  const contentRef = useRef<HTMLElement | null>(null);
  const attributesRef = useRef<AttributeSnapshot | null>(null);
  const closeTimer = useRef<number | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  function restoreContainer(element: HTMLElement) {
    element.classList.remove("expandable-container--expanded", "is-closing");
    const attributes = attributesRef.current;
    if (attributes) {
      Object.entries(attributes).forEach(([name, value]) => {
        if (value === null) element.removeAttribute(name);
        else element.setAttribute(name, value);
      });
    }
    attributesRef.current = null;
  }

  function close() {
    const activeElement = contentRef.current;
    if (!activeElement || closeTimer.current !== null) return;
    setClosing(true);
    activeElement.classList.add("is-closing");
    closeTimer.current = window.setTimeout(() => {
      restoreContainer(activeElement);
      contentRef.current = null;
      closeTimer.current = null;
      setContent(null);
      setClosing(false);
      returnFocus.current?.focus();
    }, 180);
  }

  useEffect(() => {
    const root = document.querySelector("main");
    if (!root) return;

    const markContainers = (scope: ParentNode) => {
      scope.querySelectorAll<HTMLElement>(expandableSelector).forEach((element) => {
        if (element === root || element.hasAttribute("data-expandable")) return;
        element.classList.add("expandable-container");
        element.setAttribute("data-expandable", "true");
      });
    };

    markContainers(root);
    const observer = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          markContainers(node);
          if (node.matches(expandableSelector)) markContainers(node.parentElement ?? root);
        }
      }));
    });
    observer.observe(root, { childList: true, subtree: true });

    const openFromTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element) || target.closest(".expanded-content-overlay")) return;
      if (target.closest("button, a, input, select, textarea, [role='button'], [contenteditable='true']")) return;
      const container = target.closest<HTMLElement>("[data-expandable='true']");
      if (!container || contentRef.current) return;

      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      attributesRef.current = {
        role: container.getAttribute("role"),
        "aria-modal": container.getAttribute("aria-modal"),
        "aria-label": container.getAttribute("aria-label"),
      };
      container.setAttribute("role", "dialog");
      container.setAttribute("aria-modal", "true");
      container.setAttribute("aria-label", containerTitle(container));
      container.classList.add("expandable-container--expanded");
      contentRef.current = container;
      setContent(container);
      setClosing(false);
    };

    const handleDoubleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)
        || event.target.closest("button, a, input, select, textarea, [role='button'], [contenteditable='true']")
        || !event.target.closest("[data-expandable='true']")) return;
      event.preventDefault();
      event.stopPropagation();
      openFromTarget(event.target);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (contentRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLElement) {
        const container = event.target.closest<HTMLElement>("[data-expandable='true']");
        if (container && event.target === container) {
          event.preventDefault();
          openFromTarget(container);
        }
      }
    };

    document.addEventListener("dblclick", handleDoubleClick, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      observer.disconnect();
      document.removeEventListener("dblclick", handleDoubleClick, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!content) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.querySelector<HTMLButtonElement>(".expanded-content-close")?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [content]);

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    if (contentRef.current) restoreContainer(contentRef.current);
  }, []);

  if (!content) return null;

  return createPortal(
    <>
      <div
        className={`expanded-content-overlay${closing ? " is-closing" : ""}`}
        aria-hidden="true"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      />
      <button
        className="expanded-content-close"
        type="button"
        aria-label="Close expanded content"
        onClick={close}
      >
        <X size={20} />
      </button>
    </>,
    document.body,
  );
}
