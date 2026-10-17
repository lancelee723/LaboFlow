/**
 * FR-TC-19: the space activity stream. Audit vocabulary is pure logic
 * (describeSpaceEvent / actorLabel); the panel merges the server history
 * pull with the page's live-frame buffer, deduped by seq, newest first.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { actorLabel, describeSpaceEvent } = await import(
  "../src/components/space/space-activity-describe.ts"
);

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const t = (key, options) => {
  const table = {
    "space.activity.nodeCreated": "created “{{name}}”",
    "space.activity.revisionDecided": "{{decision}} a revision",
    "space.activity.accepted": "accepted",
    "space.activity.rejected": "rejected",
    "space.activity.revisionDecidedAny": "decided a revision",
    "space.activity.commentStatus": "set a comment to {{status}}",
  };
  let text = table[key] ?? key;
  for (const [name, value] of Object.entries(options ?? {})) {
    text = text.replaceAll(`{{${name}}}`, String(value));
  }
  return text;
};

test("events render in audit vocabulary with object names", () => {
  assert.equal(
    describeSpaceEvent("node.created", { name: "年报.md" }, t),
    "created “年报.md”",
  );
  assert.equal(
    describeSpaceEvent("revision.decided", { status: "accepted" }, t),
    "accepted a revision",
  );
  assert.equal(
    describeSpaceEvent("revision.decided", { status: "rejected" }, t),
    "rejected a revision",
  );
  // Unknown event types fall through to the raw type, never blank.
  assert.equal(describeSpaceEvent("mystery.event", {}, t), "mystery.event");
});

test("actors resolve through members, falling back to a short id", () => {
  const members = [
    { userId: "u1", username: "lance", displayName: "Lance" },
    { userId: "u2", username: "wei" },
  ];
  assert.equal(actorLabel("u1", members), "Lance");
  assert.equal(actorLabel("u2", members), "wei");
  assert.equal(actorLabel("u3abcdef1234", members), "u3abcdef");
  assert.equal(actorLabel(null, members), "—");
});

test("the panel pulls history, folds live frames, dedupes by seq", async () => {
  const page = await read("../src/pages/SpacePage.tsx");
  assert.match(page, /api\.onSpaceEvent\(\(frame\) =>/);
  assert.match(page, /setLiveFrames\(\(prev\) => \[\.\.\.prev\.slice\(-199\), frame\]\)/);
  assert.match(page, /<SpaceActivityStream/);
  const stream = await read("../src/components/space/SpaceActivityStream.tsx");
  assert.match(stream, /\.spaceEventsPull\(\{ spaceId, since: -1 \}\)/);
  assert.match(stream, /bySeq\.set\(frame\.seq, frame\)/);
  // Newest first, capped.
  assert.match(stream, /sort\(\(a, b\) => b\.seq - a\.seq\)/);
});
