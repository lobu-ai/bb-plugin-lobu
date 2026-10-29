// Connecting bb to Lobu, like the Lobu Mac app: install the CLI, then sign in
// to Lobu Cloud or run Lobu on this machine, and pick the login bb saves through. The New thread screen shows it as a card until bb is
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

/**
 * Switching the login bb uses, like the Lobu Mac app: Lobu Cloud, Lobu on this
 * machine, or another Lobu by URL. Each may be ready at once (a signed-in
 * login, a local Lobu already serving); otherwise this waits for it.
 */
function useConnect(reload: () => Promise<SetupStatus | null>) {
  const rpc = useRpc<typeof rpcContract>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = useApprovalWait(reload, isConnected, () => undefined);
  const startedOrStopped = useCallback((s: SetupStatus) => isConnected(s) || !s.starting, []);
  const start = useApprovalWait(reload, startedOrStopped, () => undefined);
  const act = (call: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    call()
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };
  const connectedNow = async () => {
    const next = await reload();
    return next !== null && isConnected(next);
  };
  const waiting =
    signIn.approval !== null ? (
      <Approval url={signIn.approval.url} what="the sign-in" />
    ) : start.approval !== null ? (
      <p className="text-xs text-muted-foreground">Starting Lobu on this machine. The first start can take a few minutes.</p>
    ) : null;
  return {
    error,
    busy,
    waiting,
    useCloud: () =>
      act(async () => {
        const { approvalUrl } = await rpc.call("useCloud", {});
        if (!(await connectedNow())) signIn.wait(approvalUrl);
      }),
    useLocal: () =>
      act(async () => {
        const { error: failure } = await rpc.call("useLocal", {});
        if (failure !== null) setError(failure);
        else if (!(await connectedNow())) start.wait(null);
      }),
    useOther: (name: string, url: string) =>
      act(async () => {
        const { approvalUrl } = await rpc.call("addLogin", { name, url });
        if (!(await connectedNow())) signIn.wait(approvalUrl);
      }),
  };
}

type Connect = ReturnType<typeof useConnect>;

function OtherLobu({ connect }: { connect: Connect }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  if (!open) {
    return (
      <Button variant="ghost" size="sm" disabled={connect.busy} onClick={() => setOpen(true)}>
        Another Lobu…
      </Button>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    connect.useOther(name.trim(), url);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input aria-label="Login name" placeholder="Name, e.g. work" required value={name} onChange={(e) => setName(e.target.value)} className={cn(field, "w-40")} />
      <input aria-label="Lobu URL" type="url" placeholder="https://lobu.example.com" required value={url} onChange={(e) => setUrl(e.target.value)} className={cn(field, "w-56")} />
      <Button type="submit" size="sm" variant="outline" disabled={connect.busy}>
        Sign in
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

function ConnectError({ connect, problem }: { connect: Connect; problem: string | null }) {
  const shown = connect.error ?? problem;
  return shown === null ? null : (
    <p role="alert" className="text-xs text-destructive">
      {shown}
    </p>
  );
}

/** Not connected yet: Lobu Cloud, Lobu on this machine, or another Lobu. */
function ChooseStep({ status, reload }: { status: SetupStatus; reload: () => Promise<SetupStatus | null> }) {
  const connect = useConnect(reload);
  if (connect.waiting !== null) return connect.waiting;
  return (
    <div className="space-y-3 text-sm">
      <ConnectError connect={connect} problem={status.login?.problem ?? null} />
      <div className="space-y-1">
        <Button size="sm" disabled={connect.busy} onClick={connect.useCloud}>
          Use Lobu Cloud
        </Button>
        <p className="text-xs text-muted-foreground">Sign in at app.lobu.ai. New to Lobu? You can create an account on the same page.</p>
      </div>
      <div className="space-y-1">
        <Button size="sm" variant="outline" disabled={connect.busy} onClick={connect.useLocal}>
          Run Lobu on this machine
        </Button>
        <p className="text-xs text-muted-foreground">Your memory stays on this computer, and Lobu runs while bb does.</p>
      </div>
      <OtherLobu connect={connect} />
    </div>
  );
}

const KIND_LABEL = { cloud: "Lobu Cloud", local: "Lobu on this machine" } as const;

/** How many memories bb saved through this login, linking to them in Lobu. */
function SavedSummary() {
  const rpc = useRpc<typeof rpcContract>();
  const [saved, setSaved] = useState<{ url: string | null; count: number } | null>(null);
  useEffect(() => {
    rpc.call("savedLink", {}).then(setSaved, () => setSaved(null));
  }, [rpc]);
  if (saved === null || saved.count === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      bb has saved {saved.count === 1 ? "1 memory" : `${saved.count} memories`} there.{" "}
      {saved.url === null ? null : (
        <UrlLink href={saved.url} className="text-foreground underline">
          Open in Lobu
        </UrlLink>
      )}
    </p>
  );
}

function Connected({ status, reload }: { status: SetupStatus; reload: () => Promise<SetupStatus | null> }) {
  const connect = useConnect(reload);
  const login = status.login!;
  const where = login.kind === "other" ? host(login.origin) : KIND_LABEL[login.kind];
  return (
    <div className="space-y-2 text-sm">
      <p>
        {where}
        <span className="text-muted-foreground">
          {login.account === null ? "" : ` · ${login.account}`}
          {login.personal === null ? " · agents ask where to save" : ` · saves to ${login.personal}`}
        </span>
      </p>
      <SavedSummary />
      {connect.waiting ?? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Switch to</span>
          {login.kind === "cloud" ? null : (
            <Button variant="outline" size="sm" disabled={connect.busy} onClick={connect.useCloud}>
              Lobu Cloud
            </Button>
          )}
          {login.kind === "local" ? null : (
            <Button variant="outline" size="sm" disabled={connect.busy} onClick={connect.useLocal}>
              Lobu on this machine
            </Button>
          )}
          <OtherLobu connect={connect} />
        </div>
      )}
      <ConnectError connect={connect} problem={null} />
    </div>
  );
}

function Steps({ status, reload }: { status: SetupStatus; reload: () => Promise<SetupStatus | null> }) {
  if (status.cli.state !== "ready") return <InstallStep status={status} reload={reload} />;
  if (!isConnected(status)) return <ChooseStep status={status} reload={reload} />;
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

/** The New thread screen's setup card, shown until bb is connected. */
export function SetupCard({ status, reload }: { status: SetupStatus; reload: () => Promise<SetupStatus | null> }) {
  return (
    <Frame title="Connect Lobu">
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
