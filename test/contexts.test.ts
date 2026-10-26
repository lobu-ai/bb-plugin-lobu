import { describe, expect, test } from "bun:test";
import { contextsForLobu } from "../lib/lobu-api";

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
