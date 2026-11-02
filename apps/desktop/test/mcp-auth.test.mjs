import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assembleBearerHeaders,
  buildHttpHeaders,
  detectAuthMode,
  splitBearerHeaders,
} from "../src/components/extensions/mcp-auth.ts";
import { pairsToRecord, recordToPairs } from "../src/components/extensions/kv-pairs.ts";

test("detectAuthMode picks bearer only for a Bearer-shaped Authorization value", () => {
  assert.equal(detectAuthMode(undefined), "headers");
  assert.equal(detectAuthMode({}), "headers");
  assert.equal(detectAuthMode({ "X-Api-Key": "k" }), "headers");
  assert.equal(detectAuthMode({ Authorization: "Bearer abc" }), "bearer");
  assert.equal(detectAuthMode({ authorization: "bearer abc" }), "bearer");
  assert.equal(detectAuthMode({ AUTHORIZATION: "Bearer\tabc" }), "bearer");
  assert.equal(detectAuthMode({ Authorization: "Bearer" }), "headers");
  assert.equal(detectAuthMode({ Authorization: "Bearer   " }), "headers");
  assert.equal(detectAuthMode({ Authorization: "Basic abc" }), "headers");
});

test("splitBearerHeaders extracts the token and keeps every other header", () => {
  const split = splitBearerHeaders({ Authorization: "Bearer abc", "X-Tenant": "t" });
  assert.deepEqual(split, { token: "abc", rest: { "X-Tenant": "t" } });
  // Case-insensitive scheme, bare token trimmed.
  assert.equal(splitBearerHeaders({ authorization: "bearer  abc " })?.token, "abc");
  // A non-Bearer Authorization is not touched: null means "keep it in rows".
  assert.equal(splitBearerHeaders({ Authorization: "Basic abc" }), null);
  assert.equal(splitBearerHeaders({ Authorization: "Bearer" }), null);
  assert.equal(splitBearerHeaders({}), null);
});

test("splitBearerHeaders leaves a second, differently-cased Authorization in rest", () => {
  const split = splitBearerHeaders({ Authorization: "Bearer a", authorization: "b" });
  assert.equal(split?.token, "a");
  assert.deepEqual(split?.rest, { authorization: "b" });
});

test("assembleBearerHeaders appends the canonical header and overrides a stale one", () => {
  assert.deepEqual(assembleBearerHeaders("abc", { "X-Tenant": "t" }), {
    "X-Tenant": "t",
    Authorization: "Bearer abc",
  });
  assert.equal(assembleBearerHeaders("  abc  ", {})["Authorization"], "Bearer abc");
  // Token wins over a hand-written Authorization left in the rows.
  assert.equal(
    assembleBearerHeaders("new", { Authorization: "Bearer old" })["Authorization"],
    "Bearer new",
  );
  // An empty token preserves the rows, including any hand-written Authorization.
  assert.deepEqual(assembleBearerHeaders("", { Authorization: "Basic abc" }), {
    Authorization: "Basic abc",
  });
});

test("buildHttpHeaders assembles only in bearer mode", () => {
  const pairs = [
    { key: "Authorization", value: "Bearer stale" },
    { key: "X-Api-Key", value: "k" },
    { key: "", value: "dropped" },
  ];
  assert.deepEqual(buildHttpHeaders("bearer", "abc", pairs), {
    Authorization: "Bearer abc",
    "X-Api-Key": "k",
  });
  assert.deepEqual(buildHttpHeaders("headers", "abc", pairs), {
    Authorization: "Bearer stale",
    "X-Api-Key": "k",
  });
  // Empty token in bearer mode falls back to the raw rows verbatim.
  assert.deepEqual(buildHttpHeaders("bearer", "", pairs), {
    Authorization: "Bearer stale",
    "X-Api-Key": "k",
  });
});

test("a saved record round-trips through split and assemble unchanged", () => {
  const saved = { "X-Tenant": "t", Authorization: "Bearer abc" };
  const split = splitBearerHeaders(saved);
  assert.ok(split);
  const rebuilt = assembleBearerHeaders(split.token, split.rest);
  assert.deepEqual(rebuilt, saved);
  assert.equal(detectAuthMode(rebuilt), "bearer");
  assert.equal(splitBearerHeaders(rebuilt)?.token, "abc");
});

test("kv-pairs helpers drop blank rows and collapse duplicates last-write-wins", () => {
  assert.deepEqual(
    pairsToRecord([
      { key: "a", value: "1" },
      { key: " a ", value: "2" },
      { key: "", value: "x" },
    ]),
    { a: "2" },
  );
  assert.deepEqual(recordToPairs(undefined), []);
  assert.deepEqual(recordToPairs({ a: "1" }), [{ key: "a", value: "1" }]);
});

/**
 * The sheet is a .tsx file, so its wiring is asserted as a source contract:
 * the editor must save through buildHttpHeaders with the draft's auth mode,
 * default to bearer mode for new servers, and render the mode picker plus a
 * masked token field.
 */
const sheetSource = await readFile(
  new URL("../src/components/extensions/McpEditorSheet.tsx", import.meta.url),
  "utf8",
);

test("McpEditorSheet wires the auth mode into save and the form", () => {
  assert.match(
    sheetSource,
    /headers: buildHttpHeaders\(draft\.authMode, draft\.bearerToken, draft\.headers\)/,
    "draftToInput must assemble headers through buildHttpHeaders",
  );
  assert.match(sheetSource, /authMode: "bearer"/, "new drafts default to bearer mode");
  assert.match(sheetSource, /<SegmentedControl/, "auth mode picker is a SegmentedControl");
  assert.match(sheetSource, /<PasswordInput/, "the token field is masked");
  assert.match(sheetSource, /splitBearerHeaders\(pairsToRecord\(draft\.headers\)\)/, "entering bearer mode extracts the token from rows");
  assert.match(sheetSource, /key: "Authorization", value: `Bearer \$\{token\}`/, "leaving bearer mode materializes the token as a row");
});
