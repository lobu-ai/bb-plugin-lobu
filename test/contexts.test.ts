import { describe, expect, test } from "bun:test";
import { lobuOrigin, parseCliContexts } from "../lib/lobu-api";

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
});
