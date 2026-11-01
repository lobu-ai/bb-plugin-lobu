import { describe, expect, test } from "bun:test";
import { kindOfOrigin, lobuOrigin, parseCliContexts, pickCloudContext, pickOriginContext, type CliContext } from "../lib/lobu-api";

const listed = {
  current: "side",
  contexts: [
    { name: "work", url: "https://app.lobu.example/api/v1", current: false, loggedIn: true },
    { name: "side", url: "https://app.lobu.example/api/v1", current: true, loggedIn: true },
    { name: "stale", url: "https://app.lobu.example/api/v1", current: false, loggedIn: false },
    { name: "local", url: "http://localhost:8787", current: false, loggedIn: true },
    { name: "broken", url: "not a url", current: false, loggedIn: true },
  ],
};

describe("CLI contexts", () => {
  test("lists every context with its Lobu origin, the active one first", () => {
    expect(parseCliContexts(listed).map((c) => [c.name, c.origin, c.loggedIn])).toEqual([
      ["side", "https://app.lobu.example", true],
      ["work", "https://app.lobu.example", true],
      ["stale", "https://app.lobu.example", false],
      ["local", "http://localhost:8787", true],
    ]);
    expect(parseCliContexts({ contexts: "nope" })).toEqual([]);
    expect(parseCliContexts(null)).toEqual([]);
  });

  test("accepts Lobu only over HTTPS or on this machine", () => {
    expect(lobuOrigin("https://app.lobu.example/api/v1")).toBe("https://app.lobu.example");
    expect(lobuOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(lobuOrigin("http://127.0.0.1:8118/x")).toBe("http://127.0.0.1:8118");
    expect(lobuOrigin("http://lobu.example.com")).toBeNull();
    expect(lobuOrigin("javascript:alert(1)")).toBeNull();
    expect(lobuOrigin("not a url")).toBeNull();
  });

  test("classifies origins like the Mac app", () => {
    expect(kindOfOrigin("https://app.lobu.ai")).toBe("cloud");
    expect(kindOfOrigin("http://localhost:8787")).toBe("local");
    expect(kindOfOrigin("http://127.0.0.1:8118")).toBe("local");
    expect(kindOfOrigin("https://lobu.example.com")).toBe("other");
    expect(kindOfOrigin("not a url")).toBe("other");
  });

  test("Use Lobu Cloud reuses a signed-in Cloud login instead of duplicating it", () => {
    const contexts: CliContext[] = [
      { name: "lobu", origin: "https://app.lobu.ai", current: false, loggedIn: false },
      { name: "market-wiring", origin: "https://app.lobu.ai", current: false, loggedIn: true },
      { name: "local", origin: "http://localhost:8787", current: true, loggedIn: true },
    ];
    expect(pickCloudContext(contexts, "lobu")?.name).toBe("market-wiring");

    const preferredSignedIn: CliContext[] = [
      { name: "lobu", origin: "https://app.lobu.ai", current: false, loggedIn: true },
      { name: "market-wiring", origin: "https://app.lobu.ai", current: true, loggedIn: true },
    ];
    expect(pickCloudContext(preferredSignedIn, "lobu")?.name).toBe("lobu");

    const loggedOut: CliContext[] = [
      { name: "lobu", origin: "https://app.lobu.ai", current: false, loggedIn: false },
      { name: "other-cloud", origin: "https://app.lobu.ai", current: true, loggedIn: false },
    ];
    expect(pickCloudContext(loggedOut, "lobu")?.name).toBe("lobu");
    expect(pickCloudContext([], "lobu")).toBeNull();
  });

  test("Another Lobu reuses the login for its origin instead of duplicating it", () => {
    const contexts: CliContext[] = [
      { name: "market-wiring", origin: "https://app.lobu.ai", current: false, loggedIn: true },
      { name: "stale-cloud", origin: "https://app.lobu.ai", current: false, loggedIn: false },
      { name: "local", origin: "http://localhost:8787", current: true, loggedIn: true },
    ];
    expect(pickOriginContext(contexts, "https://app.lobu.ai")?.name).toBe("market-wiring");
    expect(pickOriginContext(contexts, "http://localhost:8787")?.name).toBe("local");
    expect(pickOriginContext(contexts, "https://lobu.example.com")).toBeNull();
  });
});
