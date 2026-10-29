// Small display helpers for the Lobu page and the thread panel.

export function relativeTime(iso: string | null): string | null {
  if (iso === null) return null;
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(minutes)) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export const sinceMs = (ms: number) => relativeTime(new Date(ms).toISOString());

export function formatCount(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: n >= 10_000 ? "compact" : "standard" }).format(n);
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
