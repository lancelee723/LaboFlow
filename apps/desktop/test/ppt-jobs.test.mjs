import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJobManager } from "../resources/plugins/laboflow.slides/lib/ppt-jobs.js";

const tmpDataDir = () => mkdtempSync(join(tmpdir(), "ppt-jobs-"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a submitted job runs to success and persists its record", async () => {
  const dataDir = tmpDataDir();
  const mgr = createJobManager({ dataDir });
  let ran = false;
  const submitted = mgr.submit({
    kind: "ppt-setup",
    run: async (ctx) => {
      ctx.log("step 1");
      ran = true;
      return { stage: "ready" };
    },
  });
  assert.equal(submitted.status, "running");
  await tick();
  await tick();
  assert.equal(ran, true);
  const job = mgr.get(submitted.id);
  assert.equal(job.status, "succeeded");
  assert.deepEqual(job.result, { stage: "ready" });
  assert.ok((job.logTail ?? []).some((line) => line.includes("step 1")));
  const persisted = JSON.parse(readFileSync(join(dataDir, "jobs", `${submitted.id}.json`), "utf8"));
  assert.equal(persisted.status, "succeeded");
});

test("a throwing job lands in failed with the error captured", async () => {
  const mgr = createJobManager({ dataDir: tmpDataDir() });
  const submitted = mgr.submit({
    kind: "ppt-setup",
    run: async () => {
      throw new Error("deps-missing: network down");
    },
  });
  await tick();
  await tick();
  const job = mgr.get(submitted.id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /network down/);
});

test("cancel aborts a running job and the status becomes cancelled", async () => {
  const mgr = createJobManager({ dataDir: tmpDataDir() });
  const submitted = mgr.submit({
    kind: "ppt-setup",
    run: (ctx) =>
      new Promise((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => resolve("never"), 5_000);
      }),
  });
  await tick();
  const cancelResult = mgr.cancel(submitted.id);
  assert.equal(cancelResult.ok, true);
  await tick();
  await tick();
  assert.equal(mgr.get(submitted.id).status, "cancelled");
});

test("recover marks non-terminal persisted jobs as interrupted", () => {
  const dataDir = tmpDataDir();
  mkdirSync(join(dataDir, "jobs"), { recursive: true });
  writeFileSync(
    join(dataDir, "jobs", "ppt-setup-stale-1.json"),
    JSON.stringify({ id: "ppt-setup-stale-1", kind: "ppt-setup", status: "running", createdAt: "t0" }),
  );
  writeFileSync(
    join(dataDir, "jobs", "ppt-setup-done-2.json"),
    JSON.stringify({ id: "ppt-setup-done-2", kind: "ppt-setup", status: "succeeded", createdAt: "t1" }),
  );
  const mgr = createJobManager({ dataDir });
  const recovered = mgr.recover();
  assert.deepEqual(recovered, ["ppt-setup-stale-1"]);
  assert.equal(mgr.get("ppt-setup-stale-1").status, "interrupted");
  assert.match(mgr.get("ppt-setup-stale-1").error, /中断/);
  assert.equal(mgr.get("ppt-setup-done-2").status, "succeeded", "terminal jobs stay");
  assert.ok(existsSync(join(dataDir, "jobs", "ppt-setup-stale-1.json")));
});

test("persistence prunes to the latest 20 job files", async () => {
  const dataDir = tmpDataDir();
  const mgr = createJobManager({ dataDir });
  for (let i = 0; i < 24; i += 1) {
    mgr.submit({ kind: "tick", run: async () => i });
    await tick();
  }
  await tick();
  await tick();
  const files = readdirSafe(join(dataDir, "jobs"));
  assert.equal(files.length, 20);
  const listed = mgr.list();
  assert.equal(listed.length, 20);
});

test("get on an unknown id returns null; jobs without a dataDir still run", async () => {
  const mgr = createJobManager({});
  assert.equal(mgr.get("nope"), null);
  const submitted = mgr.submit({ kind: "x", run: async () => 42 });
  await tick();
  await tick();
  assert.equal(mgr.get(submitted.id).result, 42);
});

function readdirSafe(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}
