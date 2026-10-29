// The Lobu page: Lobu's own events view, filtered to what bb saved, for the
// CLI login picked at the top. The plugin server swaps that login for a Lobu
// web session; the frame signs in through Lobu's bootstrap page with it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { CliContextOption, rpcContract } from "@/lib/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorText } from "@/lib/format";
import { cn } from "@/lib/utils";

const CONTEXT_KEY = "lobu.app.context";
/** How often the page checks whether a new context finished its browser login. */
const LOGIN_POLL_MS = 3_000;
/** The bootstrap page is the frame's first load and Lobu's home its second; the saved events come next. */
const LANDED_LOADS = 2;
/** Shows the frame anyway if sign-in stalls, so Lobu's own error is visible. */
const REVEAL_AFTER_MS = 10_000;

/** A picker entry; name is null for "whatever context the CLI has active". */
type Choice = Omit<CliContextOption, "name"> & { name: string | null };
type Frame = { origin: string; path: string | null; signInUrl: string | null };

function readContext(): string | null {
  try {
    return localStorage.getItem(CONTEXT_KEY);
  } catch {
    return null;
  }
}

function storeContext(name: string) {
  try {
    localStorage.setItem(CONTEXT_KEY, name);
  } catch {
    // Storage can be unavailable; the choice then lasts for this visit.
  }
}

const host = (origin: string) => origin.replace(/^https?:\/\//, "");

const field =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

function NewContext({ onAdded }: { onAdded: (name: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://app.lobu.ai");
  const [waiting, setWaiting] = useState<{ name: string; approvalUrl: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The CLI finishes the login once the user approves it; watch for that.
  useEffect(() => {
    if (waiting === null) return;
    const timer = setInterval(() => {
      rpc.call("lobuContexts", {}).then(({ contexts }) => {
        if (contexts.some((c) => c.name === waiting.name && c.loggedIn)) onAdded(waiting.name);
      }, () => undefined);
    }, LOGIN_POLL_MS);
    return () => clearInterval(timer);
  }, [rpc, waiting, onAdded]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    rpc.call("addContext", { name, url }).then(
      ({ approvalUrl }) => setWaiting({ name: name.trim(), approvalUrl }),
      (cause: unknown) => setError(errorText(cause)),
    ).finally(() => setBusy(false));
  };

  if (waiting !== null) {
    return (
      <p className="px-4 py-2 text-xs text-muted-foreground">
        Approve the {waiting.name} login in your browser. This page switches to it once you do.
        {waiting.approvalUrl === null ? null : (
          <>
            {" "}
            <UrlLink href={waiting.approvalUrl} className="text-foreground underline">
              Open the approval page
            </UrlLink>
          </>
        )}
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 px-4 py-2">
      <input aria-label="Context name" placeholder="Name" required value={name} onChange={(e) => setName(e.target.value)} className={cn(field, "w-36")} />
      <input aria-label="Lobu URL" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} className={cn(field, "w-64")} />
      <Button type="submit" size="sm" disabled={busy}>
        Add and sign in
      </Button>
      {error === null ? null : (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </form>
  );
}

function SavedFrame({ frame }: { frame: Frame & { path: string; signInUrl: string } }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), REVEAL_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  // Lobu's bootstrap page always lands on home; move the signed-in frame on to the saved events.
  const onLoad = () => {
    loads.current += 1;
    if (loads.current === LANDED_LOADS && ref.current !== null) ref.current.src = `${frame.origin}${frame.path}`;
    if (loads.current > LANDED_LOADS) setShown(true);
  };
  return (
    <div className="relative flex min-h-0 flex-1">
      {shown ? null : <p className="absolute inset-x-0 top-0 px-4 py-6 text-center text-sm text-muted-foreground">Signing in to Lobu…</p>}
      <iframe
        ref={ref}
        src={frame.signInUrl}
        onLoad={onLoad}
        title="Saved to Lobu"
        className={cn("min-h-0 w-full flex-1 border-0 bg-background", !shown && "invisible")}
        referrerPolicy="no-referrer"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}

export function LobuApp() {
  const rpc = useRpc<typeof rpcContract>();
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [savesTo, setSavesTo] = useState("");
  const [picked, setPicked] = useState<string | null>(readContext);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reloads, setReloads] = useState(0);

  const loadContexts = useCallback(() => {
    rpc.call("lobuContexts", {}).then(
      ({ contexts, fallbackOrigin }) => {
        setSavesTo(fallbackOrigin);
        setChoices(contexts.length > 0 ? contexts : [{ name: null, origin: fallbackOrigin, current: true, loggedIn: true }]);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(loadContexts, [loadContexts]);

  const active =
    choices === null
      ? null
      : (choices.find((c) => c.name === picked && c.loggedIn) ?? choices.find((c) => c.current && c.loggedIn) ?? choices[0] ?? null);
  const activeName = active?.name ?? null;

  useEffect(() => {
    if (choices === null) return;
    let live = true;
    setFrame(null);
    setError(null);
    rpc.call("lobuApp", { context: activeName }).then(
      (next) => live && setFrame(next),
      (cause: unknown) => live && setError(errorText(cause)),
    );
    return () => {
      live = false;
    };
  }, [rpc, choices, activeName, reloads]);

  const pick = (name: string) => {
    setPicked(name);
    storeContext(name);
  };
  const onAdded = useCallback(
    (name: string) => {
      setAdding(false);
      pick(name);
      loadContexts();
    },
    [loadContexts],
  );

  const label = (c: Choice) => `${c.name ?? "Active login"} · ${host(c.origin)}${c.loggedIn ? "" : " (signed out)"}`;
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2 text-sm">
        <span className="mr-auto font-medium">Saved to Lobu</span>
        {choices === null ? null : (
          <select
            aria-label="Lobu context"
            className="h-8 max-w-64 cursor-pointer rounded-md border border-input bg-transparent px-2 text-xs"
            value={activeName ?? ""}
            onChange={(event) => pick(event.target.value)}
          >
            {choices.map((c) => (
              <option key={c.name ?? ""} value={c.name ?? ""} disabled={!c.loggedIn}>
                {label(c)}
              </option>
            ))}
          </select>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="New context"
          aria-expanded={adding}
          onClick={() => setAdding((open) => !open)}
        >
          <Icon name={adding ? "lobu/close" : "lobu/plus"} className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Reload" onClick={() => setReloads((n) => n + 1)}>
          <Icon name="lobu/refresh" className={cn("size-4", frame === null && error === null && "animate-spin")} />
        </Button>
        {frame?.path == null ? null : (
          <UrlLink href={`${frame.origin}${frame.path}`} className="px-2 text-xs text-muted-foreground hover:text-foreground">
            Open in browser
          </UrlLink>
        )}
      </div>
      {adding ? (
        <div className="border-b border-border">
          <NewContext onAdded={onAdded} />
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : frame === null ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : frame.path === null || frame.signInUrl === null ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {savesTo !== "" && frame.origin !== savesTo
            ? `bb saves memories to ${host(savesTo)}, so there is nothing from bb on ${host(frame.origin)}.`
            : "Nothing bb saved is in this login's workspaces yet. Agents save decisions, gotchas, and standing preferences as they work."}
        </p>
      ) : (
        <SavedFrame key={`${frame.signInUrl}`} frame={{ ...frame, path: frame.path, signInUrl: frame.signInUrl }} />
      )}
    </div>
  );
}
