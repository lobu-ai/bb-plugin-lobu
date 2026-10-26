// The Save to Lobu review form. bb shows it in place of the thread composer
// while lobu_remember (or a Save to Lobu action) waits for the user.
import { useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import {
  type MemoryDraft,
  memoryKinds,
  type RememberForm,
  rememberFormSchema,
  type RememberSubmission,
} from "@/lib/memory-contract";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const field =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface Row extends MemoryDraft {
  keep: boolean;
}

export function RememberFormView({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = rememberFormSchema.safeParse(interaction.payload);
  const form: RememberForm | null = parsed.success ? parsed.data : null;
  const [rows, setRows] = useState<Row[]>(() => (form?.drafts ?? []).map((draft) => ({ ...draft, keep: true })));
  const [workspace, setWorkspace] = useState(form?.workspace ?? form?.workspaces[0]?.slug ?? "");
  const [busy, setBusy] = useState(false);

  if (form === null) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <span className="text-destructive">This Save to Lobu request is malformed.</span>
        <Button size="sm" variant="ghost" onClick={() => void cancel()}>
          Dismiss
        </Button>
      </div>
    );
  }

  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const kept = rows.filter((row) => row.keep && row.title.trim() !== "" && row.content.trim() !== "");
  const save = async () => {
    setBusy(true);
    const value: RememberSubmission = {
      workspace,
      memories: kept.map(({ keep: _keep, ...memory }) => ({
        ...memory,
        title: memory.title.trim(),
        content: memory.content.trim(),
      })),
    };
    try {
      await submit(value);
    } finally {
      setBusy(false);
    }
  };

  return (
    // bb draws the card and its "Save to Lobu" title around this form.
    <section aria-label="Save to Lobu" className="max-h-[60vh] space-y-3 overflow-y-auto text-sm">
      <header className="flex items-center gap-2">
        <span className="text-muted-foreground">Keep what is worth remembering, edit anything, then save.</span>
        <label className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
          Workspace
          <select
            className={cn(field, "w-auto py-0.5")}
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
          >
            {form.workspaces.map((ws) => (
              <option key={ws.slug} value={ws.slug}>
                {ws.name === ws.slug ? ws.slug : `${ws.name} (${ws.slug})`}
              </option>
            ))}
          </select>
        </label>
      </header>
      <ul className="space-y-2">
        {rows.map((row, index) => (
          <li
            key={index}
            className={cn("flex gap-2 rounded-md border border-border px-2 py-2", !row.keep && "opacity-50")}
          >
            <input
              type="checkbox"
              className="mt-1.5 size-4 shrink-0"
              aria-label={`Keep "${row.title}"`}
              checked={row.keep}
              onChange={(event) => update(index, { keep: event.target.checked })}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex gap-2">
                <input
                  className={cn(field, "font-medium")}
                  aria-label="Title"
                  value={row.title}
                  maxLength={120}
                  disabled={!row.keep}
                  onChange={(event) => update(index, { title: event.target.value })}
                />
                <select
                  className={cn(field, "w-auto")}
                  aria-label="Kind"
                  value={row.kind}
                  disabled={!row.keep}
                  onChange={(event) => update(index, { kind: event.target.value as Row["kind"] })}
                >
                  {memoryKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                className={cn(field, "min-h-14 resize-y")}
                aria-label="Memory"
                value={row.content}
                maxLength={2000}
                rows={Math.min(6, Math.max(2, Math.ceil(row.content.length / 90)))}
                disabled={!row.keep}
                onChange={(event) => update(index, { content: event.target.value })}
              />
            </div>
          </li>
        ))}
      </ul>
      <footer className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">Nothing is saved until you choose Save.</span>
        <Button size="sm" variant="ghost" onClick={() => void cancel()} disabled={busy}>
          Skip
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={busy || kept.length === 0 || workspace === ""}>
          {kept.length === 0 ? "Save" : `Save ${kept.length} ${kept.length === 1 ? "memory" : "memories"}`}
        </Button>
      </footer>
    </section>
  );
}
