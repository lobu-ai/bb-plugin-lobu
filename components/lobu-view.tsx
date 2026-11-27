// `::lobu-view{workspace="…" view="…"}` in an assistant message: the Lobu
// view rendered inline. The shell comes from the plugin server (the CLI login
// stays there) and mounts `srcdoc` in a sandboxed frame with an opaque origin.
// `ViewFrame` is the view's MCP Apps host, speaking the same JSON-RPC over
// postMessage as Lobu's web host (owletto `view-frame.tsx`): the handshake,
// the subject and params, theme, size, links, records, `tools/call` (which the
// server brokers to reads and the view's own declared actions), and embedded
// views, each mounted as its own frame over the slot its parent reports.
import { experimental_useCodeTheme, type PluginMessageDirectiveProps, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { rpcContract } from "@/lib/contract";
import {
  directiveTarget,
  type EmbedSlot,
  planEmbeds,
  type ViewParams,
  type ViewScope,
} from "@/lib/view-host";

const PROTOCOL_VERSION = "2026-01-26";
const MIN_HEIGHT = 120;
/** A taller view scrolls inside its frame instead of pushing the thread away. */
const MAX_HEIGHT = 720;
const INITIAL_HEIGHT = 360;
/** The bar above each embedded view that names it and links its page. */
const EMBED_HEADER_HEIGHT = 28;

/** bb's design tokens as the MCP Apps standard style variables, as Lobu's web host maps them. */
const HOST_STYLE_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["--color-background-primary", "--background"],
  ["--color-background-secondary", "--card"],
  ["--color-background-tertiary", "--muted"],
  ["--color-background-inverse", "--foreground"],
  ["--color-text-primary", "--foreground"],
  ["--color-text-secondary", "--muted-foreground"],
  ["--color-text-inverse", "--background"],
  ["--color-text-info", "--primary"],
  ["--color-text-danger", "--destructive"],
  ["--color-border-primary", "--border"],
  ["--color-border-secondary", "--input"],
  ["--color-border-danger", "--destructive"],
  ["--color-ring-primary", "--ring"],
  ["--font-mono", "--font-mono"],
  ["--border-radius-sm", "--radius-sm"],
  ["--border-radius-md", "--radius-md"],
  ["--border-radius-lg", "--radius-lg"],
  ["--border-radius-xl", "--radius-xl"],
];

function styleVariables(): Record<string, string> {
  const tokens = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};
  for (const [key, token] of HOST_STYLE_TOKENS) {
    const value = tokens.getPropertyValue(token).trim();
    if (value !== "") variables[key] = value;
  }
  const font = document.body ? getComputedStyle(document.body).fontFamily : "";
  if (font !== "") variables["--font-sans"] = font;
  return variables;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function openPage(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

class MethodNotFound extends Error {}

type FocusDirection = "forward" | "backward";

interface Opened {
  html: string;
  contentHash: string | null;
  url: string;
  scope: ViewScope;
  params: ViewParams;
}

export function LobuViewDirective({ attributes }: PluginMessageDirectiveProps) {
  const targetKey = JSON.stringify(directiveTarget(attributes));
  const target = useMemo(() => JSON.parse(targetKey) as ReturnType<typeof directiveTarget>, [targetKey]);
  const [url, setUrl] = useState<string | null>(null);
  if ("error" in target) return <Notice text={`Couldn’t show the Lobu view: ${target.error}`} />;
  return (
    <div className="my-2">
      <div className="overflow-hidden rounded-md border border-border">
        <ViewFrame {...target} ancestry={[]} onOpened={setUrl} />
      </div>
      {url === null ? null : (
        <div className="mt-1 flex justify-end">
          <UrlLink href={url} className="text-xs text-muted-foreground underline">
            Open in Lobu
          </UrlLink>
        </div>
      )}
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return <p className="px-3 py-2 text-xs text-muted-foreground">{text}</p>;
}

interface ViewFrameProps {
  workspace: string;
  view: string;
  scope: ViewScope;
  params: ViewParams;
  /** The view keys above this frame, outermost first. */
  ancestry: readonly string[];
  /** The view's Lobu page, once opened. */
  onOpened?: (url: string | null) => void;
  /** Set for an embedded view, which fills the slot its parent sized for it. */
  embedded?: {
    onHeight: (height: number) => void;
    /** Hands the parent the way to move keyboard focus into this view. */
    registerFocus: (enter: ((direction: FocusDirection) => void) | null) => void;
  };
}

/** One mounted Lobu view: its frame, its bridge, and the children it embeds. */
function ViewFrame({ workspace, view, scope, params, ancestry, onOpened, embedded }: ViewFrameProps) {
  const rpc = useRpc<typeof rpcContract>();
  const { mode } = experimental_useCodeTheme();
  const request = JSON.stringify({ workspace, view, scope, params });

  const [opened, setOpened] = useState<Opened | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [embeds, setEmbeds] = useState<EmbedSlot[]>([]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  const embeddedRef = useRef(embedded);
  embeddedRef.current = embedded;
  const ancestryRef = useRef(ancestry);
  ancestryRef.current = ancestry;
  /** Each child's focus entry, by slot id. */
  const childFocus = useRef(new Map<string, (direction: FocusDirection) => void>());
  /** Sends a host notification to this view's guest. */
  const notifyRef = useRef<((method: string, params: Record<string, unknown>) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOpened(null);
    setFailure(null);
    setEmbeds([]);
    // The previous target's page must not stay linked while this one opens or fails.
    onOpenedRef.current?.(null);
    rpc
      .call("viewOpen", JSON.parse(request))
      .then((next) => {
        if (cancelled) return;
        setOpened(next);
        onOpenedRef.current?.(next.url);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setFailure(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, request]);

  // The host side of the bridge, for as long as this view is mounted.
  useEffect(() => {
    const frame = frameRef.current;
    if (opened === null || frame === null) return;
    let disposed = false;
    const post = (message: Record<string, unknown>) => frame.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*");
    const notify = (method: string, params: Record<string, unknown>) => post({ method, params });
    notifyRef.current = notify;
    embeddedRef.current?.registerFocus((direction) => {
      frame.focus();
      notify("lobu/notifications/focus-enter", { direction });
    });
    const hostContext = () => ({
      theme: modeRef.current,
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { width: frame.clientWidth, maxHeight: embeddedRef.current ? undefined : MAX_HEIGHT },
      platform: "web",
      styles: { variables: styleVariables() },
    });

    async function answer(method: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (opened === null) throw new Error("View unmounted");
      switch (method) {
        case "ui/initialize":
          return {
            protocolVersion: PROTOCOL_VERSION,
            hostInfo: { name: "bb", version: "1.0.0" },
            hostCapabilities: { openLinks: {}, serverTools: {}, updateModelContext: { structuredContent: {} } },
            hostContext: hostContext(),
          };
        case "tools/call":
          try {
            return await rpc.call("viewCall", {
              workspace,
              view,
              contentHash: opened.contentHash,
              ...(opened.scope.event === undefined ? {} : { event: opened.scope.event }),
              name: typeof request.name === "string" ? request.name : "",
              arguments: isRecord(request.arguments) ? request.arguments : undefined,
            });
          } catch (cause) {
            return { content: [{ type: "text", text: messageOf(cause) }], isError: true };
          }
        case "ui/open-link": {
          let parsed: URL | null = null;
          try {
            parsed = new URL(typeof request.url === "string" ? request.url : "");
          } catch {
            parsed = null;
          }
          // HTTPS anywhere; plain HTTP only to the Lobu the view came from (a local install).
          if (parsed === null) return { isError: true };
          const local = parsed.protocol === "http:" && parsed.origin === new URL(opened.url).origin;
          if (parsed.protocol !== "https:" && !local) return { isError: true };
          openPage(parsed.href);
          return {};
        }
        // A record opens on its Lobu page: bb has no record pane to peek it in.
        case "lobu/open-record": {
          const record = isRecord(request.record) ? request.record : {};
          const { url } = await rpc.call("viewOpenRecord", {
            workspace,
            record: {
              entity_id: record.entity_id as number | string,
              ...(record.entity_type === undefined ? {} : { entity_type: record.entity_type as string | number }),
            },
          });
          openPage(url);
          return { mode: "page" };
        }
        case "lobu/embeds/sync": {
          const plan = planEmbeds(Array.isArray(request.embeds) ? request.embeds.slice(0, 64) : [], [...ancestryRef.current, view]);
          setEmbeds(plan.instances);
          return { embeds: plan.statuses };
        }
        case "lobu/embeds/focus": {
          const enter = childFocus.current.get(typeof request.id === "string" ? request.id : "");
          if (enter === undefined) throw new Error("No such embedded view");
          enter(request.direction === "backward" ? "backward" : "forward");
          return {};
        }
        // Params live in the frame: a chat message has no address bar to keep them in.
        case "ui/update-model-context":
          return {};
        // Fullscreen is the view's own Lobu page.
        case "ui/request-display-mode":
          if (request.mode === "fullscreen") openPage(opened.url);
          return { mode: "inline" };
        case "ping":
          return {};
        default:
          throw new MethodNotFound(`Method not found: ${method}`);
      }
    }

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const data: unknown = event.data;
      if (!isRecord(data) || data.jsonrpc !== "2.0" || typeof data.method !== "string") return;
      const payload = isRecord(data.params) ? data.params : {};
      const id = data.id;
      if (typeof id !== "string" && typeof id !== "number") {
        if (data.method === "ui/notifications/initialized") {
          notify("ui/notifications/tool-input", { arguments: { scope: opened.scope, params: opened.params } });
        } else if (data.method === "ui/notifications/size-changed" && typeof payload.height === "number") {
          const reported = Math.ceil(payload.height);
          const parent = embeddedRef.current;
          if (parent) parent.onHeight(reported);
          else setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, reported)));
        }
        return;
      }
      answer(data.method, payload).then(
        (result) => {
          if (!disposed) post({ id, result });
        },
        (cause: unknown) => {
          if (disposed) return;
          post({ id, error: { code: cause instanceof MethodNotFound ? -32601 : -32603, message: messageOf(cause) } });
        },
      );
    };
    window.addEventListener("message", onMessage);
    return () => {
      disposed = true;
      notifyRef.current = null;
      embeddedRef.current?.registerFocus(null);
      window.removeEventListener("message", onMessage);
    };
  }, [rpc, opened, workspace, view]);

  // A light/dark switch re-sends the palette that is now showing.
  useEffect(() => {
    if (opened === null) return;
    notifyRef.current?.("ui/notifications/host-context-changed", { theme: mode, styles: { variables: styleVariables() } });
  }, [mode, opened]);

  if (failure !== null) return <Notice text={`Couldn’t show the Lobu view ${view}: ${failure}`} />;
  if (opened === null) return <Notice text="Loading Lobu view…" />;
  const frameHeight = embedded ? "100%" : height;
  return (
    <div className="relative" style={embedded ? { height: "100%" } : undefined}>
      <iframe
        ref={frameRef}
        title={`Lobu view ${view}`}
        srcDoc={opened.html}
        sandbox="allow-scripts"
        className="block w-full border-0"
        style={{ height: frameHeight, colorScheme: mode }}
      />
      {embeds.length === 0 ? null : (
        // Over the parent's frame and clipped to it: slot positions are in the
        // guest's viewport, which is this box.
        <div className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden" style={{ height: frameHeight }}>
          {embeds.map((slot) => (
            <EmbeddedView
              key={JSON.stringify([slot.id, slot.view, slot.scope])}
              workspace={workspace}
              slot={slot}
              ancestry={[...ancestry, view]}
              onHeight={(childHeight) => notifyRef.current?.("lobu/notifications/embed-size", { id: slot.id, height: childHeight })}
              onFocusExit={(direction) => notifyRef.current?.("lobu/notifications/embed-focus", { id: slot.id, direction })}
              registerFocus={(enter) => {
                if (enter === null) childFocus.current.delete(slot.id);
                else childFocus.current.set(slot.id, enter);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The part of a slot its parent shows, as a CSS inset; a slot shown not at all takes no clicks. */
function clipStyle(rect: EmbedSlot["rect"]): CSSProperties {
  const { clip } = rect;
  if (!clip) return {};
  if (clip.width <= 0 || clip.height <= 0) return { visibility: "hidden", pointerEvents: "none" };
  const top = Math.max(0, clip.y - rect.y);
  const left = Math.max(0, clip.x - rect.x);
  const bottom = Math.max(0, rect.y + rect.height - (clip.y + clip.height));
  const right = Math.max(0, rect.x + rect.width - (clip.x + clip.width));
  return top || left || bottom || right ? { clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px)` } : {};
}

/** One slot: a child view with its own shell, bridge and actions, which its parent cannot reach. */
function EmbeddedView({
  workspace,
  slot,
  ancestry,
  onHeight,
  onFocusExit,
  registerFocus,
}: {
  workspace: string;
  slot: EmbedSlot;
  ancestry: readonly string[];
  onHeight: (height: number) => void;
  onFocusExit: (direction: FocusDirection) => void;
  registerFocus: (enter: ((direction: FocusDirection) => void) | null) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  // Out of the page's tab order until focus is inside this child, so Tab
  // reaches it only through its slot in the parent.
  const [inside, setInside] = useState(false);
  const trapIndex = inside ? 0 : -1;
  const { rect } = slot;
  return (
    <section
      aria-label={slot.view}
      data-embed-id={slot.id}
      className="pointer-events-auto absolute flex flex-col overflow-hidden rounded-md border border-border bg-background"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, ...clipStyle(rect) }}
      onFocus={() => setInside(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInside(false);
      }}
    >
      <span tabIndex={trapIndex} onFocus={() => onFocusExit("backward")} />
      <div
        className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 text-xs text-muted-foreground"
        style={{ height: EMBED_HEADER_HEIGHT }}
      >
        <span className="truncate">{slot.view}</span>
        {url === null ? null : (
          <UrlLink href={url} className="rounded px-1 hover:text-foreground" tabIndex={trapIndex}>
            Open
          </UrlLink>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ViewFrame
          workspace={workspace}
          view={slot.view}
          scope={slot.scope}
          params={slot.params}
          ancestry={ancestry}
          onOpened={setUrl}
          embedded={{ onHeight: (height) => onHeight(height + EMBED_HEADER_HEIGHT), registerFocus }}
        />
      </div>
      <span tabIndex={trapIndex} onFocus={() => onFocusExit("forward")} />
    </section>
  );
}
