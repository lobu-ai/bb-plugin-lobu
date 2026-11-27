// The memory conflict form. bb shows it in place of the thread composer when
// an agent saves a memory that contradicts one Lobu already holds; every other
// memory is saved without asking.
import { useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import {
  type ConflictChoice,
  conflictFormSchema,
  type MemoryConflict,
} from "@/lib/memory-contract";
import { Button } from "@/components/ui/button";

const CHOICES: { value: ConflictChoice; label: string }[] = [
  { value: "replace", label: "Use the new one" },
  { value: "keep-both", label: "Keep both" },
  { value: "discard", label: "Keep the saved one" },
];

/** The conflict form in a thread, in place of the composer. */
export function ConflictFormView({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = conflictFormSchema.safeParse(interaction.payload);
  if (!parsed.success) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <span className="text-destructive">This Lobu memory conflict is malformed.</span>
        <Button size="sm" variant="ghost" onClick={() => void cancel()}>
          Dismiss
        </Button>
      </div>
    );
  }
  return <ConflictFields conflicts={parsed.data.conflicts} onSubmit={(choices) => submit({ choices })} onSkip={cancel} />;
}

function ConflictFields({
  conflicts,
  onSubmit,
  onSkip,
}: {
  conflicts: MemoryConflict[];
  onSubmit: (choices: ConflictChoice[]) => Promise<unknown>;
  onSkip: () => Promise<unknown> | void;
}) {
  const [choices, setChoices] = useState<(ConflictChoice | null)[]>(() => conflicts.map(() => null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const single = conflicts.length === 1;

  const send = async (picked: ConflictChoice[]) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(picked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const choose = (index: number, choice: ConflictChoice) => {
    // One conflict settles with one click; several are applied together.
    if (single) return void send([choice]);
    setChoices((current) => current.map((value, i) => (i === index ? choice : value)));
  };
  const complete = choices.every((choice) => choice !== null);

  return (
    <section aria-label="Lobu memory conflict" className="max-h-[60vh] space-y-3 overflow-y-auto text-sm">
      <p className="text-muted-foreground">
        {single
          ? "A new memory contradicts one saved in Lobu. Which should agents trust?"
          : "New memories contradict ones saved in Lobu. Choose for each, then apply."}
      </p>
      <ul className="space-y-3">
        {conflicts.map((conflict, index) => (
          // Keyed by position: the list is fixed for the form's life, and two drafts can contradict one memory.
          <li key={index} className="space-y-2 rounded-md border border-border p-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <Memory
                label={conflict.existing.workspace === conflict.workspace ? "Saved" : `Saved in ${conflict.existing.workspace}`}
                title={conflict.existing.title}
                content={conflict.existing.content}
                url={conflict.existing.url}
              />
              <Memory
                label="New"
                title={conflict.proposed.title}
                content={conflict.proposed.content}
                note={conflict.proposed.evidence ?? null}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CHOICES.map(({ value, label }) => (
                <Button
                  key={value}
                  size="sm"
                  variant={choices[index] === value ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => choose(index, value)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {error === null ? null : <p className="text-destructive">Could not apply: {error}</p>}
      <footer className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">Skip keeps only what is already saved.</span>
        <Button size="sm" variant="ghost" onClick={() => void onSkip()} disabled={busy}>
          Skip
        </Button>
        {single ? null : (
          <Button
            size="sm"
            disabled={busy || !complete}
            onClick={() => void send(choices.filter((choice): choice is ConflictChoice => choice !== null))}
          >
            Apply
          </Button>
        )}
      </footer>
    </section>
  );
}

function Memory({
  label,
  title,
  content,
  url = null,
  note = null,
}: {
  label: string;
  title: string;
  content: string;
  url?: string | null;
  note?: string | null;
}) {
  return (
    <div className="min-w-0 space-y-1 rounded-md bg-muted/40 px-2 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        {url === null ? (
          <span className="truncate font-medium">{title}</span>
        ) : (
          <a className="truncate font-medium underline-offset-2 hover:underline" href={url} target="_blank" rel="noreferrer">
            {title}
          </a>
        )}
      </div>
      <p className="line-clamp-6 whitespace-pre-wrap text-muted-foreground">{content}</p>
      {note === null || note === "" ? null : (
        <p className="text-xs text-muted-foreground">
          From: <span className="italic">{note}</span>
        </p>
      )}
    </div>
  );
}
