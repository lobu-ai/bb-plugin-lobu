// Lobu memory in bb: the thread panel. It shows what a thread was given,
// looked up, and saved, and the project's pins, note box, and brief.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/lib/contract";
import type {
  LinkedEntity,
  MemoryHit,
  MemoryKind,
  PinnedMemory,
  ProjectMemory,
  ProjectMemoryView,
  SavedRecord,
  SavedSession,
  ThreadMemory,
} from "@/lib/memory-contract";
import { SetupNotice } from "@/components/setup";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorText, formatCount, sinceMs } from "@/lib/format";
import { cn } from "@/lib/utils";

type WorkspaceOption = { slug: string; name: string };

// The New thread screen shows a memory in both the brief and the sessions
// card; deleting it in one refreshes the other.
const memoryEvents = new EventTarget();

function memoryDeleted() {
  memoryEvents.dispatchEvent(new Event("deleted"));
}

/** Calls `listener` after any card deletes a memory; returns the unsubscribe. */
function onMemoryDeleted(listener: () => void): () => void {
  memoryEvents.addEventListener("deleted", listener);
  return () => memoryEvents.removeEventListener("deleted", listener);
}

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

/** Edit opens the memory in Lobu; Delete removes it from Lobu right here. */
function MemoryActions({
  title,
  url,
  deleting,
  onDelete,
}: {
  title: string;
  url: string | null;
  deleting: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center">
      {url === null ? null : (
        <UrlLink
          href={url}
          aria-label={`Edit "${title}" in Lobu`}
          title="Edit in Lobu"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="lobu/pencil" className="size-3.5" />
        </UrlLink>
      )}
      <IconAction icon="lobu/trash" label={`Delete "${title}" from Lobu`} onClick={onDelete} disabled={deleting} />
    </div>
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
  shareWorkspace,
  busy,
  onUndo,
  onPin,
  onShare,
}: {
  record: SavedRecord;
  projectName: string | null;
  shareWorkspace: string | null;
  busy: boolean;
  onUndo: () => void;
  onPin: (() => void) | null;
  onShare: (() => void) | null;
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
        {onShare === null || shareWorkspace === null ? null : (
          <IconAction icon="lobu/share" label={`Share to ${shareWorkspace}`} onClick={onShare} disabled={busy} />
        )}
        {onPin === null ? null : <IconAction icon="lobu/pin" label="Pin to this project" onClick={onPin} disabled={busy} />}
        <IconAction icon="lobu/undo" label="Undo: remove from Lobu" onClick={onUndo} disabled={busy} />
      </div>
    </li>
  );
}

/** Undo, share, and pin for a list of saved memories. */
function SavedList({
  records,
  projectNames,
  shareWorkspace = null,
  empty,
  onChanged,
}: {
  records: SavedRecord[];
  projectNames: Map<string, string>;
  shareWorkspace?: string | null;
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
          {records.map((record) => {
            const targetWorkspace =
              shareWorkspace !== null && shareWorkspace !== record.workspace ? shareWorkspace : null;
            return (
              <SavedRow
                key={record.eventId}
                record={record}
                projectName={record.projectId === null ? null : (projectNames.get(record.projectId) ?? null)}
                shareWorkspace={targetWorkspace}
                busy={busy === String(record.eventId)}
                onUndo={() =>
                  void run(String(record.eventId), async () => {
                    await rpc.call("undoMemory", { eventId: record.eventId });
                    onChanged();
                    return `Removed "${record.title}". It stays recoverable in Lobu.`;
                  })
                }
                onShare={
                  targetWorkspace === null
                    ? null
                    : () =>
                        void run(String(record.eventId), async () => {
                          await rpc.call("shareMemory", { eventId: record.eventId, workspace: targetWorkspace });
                          onChanged();
                          return `Shared "${record.title}" to ${targetWorkspace}.`;
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
            );
          })}
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

type LearnedItem = ProjectMemory["learned"][number];

/** The brief's learned memories grouped by the thread that saved them, in brief order. */
function learnedBySession(items: LearnedItem[]) {
  const groups = new Map<string, { threadId: string | null; threadTitle: string | null; items: LearnedItem[] }>();
  for (const item of items) {
    const key = item.threadId ?? "";
    const group = groups.get(key) ?? { threadId: item.threadId, threadTitle: item.threadTitle, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Learned memories under the thread that taught them: the thread title opens
 * it in bb, the memory title opens it in Lobu, with a short excerpt.
 */
function LearnedGroups({
  items,
  action,
  dimmed,
}: {
  items: LearnedItem[];
  action?: (item: LearnedItem) => ReactNode;
  dimmed?: (item: LearnedItem) => boolean;
}) {
  const navigate = useBbNavigate();
  return (
    <>
      {learnedBySession(items).map((group) => (
        <li key={group.threadId ?? "unknown"} className="py-2">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name="lobu/memory" className="size-3.5 shrink-0" />
            <span>Learned in</span>
            {group.threadId !== null && group.threadTitle !== null ? (
              <button
                type="button"
                className="min-w-0 truncate font-medium text-foreground hover:underline"
                onClick={() => navigate.toThread(group.threadId as string)}
              >
                {group.threadTitle}
              </button>
            ) : (
              <span>an earlier thread</span>
            )}
          </p>
          <ul className="mt-1 border-l border-border pl-3">
            {group.items.map((item) => (
              <li
                key={`${item.workspace}-${item.eventId ?? item.title}`}
                className={cn("group flex items-start gap-2 py-1.5 text-sm", dimmed?.(item) && "opacity-50")}
              >
                <div className="min-w-0 flex-1">
                  {item.url === null || action !== undefined ? (
                    <span>{item.title}</span>
                  ) : (
                    <UrlLink href={item.url} className="hover:underline">
                      {item.title}
                    </UrlLink>
                  )}
                  {item.content.trim() === "" || item.content === item.title ? null : (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{item.content}</p>
                  )}
                </div>
                {action?.(item) ?? null}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </>
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
          <LearnedGroups
            items={project.learned}
            action={(item) =>
              item.eventId === null ? null : (
                <MemoryActions
                  title={item.title}
                  url={item.url}
                  deleting={busy === `undo-${item.eventId}`}
                  onDelete={() =>
                    void run(`undo-${item.eventId}`, async () => {
                      await rpc.call("undoMemory", { eventId: item.eventId as number });
                      const refreshed = await rpc.call("projectMemory", { projectId: project.id });
                      onProject(refreshed.project);
                      memoryDeleted();
                      return `Deleted "${item.title}". It stays recoverable in Lobu.`;
                    })
                  }
                />
              )
            }
            dimmed={(item) => item.eventId !== null && busy === `undo-${item.eventId}`}
          />
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
    const load = () => rpc.call("projectMemory", { projectId }).then(setView, () => setView(null));
    void load();
    return onMemoryDeleted(() => void load());
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

type SessionMemory = SavedSession["records"][number];

function SessionRow({
  record,
  entities,
  deleting,
  onDelete,
}: {
  record: SessionMemory;
  /** The records it links to; empty until their names are read. */
  entities: LinkedEntity[];
  deleting: boolean;
  onDelete: () => void;
}) {
  return (
    <li className={cn("flex items-start gap-2 py-2 text-sm", deleting && "opacity-50")}>
      <div className="min-w-0 flex-1">
        <span className="font-medium">{record.title}</span>
        {record.content.trim() === "" || record.content === record.title ? null : (
          <p className="line-clamp-2 text-xs text-muted-foreground">{record.content}</p>
        )}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span>{record.kind}</span>
          <span aria-hidden>·</span>
          <span>{record.workspace}</span>
          {entities
            // Lobu's own record types ($member: whoever saved it) are on every memory.
            .filter((entity) => entity.type === null || !entity.type.startsWith("$"))
            .map((entity) => (
              <EntityChip key={entity.id} entity={entity} />
            ))}
          {record.uses === 0 ? null : (
            <span className="rounded-full bg-emerald-500/10 px-1.5 text-emerald-700 dark:text-emerald-300">
              found {formatCount(record.uses)}×
            </span>
          )}
          {record.recap ? <span className="rounded-full bg-muted px-1.5">archive recap</span> : null}
        </p>
      </div>
      <MemoryActions title={record.title} url={record.url} deleting={deleting} onDelete={onDelete} />
    </li>
  );
}

/** A record the memory is about, as "name · type", opening it in Lobu; "#id" when Lobu could not read it. */
function EntityChip({ entity }: { entity: LinkedEntity }) {
  const label =
    entity.name === null ? (
      `#${entity.id}`
    ) : (
      <>
        {entity.name}
        {entity.type === null ? null : <span className="opacity-60"> · {entity.type}</span>}
      </>
    );
  const className = "rounded-full border border-border px-1.5";
  return entity.url === null ? (
    <span className={className} title={`Lobu record #${entity.id}`}>
      {label}
    </span>
  ) : (
    <UrlLink href={entity.url} className={cn(className, "hover:text-foreground")} title={`Lobu record #${entity.id}`}>
      {label}
    </UrlLink>
  );
}

function sessionName(session: SavedSession): string {
  if (session.kind === "terminal") return "From the terminal";
  if (session.kind === "project") return "Notes you added";
  return session.title ?? "A thread bb no longer has";
}

/** One session: the thread that learned something, and what it saved. */
function SessionBlock({
  session,
  records,
  deleting,
  onDelete,
}: {
  session: SavedSession;
  records: ReadonlyMap<string, LinkedEntity>;
  deleting: string | null;
  onDelete: (record: SessionMemory) => void;
}) {
  const navigate = useBbNavigate();
  const opensThread = session.kind === "thread" && session.title !== null;
  const newest = session.records[0]?.savedAt ?? null;
  const facts = [
    newest === null ? null : sinceMs(newest),
    session.startedWith === null ? null : `started with ${formatCount(session.startedWith)}`,
    session.lookedUp === null ? null : `looked up ${formatCount(session.lookedUp)}`,
    `saved ${formatCount(session.records.length)}`,
  ].filter((fact): fact is string => fact !== null);
  return (
    <li className="py-3">
      <div className="flex min-w-0 items-center gap-2">
        {opensThread ? (
          <button
            type="button"
            className="min-w-0 truncate text-left text-sm font-medium hover:underline"
            onClick={() => navigate.toThread(session.threadId)}
          >
            {sessionName(session)}
          </button>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium">{sessionName(session)}</span>
        )}
        {session.archived ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">archived</span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
      <ul className="mt-1 divide-y divide-border border-l border-border pl-3">
        {session.records.map((record) => (
          <SessionRow
            key={`${record.workspace}-${record.eventId}`}
            record={record}
            entities={(record.entityIds ?? []).flatMap((id) => {
              const entity = records.get(`${record.workspace}:${id}`);
              return entity === undefined ? [] : [entity];
            })}
            deleting={deleting === `delete-${record.eventId}`}
            onDelete={() => onDelete(record)}
          />
        ))}
      </ul>
    </li>
  );
}

/**
 * The New thread screen's record of what threads in the project taught Lobu:
 * each session, what it started with and looked up, and what it saved.
 */
export function ProjectSessions({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [sessions, setSessions] = useState<SavedSession[] | null>(null);
  const [open, setOpen] = useState(false);
  const { busy, error, notice, run } = useActions();
  // Record names come after the list, so a slow Lobu read never holds it up.
  const [records, setRecords] = useState<ReadonlyMap<string, LinkedEntity>>(new Map());
  useEffect(() => {
    const refs = new Map<string, { workspace: string; id: number }>();
    for (const session of sessions ?? []) {
      for (const record of session.records) {
        for (const id of record.entityIds ?? []) refs.set(`${record.workspace}:${id}`, { workspace: record.workspace, id });
      }
    }
    if (refs.size === 0) return;
    let current = true;
    rpc.call("linkedRecords", { records: [...refs.values()].slice(0, 200) }).then(
      (page) => {
        if (current) setRecords(new Map(page.records.map((entity) => [`${entity.workspace}:${entity.id}`, entity])));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [rpc, sessions]);
  const load = useCallback(
    () =>
      rpc.call("savedMemories", { projectId }).then(
        (page) => setSessions(page.sessions),
        () => setSessions(null),
      ),
    [rpc, projectId],
  );
  useEffect(() => {
    setSessions(null);
    void load();
    return onMemoryDeleted(() => void load());
  }, [load]);
  if (sessions === null || sessions.length === 0) return null;
  const memories = sessions.reduce((sum, session) => sum + session.records.length, 0);
  return (
    <section className="space-y-1 rounded-lg border border-border px-4 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {formatCount(memories)} {memories === 1 ? "memory" : "memories"} saved in {formatCount(sessions.length)} recent{" "}
          {sessions.length === 1 ? "session" : "sessions"}.
        </p>
        <Button variant="ghost" size="sm" onClick={() => setOpen((shown) => !shown)}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open ? (
        <div className="space-y-2 pb-2">
          <ul className="divide-y divide-border">
            {sessions.map((session) => (
              <SessionBlock
                key={session.threadId}
                session={session}
                records={records}
                deleting={busy}
                onDelete={(record) =>
                  void run(`delete-${record.eventId}`, async () => {
                    await rpc.call("undoMemory", { eventId: record.eventId });
                    memoryDeleted();
                    return `Deleted "${record.title}". It stays recoverable in Lobu.`;
                  })
                }
              />
            ))}
          </ul>
          <Status error={error} notice={notice} />
          <SavedInLobu />
        </div>
      ) : null}
    </section>
  );
}

const THREAD_POLL_MS = 15_000;

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

/** The thread's Lobu memory panel: what it started with, looked up, and saved. */
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
  const { project, log, startedWith } = data;
  const given = startedWith;
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
            {given
              .filter((item) => item.source === "pinned")
              .map((item, index) => (
                <li key={`${item.eventId ?? "note"}-${index}`} className="flex items-center gap-2 py-2 text-sm">
                  <Icon name="lobu/pin" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">pinned</span>
                </li>
              ))}
            <LearnedGroups items={given.filter((item) => item.source === "learned")} />
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
          shareWorkspace={project?.workspace ?? null}
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
