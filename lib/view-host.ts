// What a Lobu view mounted in bb chat may ask its host to run. The view runs
// with the user's own Lobu login, so this is the line between "the view reads
// the workspace" and "the view acts as the user": reads and the view's own
// declared actions pass, every other tool is refused. Lobu's web host draws the
// same line (owletto `view-frame.tsx` `brokeredRequest`); the server still
// applies the user's authorization and workspace scope to every call.

/** The SDK read tools; their activity-feed title defaults to the view's. */
const SDK_READ_TOOLS = new Set(["query_sql", "query_sdk"]);
const MAX_CALL_TITLE = 120;

/**
 * Mixed read/write tools admitted only for fixed read actions. Mirrors
 * `isViewRead` in `@lobu/core/contracts/tools/view-host`, which the published
 * package does not export.
 */
export function isViewRead(tool: string, args: Record<string, unknown> | undefined): boolean {
  if (tool === "read_knowledge") return true;
  if (tool === "manage_entity") return args?.action === "list" || args?.action === "get" || args?.action === "list_links";
  if (tool === "manage_feeds") {
    return args?.action === "list_feeds" || args?.action === "read_feed" || args?.action === "read_feeds";
  }
  if (tool === "manage_automations") return args?.action === "list";
  if (tool === "manage_agents") return args?.action === "get";
  if (tool === "manage_connections") return args?.action === "list";
  if (tool === "manage_catalog") return args?.action === "list_installed";
  return (
    tool === "manage_entity_schema" &&
    args?.schema_type === "entity_type" &&
    (args.action === "list" || args.action === "get")
  );
}

/** The tools Lobu's registry marks `readOnlyHint: true`, from `GET /api/:org/tools`. */
export function readOnlyToolNames(listing: unknown): Set<string> {
  const tools = (listing as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return new Set();
  return new Set(
    tools.flatMap((tool: { name?: unknown; annotations?: { readOnlyHint?: unknown } }) =>
      typeof tool?.name === "string" && tool.annotations?.readOnlyHint === true ? [tool.name] : [],
    ),
  );
}

export interface MountedView {
  workspace: string;
  view: string;
  /** The bundle on screen; an action names it so a re-saved view answers 409. */
  contentHash: string | null;
  title: string;
  /** The event the view is open on, as `open_view` resolved it. */
  event?: number;
}

export type ViewCallRequest = { path: string; body: unknown } | { error: string };

/** Where one guest `tools/call` goes on Lobu's REST API, or why it is refused. */
export function viewCallRequest(
  mounted: MountedView,
  name: string,
  args: Record<string, unknown> | undefined,
  readOnly: ReadonlySet<string>,
): ViewCallRequest {
  const org = encodeURIComponent(mounted.workspace);
  if (name !== "invoke_view_action") {
    const sdkRead = SDK_READ_TOOLS.has(name);
    if (!sdkRead && !isViewRead(name, args) && !readOnly.has(name)) {
      return { error: `Views can only call read tools and their declared actions; "${name}" is neither` };
    }
    const own = args?.title;
    const titled = sdkRead && !(typeof own === "string" && own.trim() !== "");
    return {
      path: `/api/${org}/${encodeURIComponent(name)}`,
      body: titled ? { ...args, title: mounted.title.slice(0, MAX_CALL_TITLE) } : (args ?? {}),
    };
  }
  const { view, action, value, interaction_id, scope, expected } = args ?? {};
  // An action names the event it was made on; it must be the one on screen.
  if (scope !== undefined && (!isObject(scope) || scope.event !== mounted.event)) {
    return { error: "The event context changed. Reopen the event before submitting." };
  }
  if (view !== mounted.view) return { error: `This frame hosts "${mounted.view}", not "${String(view)}"` };
  if (typeof action !== "string" || action === "") return { error: "action is required" };
  return {
    path: `/api/${org}/views/${encodeURIComponent(mounted.view)}/actions/${encodeURIComponent(action)}`,
    body: {
      value: value ?? null,
      interaction_id,
      ...(expected === undefined ? {} : { expected }),
      ...(mounted.contentHash === null ? {} : { expected_content_hash: mounted.contentHash }),
      ...(mounted.event === undefined ? {} : { scope: { event: mounted.event } }),
    },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a view opens for, as `open_view` takes it: a type, a record, or one event. */
export interface ViewScope {
  type?: string;
  /** A stored entity id, or a source key, which then needs `type`. */
  entity?: number | string;
  event?: number;
  /** The type's list filter; Lobu validates it. */
  collection?: unknown;
}

export type ViewParams = Record<string, string | number | boolean>;

/** Which scope fields combine: the rule `open_view` applies (`viewScopeShapeError` in core). */
export function viewScopeShapeError(scope: ViewScope): string | null {
  if (scope.collection !== undefined && (!scope.type || scope.entity !== undefined || scope.event !== undefined)) {
    return "A collection selection needs a type, without an entity or event";
  }
  if (scope.event !== undefined && (scope.type !== undefined || scope.entity !== undefined)) {
    return "An event names the view's subject on its own; drop type and entity";
  }
  if (typeof scope.entity === "string" && !scope.type) return "A record's source key needs its type";
  return null;
}

const positiveId = (text: string): number | null => {
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 && String(id) === text ? id : null;
};

/** The subject attributes: `open_view`'s scope fields, prefixed so they never take a view param's name (views declare `type`). */
const SCOPE_ATTRIBUTES = new Set(["scope-type", "scope-entity", "scope-event"]);

/**
 * A `::lobu-view` directive's attributes: `workspace` and `view` name it,
 * `scope-type`, `scope-entity` and `scope-event` are its subject, and every other attribute is a
 * view param, still a string (the server types it against the view's params).
 */
export function directiveTarget(
  attributes: Readonly<Record<string, string>>,
): { workspace: string; view: string; scope: ViewScope; params: ViewParams } | { error: string } {
  const workspace = (attributes.workspace ?? "").trim();
  const view = (attributes.view ?? "").trim();
  if (workspace === "" || view === "") return { error: "A Lobu view needs a workspace and a view." };
  const scope: ViewScope = {};
  const type = attributes["scope-type"]?.trim();
  if (type) scope.type = type;
  const entity = attributes["scope-entity"]?.trim();
  if (entity) scope.entity = positiveId(entity) ?? entity;
  const event = attributes["scope-event"]?.trim();
  if (event) {
    const id = positiveId(event);
    if (id === null) return { error: `scope-event must be an event id, not "${event}".` };
    scope.event = id;
  }
  const shape = viewScopeShapeError(scope);
  if (shape !== null) return { error: shape };
  const params: ViewParams = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (name !== "workspace" && name !== "view" && !SCOPE_ATTRIBUTES.has(name)) params[name] = value;
  }
  return { workspace, view, scope, params };
}

/**
 * String params typed against the view's declarations (`manage_views list`),
 * since `open_view` refuses a number param given as text. A value that does
 * not parse stays a string, so Lobu's own error names the param.
 */
export function coerceViewParams(declared: unknown, params: ViewParams): ViewParams {
  const types = isObject(declared) ? declared : {};
  const typed: ViewParams = {};
  for (const [name, value] of Object.entries(params)) {
    const decl = types[name];
    const type = isObject(decl) ? decl.type : undefined;
    if (typeof value !== "string") typed[name] = value;
    else if (type === "number" && value.trim() !== "" && Number.isFinite(Number(value))) typed[name] = Number(value);
    else if (type === "boolean" && (value === "true" || value === "false")) typed[name] = value === "true";
    else typed[name] = value;
  }
  return typed;
}

/** Child views one view may show at once (`VIEW_EMBED_MAX_COUNT` in core). */
export const VIEW_EMBED_MAX_COUNT = 8;
/** Nesting below the directive's view: a child may embed, a grandchild may not. */
export const VIEW_EMBED_MAX_DEPTH = 2;
const VIEW_EMBED_MAX_PARAMS = 20;
const MAX_KEY = 64;

export interface EmbedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One slot a view reported: where its child goes, in the view's own viewport. */
export interface EmbedSlot {
  id: string;
  view: string;
  scope: ViewScope;
  params: ViewParams;
  /** `clip` is the part the view shows; absent means all of it. */
  rect: EmbedBox & { clip?: EmbedBox };
}

export type EmbedStatus =
  | { id: string; status: "mounted" }
  | { id: string; status: "refused"; reason: "cycle" | "depth" | "limit" | "invalid" };

function box(value: unknown, sized: boolean): EmbedBox | null {
  if (!isObject(value)) return null;
  const { x, y, width, height } = value;
  const finite = [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n));
  if (!finite || (sized && ((width as number) < 0 || (height as number) < 0))) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

const key = (value: unknown): value is string => typeof value === "string" && value !== "" && value.length <= MAX_KEY;

function parseSlot(entry: unknown): EmbedSlot | null {
  if (!isObject(entry) || !key(entry.id) || !key(entry.view)) return null;
  const rawScope = entry.scope ?? {};
  if (!isObject(rawScope) || Object.keys(rawScope).some((name) => !["type", "entity", "event", "collection"].includes(name))) {
    return null;
  }
  const { type, entity, event, collection } = rawScope;
  if (type !== undefined && !(typeof type === "string" && type !== "" && type.length <= 128)) return null;
  if (entity !== undefined && !(typeof entity === "string" ? entity !== "" && entity.length <= 1024 : positiveNumber(entity))) {
    return null;
  }
  if (event !== undefined && !positiveNumber(event)) return null;
  const scope: ViewScope = {
    ...(type === undefined ? {} : { type: type as string }),
    ...(entity === undefined ? {} : { entity: entity as number | string }),
    ...(event === undefined ? {} : { event: event as number }),
    ...(collection === undefined ? {} : { collection }),
  };
  if (viewScopeShapeError(scope) !== null) return null;
  const rawParams = entry.params ?? {};
  if (!isObject(rawParams) || Object.keys(rawParams).length > VIEW_EMBED_MAX_PARAMS) return null;
  const params: ViewParams = {};
  for (const [name, value] of Object.entries(rawParams)) {
    if (typeof value === "string" ? value.length > 2000 : typeof value === "number" ? !Number.isFinite(value) : typeof value !== "boolean") {
      return null;
    }
    params[name] = value as string | number | boolean;
  }
  const rect = box(entry.rect, true);
  if (rect === null || !isObject(entry.rect)) return null;
  const clip = entry.rect.clip === undefined ? undefined : box(entry.rect.clip, true);
  if (clip === null) return null;
  return { id: entry.id, view: entry.view, scope, params, rect: clip === undefined ? rect : { ...rect, clip } };
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Which reported slots a frame mounts, as Lobu's web host plans them (owletto
 * `view-embeds.tsx`). `ancestry` is every view key above and including this
 * frame's own, outermost first: a view never contains itself or an ancestor.
 */
export function planEmbeds(
  raw: readonly unknown[],
  ancestry: readonly string[],
): { instances: EmbedSlot[]; statuses: EmbedStatus[] } {
  const instances: EmbedSlot[] = [];
  const statuses: EmbedStatus[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const slot = parseSlot(entry);
    const rawId = isObject(entry) && typeof entry.id === "string" ? entry.id.slice(0, MAX_KEY) : null;
    const id = slot?.id ?? rawId;
    if (id === null) continue;
    if (slot === null || seen.has(id)) {
      statuses.push({ id, status: "refused", reason: "invalid" });
      continue;
    }
    seen.add(id);
    if (ancestry.includes(slot.view)) statuses.push({ id, status: "refused", reason: "cycle" });
    else if (ancestry.length > VIEW_EMBED_MAX_DEPTH) statuses.push({ id, status: "refused", reason: "depth" });
    else if (instances.length >= VIEW_EMBED_MAX_COUNT) statuses.push({ id, status: "refused", reason: "limit" });
    else {
      instances.push(slot);
      statuses.push({ id, status: "mounted" });
    }
  }
  return { instances, statuses };
}
