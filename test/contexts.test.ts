import { describe, expect, test } from "bun:test";
import { contextsForLobu, embeddableOrigin, parseCliContexts } from "../lib/lobu-api";

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

describe("contextsForLobu", () => {
  test("keeps logged-in contexts on this Lobu, the active one first", () => {
    expect(contextsForLobu(listed, "https://app.lobu.example")).toEqual(["side", "work"]);
  });

  test("matches a self-hosted Lobu by origin", () => {
    expect(contextsForLobu(listed, "http://localhost:8787")).toEqual(["local"]);
  });

  test("returns nothing for output it does not understand", () => {
    expect(contextsForLobu({ contexts: "nope" }, "https://app.lobu.example")).toEqual([]);
    expect(contextsForLobu(null, "https://app.lobu.example")).toEqual([]);
  });
});

describe("the context picker", () => {
  test("lists every context with its Lobu origin, the active one first", () => {
    expect(parseCliContexts(listed).map((c) => [c.name, c.origin, c.loggedIn])).toEqual([
      ["side", "https://app.lobu.example", true],
      ["work", "https://app.lobu.example", true],
      ["stale", "https://app.lobu.example", false],
      ["local", "http://localhost:8787", true],
    ]);
  });

  test("embeds Lobu only over HTTPS or on this machine", () => {
    expect(embeddableOrigin("https://app.lobu.example/api/v1")).toBe("https://app.lobu.example");
    expect(embeddableOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(embeddableOrigin("http://127.0.0.1:8118/x")).toBe("http://127.0.0.1:8118");
    expect(embeddableOrigin("http://lobu.example.com")).toBeNull();
    expect(embeddableOrigin("javascript:alert(1)")).toBeNull();
    expect(embeddableOrigin("not a url")).toBeNull();
  });
});
