import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ClipboardList, Search } from "lucide-react";
import { formatAppDateTime, useGeneralSettings } from "../services/generalSettings";
import {
	loadAuditLogFilters,
	loadAuditLogs,
} from "../services/auditLogs";
import type {
	AuditLogEntry,
	AuditLogFilters,
	AuditLogQuery,
} from "../services/auditLogs";

type AuditFilterForm = {
	search: string;
	action: string;
	actor: string;
	start_date: string;
	end_date: string;
	status: "" | "successful" | "failed" | "unknown";
	sort_by: "timestamp" | "action" | "actor" | "affected_record" | "status";
	sort_order: "asc" | "desc";
};

const EMPTY_FILTERS: AuditFilterForm = {
	search: "",
	action: "",
	actor: "",
	start_date: "",
	end_date: "",
	status: "",
	sort_by: "timestamp",
	sort_order: "desc",
};

function actionLabel(action: string): string {
	return action.replace(/_/g, " ");
}

function affectedRecord(entry: AuditLogEntry): string {
	if (entry.affected_record) return entry.affected_record;
	const name = entry.entity_type.replace(/_/g, " ");
	return entry.entity_id === null ? name : `${name} #${entry.entity_id}`;
}

function detailSummary(details: Record<string, unknown>): string {
	return Object.entries(details)
		.map(([key, value]) => `${actionLabel(key)}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
		.join(" · ");
}

export default function AuditLogs({ onNotify, compact = false }: { onNotify: (message: string) => void; compact?: boolean }) {
	const { items_per_page: pageSize } = useGeneralSettings();
	const [filterOptions, setFilterOptions] = useState<AuditLogFilters | null>(null);
	const [form, setForm] = useState<AuditFilterForm>(EMPTY_FILTERS);
	const [applied, setApplied] = useState<AuditFilterForm>(EMPTY_FILTERS);
	const [entries, setEntries] = useState<AuditLogEntry[]>([]);
	const [total, setTotal] = useState(0);
	const [totalPages, setTotalPages] = useState(0);
	const [page, setPage] = useState(1);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		loadAuditLogFilters()
			.then((filters) => { if (active) setFilterOptions(filters); })
			.catch((loadError: unknown) => {
				if (!active) return;
				const message = loadError instanceof Error ? loadError.message : "Could not load audit log filters.";
				setError(message);
				onNotify(message);
			});
		return () => { active = false; };
	}, [onNotify]);

	const query = useMemo<AuditLogQuery>(() => ({
		search: applied.search || undefined,
		action: applied.action || undefined,
		...(applied.actor === "unknown"
			? { unknown_actor: true }
			: applied.actor
				? { user_id: Number(applied.actor) }
				: {}),
		start_date: applied.start_date || undefined,
		end_date: applied.end_date || undefined,
		status: applied.status || undefined,
		sort_by: applied.sort_by,
		sort_order: applied.sort_order,
		page,
		page_size: pageSize,
	}), [applied, page, pageSize]);

	useEffect(() => {
		let active = true;
		setIsLoading(true);
		setError("");
		loadAuditLogs(query)
			.then((result) => {
				if (!active) return;
				setEntries(result.items);
				setTotal(result.total);
				setTotalPages(result.total_pages);
			})
			.catch((loadError: unknown) => {
				if (!active) return;
				const message = loadError instanceof Error ? loadError.message : "Could not load audit logs.";
				setError(message);
				setEntries([]);
				setTotal(0);
				setTotalPages(0);
				onNotify(message);
			})
			.finally(() => { if (active) setIsLoading(false); });
		return () => { active = false; };
	}, [onNotify, query]);

	function applyFilters(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (form.start_date && form.end_date && form.start_date > form.end_date) {
			setError("Start date must be on or before end date.");
			return;
		}
		setError("");
		setApplied(form);
		setPage(1);
	}

	function updateForm(key: keyof AuditFilterForm, value: string) {
		setForm((current) => ({ ...current, [key]: value }));
	}

	const showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
	const showingTo = Math.min(page * pageSize, total);

	return (
		<div className={`audit-logs-page ${compact ? "audit-logs-compact" : ""}`}>
			{!compact && <section className="page-banner audit-logs-banner">
				<div className="banner-copy">
					<span className="eyebrow">SECURITY &amp; ACTIVITY</span>
					<h1>Audit Logs</h1>
					<p>Review recorded account and store activity</p>
				</div>
				<div className="audit-logs-banner-icon" aria-hidden="true"><ClipboardList size={58} /></div>
			</section>}

			<section className="audit-logs-panel" aria-label="Audit log history">
				<form className="audit-logs-filters" onSubmit={applyFilters}>
					<label className="audit-search">
						<Search size={16} aria-hidden="true" />
						<input
							aria-label="Search audit logs"
							value={form.search}
							onChange={(event) => updateForm("search", event.target.value)}
							placeholder="Search actions or affected records"
						/>
					</label>
					<label>
						<span>Action</span>
						<select aria-label="Filter by action" value={form.action} onChange={(event) => updateForm("action", event.target.value)}>
							<option value="">All actions</option>
							{filterOptions?.actions.map((action) => <option key={action} value={action}>{actionLabel(action)}</option>)}
						</select>
					</label>
					<label>
						<span>User</span>
						<select aria-label="Filter by user" value={form.actor} onChange={(event) => updateForm("actor", event.target.value)}>
							<option value="">All users</option>
							{filterOptions?.actors.map((actor) => <option key={actor.user_id} value={actor.user_id}>{actor.full_name}</option>)}
							{filterOptions?.has_unknown_actor && <option value="unknown">Unknown actor</option>}
						</select>
					</label>
					<label>
						<span>From</span>
						<input aria-label="Start date" type="date" value={form.start_date} onChange={(event) => updateForm("start_date", event.target.value)} />
					</label>
					<label>
						<span>To</span>
						<input aria-label="End date" type="date" value={form.end_date} onChange={(event) => updateForm("end_date", event.target.value)} />
					</label>
					<label>
						<span>Status</span>
						<select aria-label="Filter by status" value={form.status} onChange={(event) => updateForm("status", event.target.value as AuditFilterForm["status"])}>
							<option value="">All statuses</option>
							<option value="successful">Success</option>
							<option value="failed">Failed</option>
							<option value="unknown">Unknown</option>
						</select>
					</label>
					<label>
						<span>Sort by</span>
						<select aria-label="Sort audit logs by" value={form.sort_by} onChange={(event) => updateForm("sort_by", event.target.value as AuditFilterForm["sort_by"])}>
							<option value="timestamp">Date &amp; time</option>
							<option value="action">Action</option>
							<option value="actor">Actor</option>
							<option value="affected_record">Affected record</option>
							<option value="status">Status</option>
						</select>
					</label>
					<label>
						<span>Order</span>
						<select aria-label="Sort order" value={form.sort_order} onChange={(event) => updateForm("sort_order", event.target.value as AuditFilterForm["sort_order"])}>
							<option value="desc">Newest first</option>
							<option value="asc">Oldest first</option>
						</select>
					</label>
					<button className="audit-filter-button" type="submit">Apply filters</button>
				</form>

				{error && <p className="audit-logs-error" role="alert">{error}</p>}
				<div className="audit-logs-table-scroll">
					<table className="audit-logs-table">
						<thead><tr>
							<th>Activity</th><th>Actor</th><th>Affected record</th><th>Date &amp; time</th><th>Status</th><th>Details</th>
						</tr></thead>
						<tbody>
							{isLoading ? (
								<tr><td className="audit-logs-empty" colSpan={6} role="status">Loading audit history…</td></tr>
							) : entries.length === 0 ? (
								<tr><td className="audit-logs-empty" colSpan={6}>No audit events match the selected filters.</td></tr>
							) : entries.map((entry) => (
								<tr key={entry.activity_id}>
									<td className="audit-action">{actionLabel(entry.action)}</td>
									<td>{entry.actor_name}{entry.actor_role && <small className="audit-actor-role">{entry.actor_role.replace(/_/g, " ")}</small>}</td>
									<td>{affectedRecord(entry)}</td>
									<td>{formatAppDateTime(entry.created_at)}</td>
									<td><span className={`audit-status ${entry.status}`}>{entry.status}</span></td>
									<td className="audit-details">{detailSummary(entry.details) || "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<footer className="audit-logs-footer">
					<span>Showing {showingFrom}–{showingTo} of {total} activities{filterOptions?.timezone ? ` · ${filterOptions.timezone}` : ""}</span>
					<div className="audit-pagination" aria-label="Audit log pagination">
						<button type="button" aria-label="Previous page" disabled={page <= 1 || isLoading} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={16} /></button>
						<span>Page {page} of {Math.max(totalPages, 1)}</span>
						<button type="button" aria-label="Next page" disabled={page >= totalPages || isLoading} onClick={() => setPage((current) => current + 1)}><ChevronRight size={16} /></button>
					</div>
				</footer>
			</section>
		</div>
	);
}
