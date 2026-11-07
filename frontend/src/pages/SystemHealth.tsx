import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Database, HeartPulse, RefreshCw, Server, Sparkles, XCircle } from "lucide-react";
import { formatAppDateTime } from "../services/generalSettings";
import { loadSystemHealth } from "../services/systemHealth";
import type { BrowserConnectionState, HealthState, SystemHealthResponse } from "../services/systemHealth";

type DisplayHealthState = HealthState | BrowserConnectionState | "unknown";

function StatusMark({ status }: { status: DisplayHealthState }) {
	if (status === "available" || status === "connected") return <CheckCircle2 size={17} aria-label={status === "connected" ? "Connected" : "Available"} />;
	if (status === "unavailable") return <XCircle size={17} aria-label="Unavailable" />;
	return <Activity size={17} aria-label="Unknown" />;
}

function statusLabel(status: DisplayHealthState): string {
	return status === "available" ? "Available" : status === "connected" ? "Connected" : status === "unavailable" ? "Unavailable" : "Not checked";
}

function durationLabel(seconds: number | undefined): string {
	if (seconds === undefined) return "Admin details only";
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	return [
		days ? `${days}d` : "",
		hours ? `${hours}h` : "",
		minutes ? `${minutes}m` : "",
		`${remainder}s`,
	].filter(Boolean).join(" ");
}

function ServiceCard({
	title,
	description,
	status,
	icon,
}: {
	title: string;
	description: string;
	status: DisplayHealthState;
	icon: ReactNode;
}) {
	return (
		<article className={`system-health-card ${status}`}>
			<div className="system-health-card-icon">{icon}</div>
			<div className="system-health-card-copy">
				<span>{title}</span>
				<strong><StatusMark status={status} /> {statusLabel(status)}</strong>
				<small>{description}</small>
			</div>
		</article>
	);
}

export default function SystemHealth({
	onNotify,
	isAdmin,
	compact = false,
}: {
	onNotify: (message: string) => void;
	isAdmin: boolean;
	compact?: boolean;
}) {
	const [health, setHealth] = useState<SystemHealthResponse | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState("");

	const refreshHealth = useCallback(async () => {
		setIsLoading(true);
		setError("");
		try {
			setHealth(await loadSystemHealth());
		} catch (loadError) {
			const message = loadError instanceof Error ? loadError.message : "System health could not be checked.";
			setError(message);
			setHealth(null);
			onNotify(message);
		} finally {
			setIsLoading(false);
		}
	}, [onNotify]);

	useEffect(() => {
		void refreshHealth();
	}, [refreshHealth]);

	const backendStatus: HealthState | "unknown" = error ? "unavailable" : health?.api.status ?? "unknown";
	const browserConnectionStatus: BrowserConnectionState | "unknown" = error ? "unavailable" : health?.frontend_backend.status ?? "unknown";
	const databaseStatus = health?.database.status ?? (error ? "unavailable" : "unknown");

	return (
		<div className={`system-health-page ${compact ? "system-health-compact" : ""}`}>
			{!compact && <section className="page-banner system-health-banner">
				<div className="banner-copy">
					<span className="eyebrow">LIVE SERVICE MONITORING</span>
					<h1>System Health</h1>
					<p>Current status of WasteWise services and model availability</p>
				</div>
				<div className="system-health-banner-icon" aria-hidden="true"><HeartPulse size={54} /></div>
			</section>}

			<section className={`system-health-summary ${health?.status ?? (error ? "unavailable" : "unknown")}`} aria-live="polite">
				<div className="system-health-summary-icon">{health?.status === "healthy" ? <CheckCircle2 size={24} /> : error || health ? <AlertTriangle size={24} /> : <Activity size={24} />}</div>
				<div>
					<strong>{isLoading && !health ? "Checking system…" : error ? "Health check unavailable" : health?.status === "healthy" ? "All checked services are available" : health?.status === "degraded" ? "Some services need attention" : "Health check not yet completed"}</strong>
					<span>{health ? `Checked ${formatAppDateTime(health.checked_at)}` : error ? "The authenticated health endpoint could not be reached." : "Use Refresh Health to run a live check."}</span>
				</div>
				<button type="button" className="system-health-refresh" onClick={() => void refreshHealth()} disabled={isLoading}>
					<RefreshCw size={16} className={isLoading ? "spinning" : ""} />
					{isLoading ? "Checking…" : "Refresh Health"}
				</button>
			</section>

			{error && <p className="system-health-error" role="alert">{error}</p>}

			<section className="system-health-grid" aria-label="Service status">
				<ServiceCard
					title="Backend API"
					description="Authenticated health endpoint response"
					status={backendStatus}
					icon={<Server size={23} />}
				/>
				<ServiceCard
					title="Frontend / Backend"
					description={health?.frontend_backend.message ?? "Authenticated browser-to-API request"}
					status={browserConnectionStatus}
					icon={<Activity size={23} />}
				/>
				<ServiceCard
					title="MySQL Database"
					description={health?.database.message ?? "Live SELECT 1 connectivity probe"}
					status={databaseStatus}
					icon={<Database size={23} />}
				/>
				{health?.ml_models.map((model) => (
					<ServiceCard
						key={model.name}
						title={model.artifact}
						description={model.message ?? "Artifact load check"}
						status={model.status}
						icon={<Sparkles size={23} />}
					/>
				))}
				{!health && !error && !isLoading && ["demand_forecast.joblib", "discount_recommendation.joblib", "expiry_risk.joblib"].map((artifact) => (
					<ServiceCard key={artifact} title={artifact} description="Awaiting live artifact check" status="unknown" icon={<Sparkles size={23} />} />
				))}
			</section>

			<section className="system-health-meta" aria-label="Health check information">
				<article>
					<span><Clock3 size={17} /> Last successful health check</span>
					<strong>{health?.last_successful_check ? formatAppDateTime(health.last_successful_check) : "No fully healthy check recorded in this process"}</strong>
				</article>
				{isAdmin && health && <>
					<article>
						<span><Activity size={17} /> Application version</span>
						<strong>{health.app_version ?? "Not reported"}</strong>
					</article>
					<article>
						<span><Clock3 size={17} /> Application uptime</span>
						<strong>{durationLabel(health.uptime_seconds)}</strong>
					</article>
				</>}
			</section>

			{isAdmin && health && <section className="system-health-errors" aria-label="System errors">
				<h2><AlertTriangle size={18} /> System errors</h2>
				{health.errors?.length ? (
					<ul>{health.errors.map((item, index) => <li key={`${item.service}-${index}`}><b>{item.service}</b><span>{item.message}</span></li>)}</ul>
				) : <p><CheckCircle2 size={16} /> No errors detected by the current health checks.</p>}
			</section>}
		</div>
	);
}
