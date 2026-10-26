// bb-plugin-lobu — server entry. Reads Lobu through the user's `lobu` CLI login
// and serves one cached snapshot to the page over RPC.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type MetricPin, metricPinsSchema, rpcContract, type Snapshot } from "./lib/contract";
import { createLobuApi } from "./lib/lobu-api";
import { buildSnapshot, parseList } from "./lib/snapshot";

const CACHE_MS = 60_000;

function parsePins(value: string): MetricPin[] | null {
  try {
    const parsed = metricPinsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    contexts: {
      type: "string",
      label: "Lobu CLI contexts",
      description:
        "Comma-separated `lobu` CLI contexts to read. Leave empty for the CLI's active context. Every workspace a login is authorized for appears. Add one with `lobu login --context <name>`.",
      default: "",
    },
    hiddenWorkspaces: {
      type: "string",
      label: "Hidden workspaces",
      description: "Comma-separated workspace slugs to leave off the dashboard.",
      default: "",
    },
    metrics: {
      type: "string",
      label: "Pinned metrics",
      description:
        'JSON array of metric queries. Example: [{"workspace":"acme","entity_type":"company","measure":"spend","by":["month"],"label":"Spend by month"}]. The Metrics card lists the measures each workspace declares.',
      experimental_multiline: true,
      experimental_schema: z
        .string()
        .refine(
          (value) => parsePins(value) !== null,
          "Use a JSON array of { workspace, entity_type, measure, by?, segment?, label? }",
        ),
      default: "[]",
    },
    baseUrl: {
      type: "string",
      label: "Lobu URL",
      description: "Change this only for a self-hosted Lobu.",
      default: "https://app.lobu.ai",
    },
    lobuBin: {
      type: "string",
      label: "lobu CLI path",
      description: "Leave empty to use ~/.bun/bin/lobu, then `lobu` on PATH.",
      default: "",
    },
  });

  async function apiOptions() {
    const { baseUrl, lobuBin } = await settings.get();
    return { baseUrl: trimTrailingSlashes(baseUrl.trim()), lobuBin: lobuBin.trim() };
  }

  let api = createLobuApi(await apiOptions());
  let cached: { at: number; snapshot: Snapshot } | null = null;
  let inFlight: Promise<Snapshot> | null = null;

  async function snapshot(refresh: boolean): Promise<Snapshot> {
    if (!refresh && cached !== null && Date.now() - cached.at < CACHE_MS) return cached.snapshot;
    inFlight ??= (async () => {
      const { contexts, hiddenWorkspaces, metrics } = await settings.get();
      const named = parseList(contexts);
      return buildSnapshot(api, {
        contexts: named.length === 0 ? [null] : named,
        hiddenWorkspaces: new Set(parseList(hiddenWorkspaces)),
        baseUrl: (await apiOptions()).baseUrl,
        pins: parsePins(metrics) ?? [],
        now: Date.now(),
      });
    })().finally(() => {
      inFlight = null;
    });
    const next = await inFlight;
    cached = { at: Date.now(), snapshot: next };
    return next;
  }

  settings.onChange(async () => {
    api = createLobuApi(await apiOptions());
    cached = null;
  });

  bb.rpc.register(rpcContract, {
    snapshot: ({ refresh }) => snapshot(refresh),
  });
}
