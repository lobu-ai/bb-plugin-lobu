// The Lobu dashboard page and the compact strip on the New thread screen.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Markdown, UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  CountedItem,
  DashboardItem,
  PinnedMetric,
  rpcContract,
  Snapshot,
  WorkspaceSummary,
} from "@/lib/contract";
import type { PendingReview } from "@/lib/memory-contract";
import { RememberFields } from "@/components/remember-form";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const POLL_MS = 120_000;

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      rpc
        .call("snapshot", { refresh })
        .then(
          (next) => {
            setSnapshot(next);
            setError(null);
          },
          (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
        )
        .finally(() => setLoading(false));
    },
    [rpc],
  );
  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { snapshot, error, loading, refresh: () => load(true) };
}

function relativeTime(iso: string | null): string | null {
  if (iso === null) return null;
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(minutes)) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatCount(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: n >= 10_000 ? "compact" : "standard" }).format(n);
}

function total(workspaces: WorkspaceSummary[], pick: (w: WorkspaceSummary) => number): number {
  return workspaces.reduce((sum, w) => sum + pick(w), 0);
}

const countOf = (items: CountedItem[]) => items.reduce((sum, item) => sum + item.count, 0);

/** Opens New thread with a prompt about this row. The user still picks the project and sends. */
function useAskAgent() {
  const navigate = useBbNavigate();
  return (workspace: string, kind: string, item: DashboardItem) => {
    const lines = [
      `In the Lobu workspace "${workspace}", this ${kind} needs attention:`,
      "",
      `- ${item.title}${item.detail ? `: ${item.detail}` : ""}`,
      ...(item.url === null ? [] : [`- Link: ${item.url}`]),
      "",
      "Use the Lobu tools to find out why and what to do about it. Explain before changing anything.",
    ];
    navigate.toCompose({ initialPrompt: lines.join("\n"), focusPrompt: true });
  };
}

function ItemRow({
  item,
  count,
  markdown = false,
  onAsk,
}: {
  item: DashboardItem;
  count?: number;
  markdown?: boolean;
  onAsk?: () => void;
}) {
  const when = relativeTime(item.at);
  const title = <span className="truncate font-medium">{item.title}</span>;
  return (
    <li className="group flex min-w-0 flex-col gap-0.5 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        {item.url === null ? (
          title
        ) : (
          <UrlLink href={item.url} className="min-w-0 truncate hover:underline">
            {title}
          </UrlLink>
        )}
        {count !== undefined && count > 1 ? (
          <span className="shrink-0 rounded bg-muted px-1.5 text-xs text-muted-foreground">×{formatCount(count)}</span>
        ) : null}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{when}</span>
        {onAsk === undefined ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={`Ask an agent about ${item.title}`}
            onClick={onAsk}
          >
            <Icon name="MessageCirclePlus" className="size-3.5" />
          </Button>
        )}
      </div>
      {item.detail === null || item.detail === "" ? null : markdown ? (
        <div className="line-clamp-3 text-xs text-muted-foreground">
          <Markdown content={item.detail} />
        </div>
      ) : (
        <p className="line-clamp-2 text-xs text-muted-foreground">{item.detail}</p>
      )}
    </li>
  );
}

function Section({
  icon,
  title,
  empty,
  count,
  badge,
  neutral = false,
  children,
}: {
  icon: string;
  title: string;
  empty: string;
  count: number;
  badge?: string;
  neutral?: boolean;
  children: ReactNode[];
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
        <Icon name={icon} className="size-4 text-muted-foreground" />
        {title}
        <span
          className={cn(
            "ml-auto rounded-full px-2 text-xs",
            count > 0 && !neutral ? "bg-destructive/10 text-destructive" : "text-muted-foreground",
          )}
        >
          {badge ?? formatCount(count)}
        </span>
      </header>
      {count === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="divide-y divide-border px-4">{children}</div>
      )}
    </section>
  );
}

function WorkspaceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-1">
      <p className="pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}

function grouped<T>(
  workspaces: WorkspaceSummary[],
  pick: (w: WorkspaceSummary) => T[],
  render: (item: T, index: number, workspace: WorkspaceSummary) => ReactNode,
): ReactNode[] {
  return workspaces
    .filter((w) => pick(w).length > 0)
    .map((w) => (
      <WorkspaceGroup key={w.slug} label={w.slug}>
        {pick(w).map((item, index) => render(item, index, w))}
      </WorkspaceGroup>
    ));
}

function MetricView({ metric }: { metric: PinnedMetric }) {
  if (metric.error !== null) {
    return (
      <>
        <p className="font-medium">{metric.label}</p>
        <p className="text-xs text-destructive">{metric.error}</p>
      </>
    );
  }
  const single = metric.rows.length === 1 && metric.columns.length === 1;
  return (
    <>
      <div className="flex items-baseline gap-2">
        <p className="font-medium">{metric.label}</p>
        {single ? (
          <p className="ml-auto text-lg font-semibold tabular-nums">{String(metric.rows[0]?.[0])}</p>
        ) : null}
      </div>
      {single ? null : metric.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data.</p>
      ) : (
        <table className="mt-1 w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              {metric.columns.map((column) => (
                <th key={column} className="py-0.5 text-left font-normal">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metric.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className={cn("py-0.5", typeof cell === "number" && "tabular-nums")}>
                    {cell === null ? "—" : typeof cell === "number" ? formatCount(cell) : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Command({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{children}</code>;
}

function SetupCard({ setup }: { setup: NonNullable<Snapshot["setup"]> }) {
  const login = setup.context === null ? "lobu login" : `lobu login --context ${setup.context}`;
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card px-4 py-4 text-sm">
      <p className="font-medium">Connect Lobu</p>
      <p className="text-muted-foreground">{setup.message}</p>
      {setup.code === "cli_missing" ? (
        <p>
          Install the CLI with <Command>npm install -g @lobu/cli</Command>, then run <Command>lobu login</Command>.
          If it lives somewhere unusual, set its path in this plugin's settings.
        </p>
      ) : setup.code === "not_logged_in" ? (
        <p>
          {setup.context === null ? null : (
            <>
              Add the context with <Command>{`lobu context add ${setup.context} --url https://app.lobu.ai/api/v1`}</Command>{" "}
              if it is new, then run{" "}
            </>
          )}
          {setup.context === null ? "Run " : null}
          <Command>{login}</Command> in a terminal and approve the login in your browser, then refresh.
        </p>
      ) : (
        <p>
          Check the plugin's "Hidden workspaces" setting, or run <Command>lobu login</Command> again and approve the
          workspaces you want. Every CLI login on this Lobu appears here.
        </p>
      )}
    </section>
  );
}

/** Recaps of archived threads, each in the same review form a thread shows. */
function PendingReviews() {
  const rpc = useRpc<typeof rpcContract>();
  const [reviews, setReviews] = useState<PendingReview[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("pendingReviews", {}).then(setReviews, (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  if (reviews.length === 0 && saved === null && error === null) return null;
  const done = (id: string) => setReviews((current) => current.filter((review) => review.id !== id));
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
        <Icon name="lobu/lobu" className="size-4 text-muted-foreground" />
        Memories to review
        <span className="ml-auto text-xs text-muted-foreground">{formatCount(reviews.length)}</span>
      </header>
      <div className="divide-y divide-border px-4">
        {saved === null ? null : <p className="py-2 text-sm text-muted-foreground">{saved}</p>}
        {error === null ? null : (
          <p role="alert" className="py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {reviews.map((review) => (
          <div key={review.id} className="space-y-2 py-3">
            <p className="text-xs text-muted-foreground">
              From the archived thread <span className="font-medium text-foreground">{review.sourceTitle}</span>
              {" · "}
              {relativeTime(new Date(review.createdAt).toISOString())}
            </p>
            <RememberFields
              form={review.form}
              onSave={async (submission) => {
                try {
                  const outcome = await rpc.call("savePendingReview", { id: review.id, submission });
                  setSaved(outcome.title);
                  setError(null);
                  done(review.id);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                }
              }}
              onSkip={async () => {
                await rpc.call("dismissPendingReview", { id: review.id });
                done(review.id);
              }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

const FILTER_KEY = "lobu.dashboard.workspace";

function readFilter(): string | null {
  try {
    return localStorage.getItem(FILTER_KEY);
  } catch {
    return null;
  }
}

/** The workspace the page is narrowed to, remembered across visits; null shows all. */
function useWorkspaceFilter(all: WorkspaceSummary[]) {
  const [selected, setSelected] = useState<string | null>(readFilter);
  const choose = (slug: string | null) => {
    setSelected(slug);
    try {
      if (slug === null) localStorage.removeItem(FILTER_KEY);
      else localStorage.setItem(FILTER_KEY, slug);
    } catch {
      // Storage can be unavailable; the choice then lasts for this visit.
    }
  };
  const active = selected !== null && all.some((w) => w.slug === selected) ? selected : null;
  return { active, choose, shown: active === null ? all : all.filter((w) => w.slug === active) };
}

function WorkspaceChips({
  workspaces,
  active,
  onChoose,
}: {
  workspaces: WorkspaceSummary[];
  active: string | null;
  onChoose: (slug: string | null) => void;
}) {
  const chip = (slug: string | null, label: string, waiting: number) => (
    <button
      key={slug ?? "__all"}
      type="button"
      aria-pressed={active === slug}
      onClick={() => onChoose(slug)}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
        active === slug
          ? "border-foreground/30 bg-accent text-foreground"
          : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {label}
      {waiting > 0 ? <span className="rounded-full bg-destructive/10 px-1.5 text-destructive">{formatCount(waiting)}</span> : null}
    </button>
  );
  return (
    <nav aria-label="Workspaces" className="flex flex-wrap gap-1.5">
      {chip(null, "All", total(workspaces, (w) => countOf(w.needsYou)))}
      {workspaces.map((w) => chip(w.slug, w.name === w.slug ? w.slug : w.name, countOf(w.needsYou)))}
    </nav>
  );
}

export function DashboardPage() {
  const { snapshot, error, loading, refresh } = useSnapshot();
  const ask = useAskAgent();
  const all = snapshot?.workspaces ?? [];
  const { active, choose, shown: workspaces } = useWorkspaceFilter(all);
  const problems = [
    ...(snapshot?.errors ?? []),
    ...all.filter((w) => w.error !== null).map((w) => `${w.slug}: ${w.error}`),
  ];
  const devices = snapshot?.devices ?? [];
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            {all.length} workspace{all.length === 1 ? "" : "s"}
            {snapshot === null ? null : ` · updated ${relativeTime(snapshot.fetchedAt)}`}
          </span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={refresh} disabled={loading}>
            <Icon name="lobu/refresh" className={cn("size-4", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {snapshot?.setup ? <SetupCard setup={snapshot.setup} /> : null}
        {all.length > 1 ? <WorkspaceChips workspaces={all} active={active} onChoose={choose} /> : null}
        <PendingReviews />
        {problems.length === 0 ? null : (
          <ul className="space-y-1 rounded-lg border border-destructive/40 px-4 py-3 text-xs text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {snapshot === null ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Loading Lobu…
          </div>
        ) : workspaces.length === 0 ? null : (
          <>
            <Section
              icon="lobu/inbox"
              title="Needs you"
              empty="Nothing is waiting on you."
              count={total(workspaces, (w) => countOf(w.needsYou))}
            >
              {grouped(workspaces, (w) => w.needsYou, (item, i, w) => (
                <ItemRow key={i} item={item} onAsk={() => ask(w.slug, "request", item)} />
              ))}
            </Section>
            <Section
              icon="lobu/alert"
              title="Failed runs · last 24h"
              empty="No Automation or feed failures."
              count={total(workspaces, (w) => countOf(w.failedRuns))}
            >
              {grouped(workspaces, (w) => w.failedRuns, (item, i, w) => (
                <ItemRow key={i} item={item} count={item.count} onAsk={() => ask(w.slug, "failing run", item)} />
              ))}
            </Section>
            <Section
              icon="lobu/plug"
              title="Connections & devices"
              empty="All connections and devices are healthy."
              count={total(workspaces, (w) => w.connections.length) + devices.length}
            >
              {[
                ...grouped(workspaces, (w) => w.connections, (item, i, w) => (
                  <ItemRow key={i} item={item} onAsk={() => ask(w.slug, "connection", item)} />
                )),
                ...(devices.length === 0
                  ? []
                  : [
                      <WorkspaceGroup key="__devices" label="devices">
                        {devices.map((item, i) => (
                          <ItemRow key={i} item={item} />
                        ))}
                      </WorkspaceGroup>,
                    ]),
              ]}
            </Section>
            <Section
              icon="lobu/activity"
              title="Activity · last 24h"
              empty="Nothing synced or run in the last 24 hours."
              neutral
              count={total(
                workspaces,
                (w) => w.activity.syncedTotal + w.activity.automations.length + w.activity.briefings.length,
              )}
              badge={`${formatCount(total(workspaces, (w) => w.activity.syncedTotal))} synced`}
            >
              {workspaces
                .filter(
                  (w) =>
                    w.activity.syncedTotal > 0 || w.activity.automations.length > 0 || w.activity.briefings.length > 0,
                )
                .map((w) => (
                  <WorkspaceGroup key={w.slug} label={w.slug}>
                    <li className="py-2 text-xs text-muted-foreground">
                      {formatCount(w.activity.syncedTotal)} items synced across {formatCount(w.activity.syncRuns)} feed
                      runs, re-reads included{w.activity.truncated ? " (newest runs only)" : ""}
                    </li>
                    {w.activity.briefings.map((item, i) => (
                      <ItemRow key={`b${i}`} item={item} markdown />
                    ))}
                    {w.activity.feeds.map((item, i) => (
                      <ItemRow key={`f${i}`} item={{ ...item, detail: `${formatCount(item.count)} items synced` }} />
                    ))}
                    {w.activity.automations.map((item, i) => (
                      <ItemRow
                        key={`a${i}`}
                        item={{
                          ...item,
                          detail: [`${formatCount(item.count)} run${item.count === 1 ? "" : "s"}`, item.detail]
                            .filter(Boolean)
                            .join(" · "),
                        }}
                      />
                    ))}
                  </WorkspaceGroup>
                ))}
            </Section>
            <Section
              icon="lobu/chart"
              title="Metrics"
              empty="These workspaces declare no metrics."
              neutral
              count={total(workspaces, (w) => w.metrics.pinned.length + w.metrics.available.length)}
              badge={`${total(workspaces, (w) => w.metrics.pinned.length)} pinned`}
            >
              {workspaces
                .filter((w) => w.metrics.pinned.length > 0 || w.metrics.available.length > 0)
                .map((w) => (
                  <WorkspaceGroup key={w.slug} label={w.slug}>
                    {w.metrics.pinned.map((metric) => (
                      <li key={metric.label} className="py-2 text-sm">
                        <MetricView metric={metric} />
                      </li>
                    ))}
                    {w.metrics.available.length === 0 ? null : (
                      <li className="py-2 text-xs text-muted-foreground">
                        Available to pin: {w.metrics.available.join(", ")}. Pin them in the plugin's "Pinned metrics"
                        setting.
                      </li>
                    )}
                  </WorkspaceGroup>
                ))}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

/** One line on the New thread screen; hidden when nothing needs attention. */
export function NeedsYouStrip() {
  const { snapshot } = useSnapshot();
  const navigate = useBbNavigate();
  if (snapshot === null || snapshot.setup !== null) return null;
  const items = snapshot.workspaces.flatMap((w) => w.needsYou.map((item) => ({ ...item, workspace: w.slug })));
  const waiting = countOf(items);
  const failed = total(snapshot.workspaces, (w) => countOf(w.failedRuns));
  const unhealthy = total(snapshot.workspaces, (w) => w.connections.length) + snapshot.devices.length;
  if (waiting === 0 && failed === 0 && unhealthy === 0) return null;
  return (
    <div className="space-y-1 text-sm">
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        onClick={() => navigate.toPluginPanel("dashboard")}
      >
        {waiting} waiting on you · {failed} failed runs (24h) · {unhealthy} connection or device issues
      </button>
      <ul className="space-y-0.5">
        {items.slice(0, 5).map((item, i) => (
          <li key={i} className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">{item.workspace}</span>
            {item.url === null ? (
              <span className="truncate">{item.title}</span>
            ) : (
              <UrlLink href={item.url} className="truncate hover:underline">
                {item.title}
              </UrlLink>
            )}
            {item.count > 1 ? (
              <span className="shrink-0 text-xs text-muted-foreground">×{formatCount(item.count)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
