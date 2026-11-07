import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExpandedContentOverlay from "./ExpandedContentOverlay";

afterEach(() => {
  document.body.style.overflow = "";
});

function renderOverlay(onAction = vi.fn()) {
  return render(
    <>
      <main>
        <div className="dashboard-page">
          <section className="dashboard-kpis"><article className="dashboard-kpi"><h2>Sales KPI</h2></article></section>
          <section className="dashboard-chart-grid">
            <article className="dashboard-card dashboard-chart-card" aria-label="Sales trend chart" tabIndex={0}>
              <h2>Sales trend</h2>
              <svg role="img" aria-label="Sales values"><text>Actual values</text></svg>
              <button type="button" onClick={onAction}>Toggle sales</button>
            </article>
          </section>
          <section className="products-panel">
            <h2>Products</h2>
            <table><tbody><tr><td>Apple</td></tr></tbody></table>
          </section>
        </div>
        <div className="batch-page">
          <article className="batch-stat-card"><h2>Total Batches</h2></article>
          <section className="batch-bottom-card batch-distribution-card batch-chart-card" aria-label="Batch Status Distribution chart" tabIndex={0}>
            <h2>Batch Status Distribution</h2>
            <svg role="img" aria-label="Batch distribution"><text>Batch values</text></svg>
            <button type="button" onClick={onAction}>Batch chart action</button>
          </section>
          <article className="batch-list-card"><table><tbody><tr><td>LOT-1</td></tr></tbody></table></article>
        </div>
        <div className="waste-reports-page">
          <section aria-label="Waste analytics">
            <article className="waste-chart-card waste-trend-card" tabIndex={0}>
              <h2>Waste Trend</h2>
              <svg role="img" aria-label="Waste values"><text>Expired values</text></svg>
            </article>
          </section>
        </div>
      </main>
      <ExpandedContentOverlay />
    </>,
  );
}

describe("ExpandedContentOverlay", () => {
  it("opens the live container and closes with the close button", async () => {
    const onAction = vi.fn();
    renderOverlay(onAction);
    const container = document.querySelector(".dashboard-chart-card") as HTMLElement;

    fireEvent.doubleClick(container);

    const dialog = await screen.findByRole("dialog", { name: "Sales trend" });
    expect(dialog).toBe(container);
    expect(dialog).toHaveTextContent("Actual values");
    expect(document.body.style.overflow).toBe("hidden");
    expect(container).toHaveAttribute("tabindex", "0");

    fireEvent.click(screen.getByRole("button", { name: "Toggle sales" }));
    expect(onAction).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Close expanded content" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe("");
    expect(container).not.toHaveClass("expandable-container--expanded");
  });

  it("closes with Escape or a click outside and ignores nested expansion", async () => {
    renderOverlay();
    const card = document.querySelector(".dashboard-chart-card") as HTMLElement;
    fireEvent.doubleClick(card);
    const dialog = await screen.findByRole("dialog", { name: "Sales trend" });

    fireEvent.doubleClick(dialog.querySelector("svg") as SVGElement);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.doubleClick(document.querySelector(".products-panel") as HTMLElement);
    fireEvent.doubleClick(document.querySelector(".dashboard-kpi") as HTMLElement);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.doubleClick(card);
    await screen.findByRole("dialog", { name: "Sales trend" });
    fireEvent.mouseDown(document.querySelector(".expanded-content-overlay") as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens containers with Enter when keyboard focused", async () => {
    renderOverlay();
    const card = document.querySelector(".dashboard-chart-card") as HTMLElement;
    await waitFor(() => expect(card).toHaveAttribute("tabindex", "0"));
    card.focus();

    fireEvent.keyDown(card, { key: "Enter" });

    expect(await screen.findByRole("dialog", { name: "Sales trend" })).toBeInTheDocument();
  });

  it("does not consume double-clicks on interactive controls", () => {
    const onAction = vi.fn();
    renderOverlay(onAction);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Toggle sales" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("expands only the Batch Management chart and leaves its KPI and table untouched", async () => {
    const onAction = vi.fn();
    renderOverlay(onAction);
    const chart = document.querySelector(".batch-chart-card") as HTMLElement;

    fireEvent.doubleClick(chart);

    const dialog = await screen.findByRole("dialog", { name: "Batch Status Distribution" });
    expect(dialog).toBe(chart);
    expect(dialog).toHaveTextContent("Batch values");

    fireEvent.click(screen.getByRole("button", { name: "Batch chart action" }));
    expect(onAction).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close expanded content" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.doubleClick(document.querySelector(".batch-stat-card") as HTMLElement);
    fireEvent.doubleClick(document.querySelector(".batch-list-card") as HTMLElement);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("expands Waste Reports charts into the scrollable centered dialog", async () => {
    renderOverlay();
    const chart = document.querySelector(".waste-chart-card") as HTMLElement;

    fireEvent.doubleClick(chart);

    const dialog = await screen.findByRole("dialog", { name: "Waste Trend" });
    expect(dialog).toBe(chart);
    expect(dialog).toHaveTextContent("Expired values");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Close expanded content" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
