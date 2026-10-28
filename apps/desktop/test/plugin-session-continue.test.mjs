import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { admitSessionContinue, SESSION_CONTINUE_MAX_PER_WINDOW } =
  await import("../electron/main/plugin-session-continue.ts");

test("admits up to the cap inside the window", () => {
  const hits = [];
  const t0 = 1_000_000;
  for (let i = 0; i < SESSION_CONTINUE_MAX_PER_WINDOW; i++) {
    assert.equal(admitSessionContinue(hits, t0 + i), true);
  }
  assert.equal(admitSessionContinue(hits, t0 + 100), false, "cap reached");
});

test("the window slides: old hits expire and admission resumes", () => {
  const hits = [];
  const t0 = 1_000_000;
  for (let i = 0; i < SESSION_CONTINUE_MAX_PER_WINDOW; i++) admitSessionContinue(hits, t0 + i);
  assert.equal(admitSessionContinue(hits, t0 + 50_000), false);
  assert.equal(admitSessionContinue(hits, t0 + 61_000), true, "first hit expired");
});

test("rejected calls do not consume a slot", () => {
  const hits = [];
  const t0 = 1_000_000;
  for (let i = 0; i < SESSION_CONTINUE_MAX_PER_WINDOW; i++) admitSessionContinue(hits, t0 + i);
  // spam rejections at the cap
  for (let i = 0; i < 5; i++) assert.equal(admitSessionContinue(hits, t0 + 500 + i), false);
  // still exactly the original hits recorded
  assert.equal(hits.length, SESSION_CONTINUE_MAX_PER_WINDOW);
});
