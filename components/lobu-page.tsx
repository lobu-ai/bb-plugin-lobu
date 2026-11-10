// The Lobu page in bb's sidebar: what needs you, what agents remember across
// the login's workspaces, and what is paired. Each section loads on its own,
// so one slow or failing Lobu call never blanks the rest of the page.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PanelConnection, PanelDevice, PanelMemory, rpcContract, SetupStatus } from "@/lib/contract";
import type { SavedRecord } from "@/lib/memory-contract";
import { InboxSection } from "@/components/inbox";
import { isConnected, SetupCard, useSetupStatus } from "@/components/setup";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorText, formatCount, relativeTime, sinceMs } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How long the search box waits after a keystroke before asking Lobu. */
const SEARCH_DEBOUNCE_MS = 300;
/** How many memories the page shows: the newest, or the best matches. */
const MEMORY_LIMIT = 30;

type SavedPanelMemory = SavedRecord & { projectName: string | null };

const host = (origin: string) => origin.replace(/^https?:\/\//, "");
const KIND_LABEL: Record<SetupStatus["contexts"][number]["kind"], string> = {
  cloud: "Lobu Cloud",
  local: "Lobu on this machine",
  other: "Lobu",
};
/** Connection statuses that mean the connection is not working, not just idle. */
const CONNECTION_ATTENTION = new Set(["failing", "error", "revoked", "expired", "disconnected", "needs_attention"]);

const field =
  "h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {aside === undefined ? null : <div className="ml-auto text-xs text-muted-foreground">{aside}</div>}
      </header>
      <div className="px-4">{children}</div>
    </section>
  );
}

function Retry({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function MemoryRow({ hit }: { hit: PanelMemory }) {
  const title = <span className="font-medium">{hit.title}</span>;
  return (
    <li className="py-2.5 text-sm">
      {hit.url === null ? (
        title
      ) : (
        <UrlLink href={hit.url} className="hover:underline">
          {title}
        </UrlLink>
      )}
      {hit.content.trim() === "" || hit.content === hit.title ? null : (
        <p className="line-clamp-2 text-xs text-muted-foreground">{hit.content}</p>
      )}
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span>{hit.workspace}</span>
        {hit.occurredAt === null ? null : (
          <>
            <span aria-hidden>·</span>
            <span>{relativeTime(hit.occurredAt)}</span>
          </>
        )}
        {hit.similarity === null ? null : (
          <span className="rounded-full bg-muted px-1.5">{Math.round(hit.similarity * 100)}% match</span>
        )}
      </p>
    </li>
  );
}

function SavedRow({ record }: { record: SavedPanelMemory }) {
  const navigate = useBbNavigate();
  const title = <span className="font-medium">{record.title}</span>;
  return (
    <li className="py-2.5 text-sm">
      {record.url === null ? (
        title
      ) : (
        <UrlLink href={record.url} className="hover:underline">
          {title}
        </UrlLink>
      )}
      {record.content.trim() === "" || record.content === record.title ? null : (
        <p className="line-clamp-2 text-xs text-muted-foreground">{record.content}</p>
      )}
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span>{record.workspace}</span>
        {record.projectName === null ? null : (
          <>
            <span aria-hidden>·</span>
            <span>{record.projectName}</span>
          </>
        )}
        <span aria-hidden>·</span>
        <span>{sinceMs(record.savedAt)}</span>
        {record.uses === 0 ? null : (
          <span className="rounded-full bg-emerald-500/10 px-1.5 text-emerald-700 dark:text-emerald-300">
            found {formatCount(record.uses)}×
          </span>
        )}
        {record.threadId === "" || record.threadId === "lobu" ? null : (
          <button type="button" className="underline hover:text-foreground" onClick={() => navigate.toThread(record.threadId)}>
            Thread
          </button>
        )}
      </p>
    </li>
  );
}

/** The memory loop made visible: what bb saved, or everything Lobu holds. */
function MemoriesSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<"saved" | "all">("saved");
  // "Saved from bb" reads the plugin's own records.
  const [saved, setSaved] = useState<SavedPanelMemory[] | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedRefreshes, setSavedRefreshes] = useState(0);
  // "All of Lobu" reads the login's workspaces.
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PanelMemory[] | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  // Only the newest request may write state: a slow recent list must not
  // overwrite the results of a query the user typed after it.
  const request = useRef(0);

  useEffect(() => {
    if (view !== "saved") return;
    let live = true;
    setSavedLoading(true);
    rpc
      .call("savedMemories", {})
      .then(
        (page) => {
          if (!live) return;
          setSaved(page.records);
          setSavedError(null);
        },
        (cause: unknown) => {
          if (live) setSavedError(errorText(cause));
        },
      )
      .finally(() => {
        if (live) setSavedLoading(false);
      });
    return () => {
      live = false;
    };
  }, [rpc, view, savedRefreshes]);

  const load = useCallback(
    (text: string) => {
      const id = ++request.current;
      setLoading(true);
      rpc
        .call("memories", { query: text === "" ? null : text, limit: MEMORY_LIMIT })
        .then(
          (page) => {
            if (id !== request.current) return;
            setHits(page.hits);
            setFailed(page.failed);
            setError(null);
          },
          (cause: unknown) => {
            if (id !== request.current) return;
            setError(errorText(cause));
          },
        )
        .finally(() => {
          if (id === request.current) setLoading(false);
        });
    },
    [rpc],
  );

  useEffect(() => {
    if (view !== "all") return;
    const text = query.trim();
    if (text === "") {
      load("");
      return;
    }
    if (text.length < 2) return;
    const timer = setTimeout(() => load(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [view, query, load, refreshes]);

  const searching = query.trim() !== "";
  const refresh = () => {
    if (view === "saved") setSavedRefreshes((n) => n + 1);
    else setRefreshes((n) => n + 1);
  };
  return (
    <Section
      title="Memories"
      aside={
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {(["saved", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setView(value)}
              className={cn(
                "rounded px-2 py-0.5 text-xs",
                view === value ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value === "saved" ? "Saved from bb" : "All of Lobu"}
            </button>
          ))}
        </div>
      }
    >
      {view === "saved" ? (
        <>
          <div className="flex items-center gap-2 py-2">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {saved === null ? " " : `${saved.length} ${saved.length === 1 ? "memory" : "memories"} from bb threads`}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground"
              aria-label="Refresh saved memories"
              onClick={refresh}
            >
              <Icon name="lobu/refresh" className={cn("size-4", savedLoading && "animate-spin")} />
            </Button>
          </div>
          {savedError !== null ? (
            <Retry label={savedError} onRetry={refresh} />
          ) : saved === null ? (
            <p className="py-3 text-xs text-muted-foreground">Loading…</p>
          ) : saved.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">
              Nothing saved from bb yet. Agents save decisions, gotchas, and standing preferences as they work.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {saved.map((record) => (
                <SavedRow key={`${record.workspace}-${record.eventId}`} record={record} />
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 py-2">
            <input
              aria-label="Search Lobu memories"
              placeholder="Search all of Lobu"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={field}
            />
            {searching ? (
              <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
                Clear
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground"
              aria-label="Refresh memories"
              onClick={refresh}
            >
              <Icon name="lobu/refresh" className={cn("size-4", loading && "animate-spin")} />
            </Button>
          </div>
          {error !== null ? (
            <Retry label={error} onRetry={refresh} />
          ) : hits === null ? (
            <p className="py-3 text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              {failed.length === 0 ? null : (
                <p className="pb-2 text-xs text-muted-foreground">
                  {failed.length} {failed.length === 1 ? "workspace" : "workspaces"} didn’t respond: {failed.join(", ")}
                </p>
              )}
              {hits.length === 0 ? (
                <p className="py-3 text-xs text-muted-foreground">
                  {searching
                    ? `Nothing matches “${query.trim()}”.`
                    : "No memories yet. Agents save decisions, gotchas, and standing preferences as they work."}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {hits.map((hit) => (
                    <MemoryRow key={`${hit.workspace}-${hit.eventId}`} hit={hit} />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </Section>
  );
}

function DeviceRow({ device }: { device: PanelDevice }) {
  const name = device.label ?? device.platform ?? "Paired device";
  return (
    <li className="flex items-center gap-2 py-2.5 text-sm">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", device.online ? "bg-emerald-500" : "bg-muted-foreground/40")}
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {device.online ? "online" : (relativeTime(device.lastSeenAt) ?? "offline")}
      </span>
    </li>
  );
}

function ConnectionRow({ connection }: { connection: PanelConnection }) {
  const detail = [connection.connectorName, connection.account, connection.deviceLabel]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
  return (
    <li className="py-2.5 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate">{connection.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{connection.status}</span>
      </div>
      {detail === "" ? null : <p className="truncate text-xs text-muted-foreground">{detail}</p>}
      {connection.errorMessage === null ? null : (
        <p className="text-xs text-destructive">{connection.errorMessage}</p>
      )}
    </li>
  );
}

/** Paired devices and the personal workspace's connections. */
function ConnectionsSection({ origin, personal }: { origin: string; personal: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{ devices: PanelDevice[]; connections: PanelConnection[]; failed: boolean } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);

  useEffect(() => {
    let live = true;
    rpc.call("connections", {}).then(
      (next) => {
        if (!live) return;
        setData(next);
        setError(null);
      },
      (cause: unknown) => {
        if (live) setError(errorText(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, refreshes]);

  const manageUrl = personal === null ? null : `${origin}/${personal}`;
  const devices = [...(data?.devices ?? [])].sort((a, b) => Number(b.online) - Number(a.online));
  const connections = data?.connections ?? [];
  // A connection that reports an error or a broken status is what this page
  // is for; the rest are one line in the summary and live in Lobu.
  const attention = connections.filter(
    (connection) => connection.errorMessage !== null || CONNECTION_ATTENTION.has(connection.status.toLowerCase()),
  );
  const empty = data !== null && devices.length === 0 && connections.length === 0;
  const summary =
    data === null
      ? null
      : [
          `${devices.length} ${devices.length === 1 ? "device" : "devices"}`,
          `${connections.length} ${connections.length === 1 ? "connection" : "connections"}`,
          attention.length === 0 ? null : `${attention.length} needing attention`,
        ]
          .filter((part): part is string => part !== null)
          .join(" · ");
  return (
    <Section
      title="Devices and connections"
      aside={
        manageUrl === null ? undefined : (
          <UrlLink href={manageUrl} className="underline hover:text-foreground">
            Manage in Lobu
          </UrlLink>
        )
      }
    >
      {error !== null ? (
        <Retry label={error} onRetry={() => setRefreshes((n) => n + 1)} />
      ) : data === null ? (
        <p className="py-3 text-xs text-muted-foreground">Loading…</p>
      ) : data.failed ? (
        <Retry label="Lobu didn’t answer for devices and connections." onRetry={() => setRefreshes((n) => n + 1)} />
      ) : empty ? (
        <p className="py-3 text-xs text-muted-foreground">
          No paired devices or connections yet. Connect services and pair a browser in Lobu.
        </p>
      ) : (
        <>
          <p className="py-2 text-xs text-muted-foreground">{summary}</p>
          {devices.length === 0 ? null : (
            <ul className="divide-y divide-border border-t border-border">
              {devices.map((device) => (
                <DeviceRow key={`device-${device.id}`} device={device} />
              ))}
            </ul>
          )}
          {attention.length === 0 ? null : (
            <>
              <p className="pt-3 text-xs font-medium">Needs attention</p>
              <ul className="divide-y divide-border border-t border-border">
                {attention.map((connection) => (
                  <ConnectionRow key={`connection-${connection.id}`} connection={connection} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Section>
  );
}

function Page({ status, reload }: { status: SetupStatus; reload: () => Promise<SetupStatus | null> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [refreshes, setRefreshes] = useState(0);
  const [waiting, setWaiting] = useState<{ name: string; approvalUrl: string | null } | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // A signed-out context finishes its login in the browser; switch once it lands.
  useEffect(() => {
    if (waiting === null) return;
    const timer = setInterval(() => {
      void reload().then((next) => {
        if (next === null || next.login === null) return;
        if (next.login.context === waiting.name && next.login.problem === null) {
          setWaiting(null);
          setRefreshes((n) => n + 1);
        }
      });
    }, 3_000);
    return () => clearInterval(timer);
  }, [waiting, reload]);

  const pick = (name: string) => {
    setSwitchError(null);
    rpc.call("useLogin", { name }).then(
      ({ approvalUrl }) => {
        if (approvalUrl === null) {
          void reload().then(() => setRefreshes((n) => n + 1));
        } else {
          setWaiting({ name, approvalUrl });
        }
      },
      (cause: unknown) => setSwitchError(errorText(cause)),
    );
  };

  if (!isConnected(status) || status.login === null) {
    return (
      <div className="space-y-3">
        <SetupCard status={status} reload={reload} />
      </div>
    );
  }
  const login = status.login;
  const who = login.account ?? login.context ?? "Connected";
  const picked = login.context ?? status.contexts.find((context) => context.current)?.name ?? "";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {who} · {host(login.origin)} · {KIND_LABEL[login.kind]}
        </p>
        {status.contexts.length === 0 ? null : (
          <select
            aria-label="Lobu context"
            className="h-8 max-w-56 cursor-pointer rounded-md border border-input bg-transparent px-2 text-xs"
            value={picked}
            onChange={(event) => pick(event.target.value)}
          >
            {status.contexts.map((context) => (
              <option key={context.name} value={context.name}>
                {context.name} · {host(context.origin)}
                {context.loggedIn ? "" : " (signed out)"}
              </option>
            ))}
          </select>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setRefreshes((n) => n + 1);
            void reload();
          }}
        >
          <Icon name="lobu/refresh" className="size-4" />
          Refresh
        </Button>
        <UrlLink
          href={login.personal === null ? login.origin : `${login.origin}/${login.personal}`}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          Open in Lobu
        </UrlLink>
      </div>
      {waiting === null ? null : (
        <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          Approve the {waiting.name} login in your browser. This page switches once you do.
          {waiting.approvalUrl === null ? null : (
            <>
              {" "}
              <UrlLink href={waiting.approvalUrl} className="text-foreground underline">
                Open the approval page
              </UrlLink>
            </>
          )}
        </p>
      )}
      {switchError === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {switchError}
        </p>
      )}
      <div key={refreshes} className="space-y-3">
        <InboxSection defaultOpen compact />
        <MemoriesSection />
        <ConnectionsSection origin={login.origin} personal={login.personal} />
      </div>
    </div>
  );
}

/** The Lobu nav panel. */
export function LobuPage() {
  const { status, error, reload } = useSetupStatus();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-4">
        {status !== null ? (
          <Page status={status} reload={reload} />
        ) : error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Checking Lobu…</p>
        )}
      </div>
    </div>
  );
}
