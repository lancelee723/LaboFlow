import assert from "node:assert/strict";
import test from "node:test";
import { decideKbEntry } from "../src/components/kb/kbUrls.ts";

const entry = (id, name, url, source = "user") => ({ id, name, url, source });

test("decideKbEntry reports empty when no KB URLs exist", () => {
  assert.deepEqual(decideKbEntry([]), { action: "empty" });
  // Defensive: a nullish list (IPC failure fallback) behaves the same way.
  assert.deepEqual(decideKbEntry(undefined ?? []), { action: "empty" });
});

test("decideKbEntry opens directly when exactly one URL exists", () => {
  assert.deepEqual(decideKbEntry([entry("k1", "WeKnora", "https://kb.example.com")]), {
    action: "open",
    url: "https://kb.example.com",
  });
});

test("decideKbEntry shows the picker for multiple URLs", () => {
  const urls = [
    entry("k1", "WeKnora", "https://kb.example.com"),
    entry("k2", "Confluence", "https://wiki.example.com", "org"),
  ];
  assert.deepEqual(decideKbEntry(urls), { action: "pick" });
});
