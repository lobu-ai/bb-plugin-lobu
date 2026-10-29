// Connecting bb to Lobu: install the CLI, sign in, and pick the login bb
// saves through. The New thread screen shows it as a card until bb is
// connected; the plugin's settings page always shows it.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { experimental_copyToClipboard, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, SetupStatus } from "@/lib/contract";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How often the page checks whether a browser approval has landed. */
const SIGN_IN_POLL_MS = 3_000;

const field =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

const host = (origin: string) => origin.replace(/^https?:\/\//, "");

/** Connected means bb can save: the CLI runs and the login it uses is signed in. */
export const isConnected = (status: SetupStatus) =>
  status.cli.state === "ready" && status.login !== null && status.login.problem === null;

export function useSetupStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      rpc.call("setupStatus", {}).then(
        (next) => {
          setStatus(next);
          setError(null);
          return next;
        },
        (cause: unknown) => {
          setError(errorText(cause));
          return null;
        },
      ),
    [rpc],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { status, error, reload };
}

function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{command}</code>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void experimental_copyToClipboard({ text: command }).then((ok) => setCopied(ok))}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </span>
  );
}

/** Waits for a browser approval: polls the status until `done` says it landed. */
function useApprovalWait(reload: () => Promise<SetupStatus | null>, done: (status: SetupStatus) => boolean, onDone: (status: SetupStatus) => void) {
  const [approval, setApproval] = useState<{ url: string | null } | null>(null);
  useEffect(() => {
    if (approval === null) return;
    const timer = setInterval(() => {
      void reload().then((next) => {
        if (next === null || !done(next)) return;
        setApproval(null);
        onDone(next);
      });
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [approval, reload, done, onDone]);
  return { approval, wait: (url: string | null) => setApproval({ url }) };
}

function Approval({ url, what }: { url: string | null; what: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Approve {what} on the Lobu page that opened in your browser. This updates once you do.
      {url === null ? null : (
        <>
          {" "}
          <UrlLink href={url} className="text-foreground underline">
            Open the approval page
          </UrlLink>
        </>
      )}
    </p>
  );
}

function InstallStep({ status, reload }: { status: SetupStatus; reload: () => Promise<SetupStatus | null> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { cli } = status;
  const intro =
    cli.state === "missing"
      ? "bb talks to Lobu through the lobu CLI, which is not installed yet."
      : cli.state === "outdated"
        ? `Your lobu CLI is ${cli.version}; bb needs a newer one.`
        : cli.state === "broken"
          ? `The lobu CLI did not start: ${cli.detail}`
          : null;
  const install = () => {
    setBusy(true);
    setFailure(null);
    rpc
      .call("installCli", {})
      .then(
        // Stay busy until the status shows the new CLI, so the button does not flash back.
        async ({ error }) => {
          if (error === null) await reload();
          else setFailure(error);
        },
        (cause: unknown) => setFailure(errorText(cause)),
      )
      .finally(() => setBusy(false));
  };
  const manual = status.installCommand ?? status.manualCommand;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">{intro}</p>
      {status.installCommand !== null && failure === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={install}>
            {busy ? "Installing…" : cli.state === "missing" ? "Install the Lobu CLI" : "Update the Lobu CLI"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Runs <code>{status.installCommand}</code>
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          {failure === null ? null : (
            <p role="alert" className="text-xs text-destructive">
              The install did not work: {failure}
            </p>
          )}
          <p className="text-xs text-muted-foreground">Run this in a terminal, then check again:</p>
          <div className="flex flex-wrap items-center gap-2">
            <Command command={manual} />
            <Button variant="outline" size="sm" onClick={() => void reload().then(() => setFailure(null))}>
              Check again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SignInStep({ status, reload }: { status: SetupStatus; reload: () => Promise<SetupStatus | null> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { approval, wait } = useApprovalWait(reload, isConnected, () => undefined);
  const login = status.login;
  const where = login === null ? "Lobu" : host(login.origin);
  if (approval !== null) return <Approval url={approval.url} what={`the sign-in to ${where}`} />;
  const signIn = () => {
    setBusy(true);
    setError(null);
    rpc
      .call("signIn", {})
      .then(
        ({ approvalUrl }) => wait(approvalUrl),
        (cause: unknown) => setError(errorText(cause)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        Sign in to {where}
        {login?.context ? ` (lobu context ${login.context})` : ""}. New to Lobu? You can create an account on the same page.
      </p>
      <Button size="sm" disabled={busy} onClick={signIn}>
        Sign in to Lobu
      </Button>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function AddLogin({ reload, onAdded }: { reload: () => Promise<SetupStatus | null>; onAdded: (name: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://app.lobu.ai");
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const added = useCallback((s: SetupStatus) => s.logins.some((c) => c.name === adding && c.loggedIn), [adding]);
  const { approval, wait } = useApprovalWait(reload, added, () => adding !== null && onAdded(adding));
  if (approval !== null && adding !== null) return <Approval url={approval.url} what={`the ${adding} login`} />;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const trimmed = name.trim();
    rpc
      .call("addLogin", { name: trimmed, url })
      .then(
        ({ approvalUrl }) => {
          setAdding(trimmed);
          wait(approvalUrl);
        },
        (cause: unknown) => setError(errorText(cause)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input aria-label="Login name" placeholder="Name, e.g. work" required value={name} onChange={(e) => setName(e.target.value)} className={cn(field, "w-40")} />
      <input aria-label="Lobu URL" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} className={cn(field, "w-56")} />
      <Button type="submit" size="sm" variant="outline" disabled={busy}>
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

function Connected({ status, reload }: { status: SetupStatus; reload: () => Promise<SetupStatus | null> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = status.login!;
  const use = (context: string | null) =>
    rpc.call("useLogin", { context }).then(
      () => reload(),
      (cause: unknown) => setError(errorText(cause)),
    );
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Connected to {host(login.origin)}
        {login.account === null ? "" : ` as ${login.account}`}.{" "}
        {login.personal === null
          ? "This login has no personal workspace, so agents ask where to save."
          : `Agents save to your ${login.personal} workspace.`}
      </p>
      {status.logins.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="lobu-login" className="text-xs text-muted-foreground">
            bb uses
          </label>
          <select
            id="lobu-login"
            className="h-8 max-w-72 cursor-pointer rounded-md border border-input bg-transparent px-2 text-xs"
            value={login.context ?? ""}
            onChange={(event) => void use(event.target.value)}
          >
            {status.logins.map((c) => (
              <option key={c.name} value={c.name} disabled={!c.loggedIn}>
                {c.name} · {host(c.origin)}
                {c.loggedIn ? "" : " (signed out)"}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="sm" onClick={() => setAdding((open) => !open)}>
            {adding ? "Cancel" : "Add a login"}
          </Button>
        </div>
      ) : null}
      {adding ? (
        <AddLogin
          reload={reload}
          onAdded={(name) => {
            setAdding(false);
            void use(name);
          }}
        />
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function Steps({ status, reload }: { status: SetupStatus; reload: () => Promise<SetupStatus | null> }) {
  if (status.cli.state !== "ready") return <InstallStep status={status} reload={reload} />;
  if (!isConnected(status)) return <SignInStep status={status} reload={reload} />;
  return <Connected status={status} reload={reload} />;
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border border-border px-4 py-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

/** The New thread screen's card; gone once bb is connected. */
export function SetupCard() {
  const { status, reload } = useSetupStatus();
  if (status === null || isConnected(status)) return null;
  return (
    <Frame title="Connect Lobu memory">
      <p className="text-xs text-muted-foreground">
        Agents in bb save what they learn to Lobu and start each thread with it.
      </p>
      <Steps status={status} reload={reload} />
    </Frame>
  );
}

/** The plugin settings page's account section; always shown. */
export function SetupSettings() {
  const { status, error, reload } = useSetupStatus();
  if (status === null) {
    return error === null ? (
      <p className="text-sm text-muted-foreground">Checking Lobu…</p>
    ) : (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  return <Steps status={status} reload={reload} />;
}

/** For the thread panel: the steps while bb is not connected, nothing once it is. */
export function SetupNotice() {
  const { status, reload } = useSetupStatus();
  if (status === null || isConnected(status)) return null;
  return (
    <Frame title="Lobu is not connected">
      <Steps status={status} reload={reload} />
    </Frame>
  );
}
