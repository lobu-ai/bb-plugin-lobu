// Lobu memory in bb: the thread panel. It shows what a thread was given,
// looked up, and saved, and the project's pins, note box, and brief.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/lib/contract";
import type {
  MemoryHit,
  MemoryKind,
  PinnedMemory,
  ProjectMemory,
  ProjectMemoryView,
  SavedRecord,
  ThreadMemory,
} from "@/lib/memory-contract";
import { SetupNotice } from "@/components/setup";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorText, formatCount, sinceMs } from "@/lib/format";
import { cn } from "@/lib/utils";

type WorkspaceOption = { slug: string; name: string };

const KIND_STYLE: Record<MemoryKind, string> = {
  fact: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  decision: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  preference: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  observation: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  note: "bg-muted text-muted-foreground",
};

function KindBadge({ kind }: { kind: MemoryKind }) {
  return (
    <span className={cn("mt-0.5 shrink-0 rounded px-1.5 py-px text-[11px] font-medium capitalize", KIND_STYLE[kind])}>
      {kind}
    </span>
  );
}

function Card({
  icon,
  title,
  aside,
  children,
}: {
  icon: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
        <Icon name={icon} className="size-4 text-muted-foreground" />
        {title}
        {aside === undefined ? null : <span className="ml-auto text-xs font-normal text-muted-foreground">{aside}</span>}
      </header>
      <div className="px-4">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-sm text-muted-foreground">{children}</p>;
}

function IconAction({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 text-muted-foreground"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} className="size-3.5" />
    </Button>
  );
}

function WorkspaceSelect({
  value,
  workspaces,
  placeholder,
  onChange,
  label,
}: {
  value: string | null;
  workspaces: WorkspaceOption[];
  placeholder: string;
  onChange: (slug: string | null) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      className="h-7 max-w-48 shrink-0 cursor-pointer rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
    >
      <option value="">{placeholder}</option>
      {workspaces.map((w) => (
        <option key={w.slug} value={w.slug}>
          {w.name}
        </option>
      ))}
    </select>
  );
}

/** Runs one action at a time and keeps its error and confirmation for display. */
function useActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = useCallback(async (key: string, action: () => Promise<string | null | void>) => {
    setBusy(key);
    setError(null);
    try {
      const message = await action();
      setNotice(typeof message === "string" ? message : null);
    } catch (cause) {
      setError(errorText(cause));
      setNotice(null);
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, notice, run };
}

function Status({ error, notice }: { error: string | null; notice: string | null }) {
  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  return notice === null ? null : (
    <p role="status" className="text-sm text-muted-foreground">
      {notice}
    </p>
  );
}

function SavedRow({
  record,
  projectName,
  busy,
  onUndo,
  onPin,
}: {
  record: SavedRecord;
  projectName: string | null;
  busy: boolean;
  onUndo: () => void;
  onPin: (() => void) | null;
}) {
  const title = <span className="font-medium">{record.title}</span>;
  return (
    <li className={cn("group flex items-start gap-2 py-3 text-sm", busy && "opacity-50")}>
      <KindBadge kind={record.kind} />
      <div className="min-w-0 flex-1 space-y-1">
        {record.url === null ? (
          title
        ) : (
          <UrlLink href={record.url} className="hover:underline">
            {title}
          </UrlLink>
        )}
        {record.content !== record.title ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{record.content}</p>
        ) : null}
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span>{record.workspace}</span>
          {projectName === null ? null : (
            <>
              <span aria-hidden>·</span>
              <span>{projectName}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span>{sinceMs(record.savedAt)}</span>
          {record.uses > 0 ? (
            <span className="rounded-full bg-emerald-500/10 px-1.5 text-emerald-700 dark:text-emerald-300">
              found {formatCount(record.uses)}×
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        {onPin === null ? null : <IconAction icon="lobu/pin" label="Pin to this project" onClick={onPin} disabled={busy} />}
        <IconAction icon="lobu/undo" label="Undo: remove from Lobu" onClick={onUndo} disabled={busy} />
      </div>
    </li>
  );
}

/** Undo and pin for a list of saved memories. */
function SavedList({
  records,
  projectNames,
  empty,
  onChanged,
}: {
  records: SavedRecord[];
  projectNames: Map<string, string>;
  empty: ReactNode;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { busy, error, notice, run } = useActions();
  return (
    <>
      {error !== null || notice !== null ? (
        <div className="pt-3">
          <Status error={error} notice={notice} />
        </div>
      ) : null}
      {records.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {records.map((record) => (
            <SavedRow
              key={record.eventId}
              record={record}
              projectName={record.projectId === null ? null : (projectNames.get(record.projectId) ?? null)}
              busy={busy === String(record.eventId)}
              onUndo={() =>
                void run(String(record.eventId), async () => {
                  await rpc.call("undoMemory", { eventId: record.eventId });
                  onChanged();
                  return `Removed "${record.title}". It stays recoverable in Lobu.`;
                })
              }
              onPin={
                record.projectId === null
                  ? null
                  : () =>
                      void run(String(record.eventId), async () => {
                        const project = await rpc.call("pinMemory", {
                          projectId: record.projectId as string,
                          item: {
                            eventId: record.eventId,
                            workspace: record.workspace,
                            title: record.title,
                            content: record.content,
                            url: record.url,
                          },
                        });
                        onChanged();
                        return `Pinned to ${project.name}. New threads there start with it.`;
                      })
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}

function PinRow({ pin, onUnpin, busy }: { pin: PinnedMemory; onUnpin: () => void; busy: boolean }) {
  const title = <span className="font-medium">{pin.title}</span>;
  return (
    <li className={cn("group flex items-start gap-2 py-2 text-sm", busy && "opacity-50")}>
      <Icon name="lobu/pin" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {pin.url === null ? (
          title
        ) : (
          <UrlLink href={pin.url} className="hover:underline">
            {title}
          </UrlLink>
        )}
        {pin.content !== pin.title ? <p className="line-clamp-1 text-xs text-muted-foreground">{pin.content}</p> : null}
      </div>
      <IconAction icon="lobu/close" label={`Unpin "${pin.title}"`} onClick={onUnpin} disabled={busy} />
    </li>
  );
}

function HitRow({ hit }: { hit: MemoryHit }) {
  return (
    <li className="flex items-start gap-2 py-2 text-sm">
      <div className="min-w-0 flex-1">
        {hit.url === null ? (
          <span className="font-medium">{hit.title}</span>
        ) : (
          <UrlLink href={hit.url} className="font-medium hover:underline">
            {hit.title}
          </UrlLink>
        )}
        <p className="line-clamp-2 text-xs text-muted-foreground">{hit.content}</p>
        <p className="text-xs text-muted-foreground">
          {hit.workspace}
          {hit.similarity === null ? null : ` · ${Math.round(hit.similarity * 100)}% match`}
        </p>
      </div>
    </li>
  );
}

/** A project's Lobu link, pins, a note box, and the brief new threads get. */
/**
 * What a new thread in the project starts with, as the brief gives it: pins
 * first, then what earlier threads learned. Below it, a note to pin and the
 * team workspace agents also search.
 */
function ProjectContext({
  project,
  workspaces,
  onProject,
}: {
  project: ProjectMemory;
  workspaces: WorkspaceOption[];
  onProject: (project: ProjectMemory) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { busy, error, notice, run } = useActions();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const empty = project.pins.length === 0 && project.learned.length === 0;
  return (
    <div className="space-y-2 py-2">
      {empty ? (
        <p className="text-xs text-muted-foreground">
          What agents learn in {project.name} shows up here, and notes you add are pinned at the top.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {project.pins.map((pin) => (
            <PinRow
              key={pin.pinnedAt}
              pin={pin}
              busy={busy === `unpin-${pin.pinnedAt}`}
              onUnpin={() =>
                void run(`unpin-${pin.pinnedAt}`, async () => {
                  onProject(await rpc.call("unpinMemory", { projectId: project.id, pinnedAt: pin.pinnedAt }));
                })
              }
            />
          ))}
          {project.learned.map((item) => (
            <li key={`${item.workspace}-${item.eventId ?? item.title}`} className="flex items-start gap-2 py-2 text-sm">
              <Icon name="lobu/memory" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">{item.title}</span>
            </li>
          ))}
        </ul>
      )}

      {noting ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = note.trim();
            if (text === "") return;
            void run("note", async () => {
              onProject(await rpc.call("addNote", { projectId: project.id, text }));
              setNote("");
              setNoting(false);
              return "Saved to your personal workspace and pinned here.";
            });
          }}
        >
          <input
            aria-label={`Add a note for ${project.name}`}
            autoFocus
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={`Something every new thread in ${project.name} should know`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={note.trim() === "" || busy === "note"}>
            Pin
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setNoting(false)}>
            Cancel
          </Button>
        </form>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {noting ? null : (
          <Button variant="ghost" size="sm" onClick={() => setNoting(true)}>
            <Icon name="lobu/plus" />
            Add a note
          </Button>
        )}
        <span>Agents also search</span>
        <WorkspaceSelect
          label={`Lobu workspace linked to ${project.name}`}
          value={project.workspace}
          workspaces={workspaces}
          placeholder="no team workspace"
          onChange={(workspace) =>
            void run("link", async () => {
              onProject(await rpc.call("linkProject", { projectId: project.id, workspace }));
              return workspace === null ? "Unlinked." : `Agents here now also search ${workspace}.`;
            })
          }
        />
        <Status error={error} notice={notice} />
      </div>
    </div>
  );
}

/**
 * The New thread screen's view of the project in view: a line saying what a
 * new thread there starts with, opening the same controls as the thread panel.
 */
export function ProjectBrief({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<ProjectMemoryView | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setView(null);
    rpc.call("projectMemory", { projectId }).then(setView, () => setView(null));
  }, [rpc, projectId]);
  if (view === null) return null;
  const { project } = view;
  const parts = [
    project.pins.length === 0 ? null : `${project.pins.length} pinned`,
    project.learned.length === 0 ? null : `${project.learned.length} learned in earlier threads`,
  ].filter((part) => part !== null);
  // Not connected and nothing to start with: the setup card says all there is.
  if (view.personal === null && parts.length === 0) return null;
  return (
    <section className="space-y-1 rounded-lg border border-border px-4 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          New threads in <span className="text-foreground">{project.name}</span> start with{" "}
          {parts.length === 0 ? "nothing yet" : parts.join(" and ")}.
        </p>
        <Button variant="ghost" size="sm" onClick={() => setOpen((shown) => !shown)}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open ? <ProjectContext project={project} workspaces={view.workspaces} onProject={(next) => setView({ ...view, project: next })} /> : null}
    </section>
  );
}

const THREAD_POLL_MS = 15_000;

/** The thread's Lobu memory panel: what it started with, looked up, and saved. */
/** Lobu's events page with everything bb saved through the login it uses. */
function SavedInLobu() {
  const rpc = useRpc<typeof rpcContract>();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("savedLink", {}).then(
      (next) => setUrl(next.url),
      () => setUrl(null),
    );
  }, [rpc]);
  if (url === null) return null;
  return (
    <UrlLink href={url} className="inline-block text-xs text-muted-foreground underline hover:text-foreground">
      See everything bb saved in Lobu
    </UrlLink>
  );
}

export function ThreadMemoryPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ThreadMemory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const load = useCallback(() => {
    rpc.call("threadMemory", { threadId }).then(
      (next) => {
        setData(next);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc, threadId]);
  useEffect(() => {
    load();
    const timer = setInterval(load, THREAD_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  if (data === null) {
    return error === null ? (
      <p className="text-sm text-muted-foreground">Loading…</p>
    ) : (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  const { project, log } = data;
  const given = log?.given ?? [];
  const searches = log?.searches ?? [];
  const names = new Map(project === null ? [] : [[project.id, project.name]]);
  return (
    <div className="space-y-4">
      <SetupNotice />
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <SavedInLobu />
      <Card icon="lobu/given" title="Started with" aside={given.length === 0 ? undefined : `${given.length} from Lobu`}>
        {given.length === 0 ? (
          <Empty>
            This thread started without Lobu memory.
            {project === null ? null : ` Pin notes to ${project.name} below and new threads there will start with them.`}
          </Empty>
        ) : (
          <ul className="divide-y divide-border">
            {given.map((item, index) => (
              <li key={`${item.eventId ?? "note"}-${index}`} className="flex items-center gap-2 py-2 text-sm">
                <Icon
                  name={item.source === "pinned" ? "lobu/pin" : "lobu/memory"}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.source}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card icon="lobu/search" title="Looked up" aside={searches.length === 0 ? undefined : `${searches.length}`}>
        {searches.length === 0 ? (
          <Empty>The agent has not searched Lobu in this thread.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {searches.map((search) => (
              <li key={search.at} className="py-2 text-sm">
                <button
                  type="button"
                  aria-expanded={expanded === search.at}
                  className="flex w-full items-center gap-2 text-left"
                  onClick={() => setExpanded((current) => (current === search.at ? null : search.at))}
                >
                  <span className="min-w-0 flex-1 truncate">“{search.query}”</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {search.results.length === 0 ? "no match" : `${search.results.length} found`} · {sinceMs(search.at)}
                  </span>
                </button>
                {expanded === search.at && search.results.length > 0 ? (
                  <ul className="mt-1 divide-y divide-border border-l-2 border-border pl-3">
                    {search.results.map((hit) => (
                      <HitRow key={hit.eventId} hit={hit} />
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card icon="lobu/memory" title="Saved from this thread" aside={data.saved.length === 0 ? undefined : `${data.saved.length}`}>
        <SavedList
          records={data.saved}
          projectNames={names}
          onChanged={load}
          empty="Nothing saved from this thread yet."
        />
      </Card>

      {project === null ? null : (
        <Card icon="lobu/folder" title={`Context for ${project.name}`}>
          <ProjectContext
            project={project}
            workspaces={data.workspaces}
            onProject={(next) => setData((current) => (current === null ? current : { ...current, project: next }))}
          />
        </Card>
      )}
    </div>
  );
}
