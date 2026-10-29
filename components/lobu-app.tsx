// The Lobu web app inside bb, laid out like the Mac app: a context picker over
// the full app. The plugin server swaps the chosen CLI login for a Lobu web
// session; the frame signs in through Lobu's own bootstrap page with it.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { CliContextOption, rpcContract } from "@/lib/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorText } from "@/lib/format";
import { cn } from "@/lib/utils";

const CONTEXT_KEY = "lobu.app.context";

/** A picker entry; name is null for "whatever context the CLI has active". */
type Choice = Omit<CliContextOption, "name"> & { name: string | null };

function readContext(): string | null {
  try {
    return localStorage.getItem(CONTEXT_KEY);
  } catch {
    return null;
  }
}

function storeContext(name: string | null) {
  try {
    if (name === null) localStorage.removeItem(CONTEXT_KEY);
    else localStorage.setItem(CONTEXT_KEY, name);
  } catch {
    // Storage can be unavailable; the choice then lasts for this visit.
  }
}

const host = (origin: string) => origin.replace(/^https?:\/\//, "");

export function LobuApp({ leading }: { leading: ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [picked, setPicked] = useState<string | null>(readContext);
  const [frame, setFrame] = useState<{ url: string; origin: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    rpc.call("lobuContexts", {}).then(
      ({ contexts, fallbackOrigin }) =>
        setChoices(contexts.length > 0 ? contexts : [{ name: null, origin: fallbackOrigin, current: true, loggedIn: true }]),
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc]);

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

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-sm">
        {leading}
        <div className="ml-auto flex items-center gap-1">
          {choices === null || choices.length < 2 ? (
            active === null ? null : (
              <span className="px-2 text-xs text-muted-foreground">{active.name ?? host(active.origin)}</span>
            )
          ) : (
            <select
              aria-label="Lobu context"
              className="h-8 max-w-64 cursor-pointer rounded-md border border-input bg-transparent px-2 text-xs"
              value={activeName ?? ""}
              onChange={(event) => {
                setPicked(event.target.value);
                storeContext(event.target.value);
              }}
            >
              {choices.map((c) => (
                <option key={c.name ?? ""} value={c.name ?? ""} disabled={!c.loggedIn}>
                  {c.name ?? "Active login"} · {host(c.origin)}
                  {c.loggedIn ? "" : " (signed out)"}
                </option>
              ))}
            </select>
          )}
          <Button variant="ghost" size="icon" className="size-8" aria-label="Reload Lobu" onClick={() => setReloads((n) => n + 1)}>
            <Icon name="lobu/refresh" className={cn("size-4", frame === null && error === null && "animate-spin")} />
          </Button>
          {frame === null ? null : (
            <UrlLink href={`${frame.origin}/`} className="px-2 text-xs text-muted-foreground hover:text-foreground">
              Open in browser
            </UrlLink>
          )}
        </div>
      </div>
      {error !== null ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : frame === null ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Signing in to Lobu…</p>
      ) : (
        <iframe
          key={frame.url}
          src={frame.url}
          title="Lobu"
          className="min-h-0 w-full flex-1 border-0 bg-background"
          referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}
