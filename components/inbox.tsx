// The New thread screen's inbox: unread Lobu notifications in the login's
// personal workspace, like the Mac app's Inbox section. Open jumps to the
// notification in Lobu; Mark read clears it here. Quiet when empty or
// unreachable — the project brief below stays the source of truth.
import { useCallback, useEffect, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/lib/contract";
import { Button } from "@/components/ui/button";
import { Frame } from "@/components/setup";
import { cn } from "@/lib/utils";

interface InboxItem {
  id: number;
  type: string;
  title: string;
  body: string | null;
  resourceUrl: string | null;
  isRead: boolean;
  createdAt: string;
}

function timeAgo(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const snippet = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 200);

/** How many rows a compact section shows before "Show all". */
const COMPACT_ROWS = 5;

export function InboxSection({ defaultOpen = false, compact = false }: { defaultOpen?: boolean; compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  // A compact section (the Lobu page) keeps the first rows in view and lets
  // the rest unfold on request instead of pushing everything else down.
  const [expanded, setExpanded] = useState(false);
  // Nothing is fetched until the user opens the section — the card renders
  // instantly and the inbox populates lazily with a loading row.
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (next: number | null, append: boolean) => {
      if (!append) setLoading(true);
      try {
        const page = await rpc.call("inbox", { cursor: next });
        setWorkspace(page.workspace);
        setUnread(page.unreadCount);
        setItems((prev) => (append ? [...prev, ...page.notifications] : page.notifications));
        setCursor(page.nextCursor);
        setUrl(page.url);
        setLoaded(true);
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        if (!append) setLoading(false);
      }
    },
    [rpc],
  );

  const toggle = () => {
    setOpen((was) => {
      if (!was && !loaded) void load(null, false);
      return !was;
    });
  };

  // A section that starts open (the Lobu page) loads on mount instead of
  // waiting for a click; the New thread screen keeps loading lazily.
  useEffect(() => {
    if (defaultOpen) void load(null, false);
  }, [defaultOpen, load]);

  const markRead = (id: number) => {
    if (workspace === null || busyId !== null) return;
    setBusyId(id);
    rpc
      .call("markNotificationRead", { notificationId: id, workspace })
      .then(
        () => {
          setItems((prev) => prev.map((item) => (item.id === id ? { ...item, isRead: true } : item)));
          setUnread((count) => Math.max(0, count - 1));
        },
        () => undefined,
      )
      .finally(() => setBusyId(null));
  };

  // The section stays put once connected: an explicit empty line beats
  // vanishing, so empty is never confused with broken. Failures stay inside
  // the opened section with a retry — the rest of the page is unaffected.
  const empty = loaded && !failed && items.length === 0;
  const heading = !loaded ? "Inbox" : unread > 0 ? `Inbox · ${unread} unread` : "Inbox";
  const shown = compact && !expanded ? items.slice(0, COMPACT_ROWS) : items;
  const hidden = items.length - shown.length;
  return (
    <Frame
      header={
        <button type="button" onClick={toggle} className="flex w-full items-center gap-1.5 text-left">
          <span className="inline-block w-3 text-center text-xs text-muted-foreground">{open ? "▾" : "▸"}</span>
          <h3 className="text-sm font-medium">{heading}</h3>
        </button>
      }
    >
      {open && (
        <div className="space-y-2.5">
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : failed ? (
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">Couldn’t load notifications.</p>
              <Button variant="outline" size="sm" onClick={() => void load(null, false)}>
                Retry
              </Button>
            </div>
          ) : empty ? (
            <p className="text-xs text-muted-foreground">No notifications. You’re all caught up.</p>
          ) : (
            <>
              {shown.map((item) => (
                <div key={item.id} className="space-y-0.5">
                  <div className="flex items-baseline gap-2">
                    <p className={cn("min-w-0 flex-1 truncate text-sm", !item.isRead && "font-semibold")}>{item.title}</p>
                    {item.createdAt === "" ? null : (
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.createdAt)}</span>
                    )}
                  </div>
                  {item.body === null || item.body.trim() === "" ? null : (
                    <p className="truncate text-xs text-muted-foreground">{snippet(item.body)}</p>
                  )}
                  <div className="flex items-center gap-2">
                    {item.resourceUrl === null ? null : (
                      <UrlLink href={item.resourceUrl} className="text-xs text-foreground underline">
                        Open
                      </UrlLink>
                    )}
                    {item.isRead ? null : (
                      <Button variant="ghost" size="sm" disabled={busyId !== null} onClick={() => markRead(item.id)}>
                        {busyId === item.id ? "Marking…" : "Mark read"}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {hidden > 0 ? (
                  <Button variant="outline" size="sm" onClick={() => setExpanded(true)}>
                    Show all {items.length}
                  </Button>
                ) : cursor === null ? null : (
                  <Button variant="outline" size="sm" onClick={() => void load(cursor, true)}>
                    Show more
                  </Button>
                )}
                {url === null ? null : (
                  <UrlLink href={url} className="text-xs text-muted-foreground underline">
                    Open all in Lobu
                  </UrlLink>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Frame>
  );
}
