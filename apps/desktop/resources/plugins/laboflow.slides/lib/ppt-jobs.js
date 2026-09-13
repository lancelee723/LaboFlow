/**
 * In-process background job manager (module 06 L2, DEVPLAN Phase A).
 *
 * Pi gives an agent tool 110 seconds; venv setup and 30-page exports need
 * minutes. Long work therefore runs as a plugin-side job: submit returns a
 * jobId immediately, `ppt_job_status` polls, records persist under
 * <dataDir>/jobs/<id>.json (latest 20). Jobs still queued/running when the
 * plugin reloads are marked `interrupted` on recovery — the venv child may
 * have died with the process, so the agent must re-check with
 * ppt_master_status instead of assuming success.
 *
 * No `pi.*` access — the store is injectable and headless-testable.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_PERSISTED_JOBS = 20;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function createJobManager({ dataDir, now = () => new Date().toISOString(), logger } = {}) {
  const jobsDir = dataDir ? join(dataDir, "jobs") : null;
  const jobs = new Map();
  let counter = 0;

  const persist = (job) => {
    if (!jobsDir) return;
    try {
      mkdirSync(jobsDir, { recursive: true });
      writeFileSync(join(jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2));
    } catch (error) {
      logger?.(`job persist failed: ${error?.message ?? error}`);
    }
  };

  const prune = () => {
    if (!jobsDir || !existsSync(jobsDir)) return;
    const files = readdirSync(jobsDir).filter((f) => f.endsWith(".json")).sort();
    while (files.length > MAX_PERSISTED_JOBS) {
      const victim = files.shift();
      try {
        rmSync(join(jobsDir, victim));
      } catch {
        /* best effort */
      }
    }
  };

  /** On load: any non-terminal persisted job died with the old process. */
  const recover = () => {
    if (!jobsDir || !existsSync(jobsDir)) return [];
    const recovered = [];
    for (const file of readdirSync(jobsDir).filter((f) => f.endsWith(".json"))) {
      try {
        const job = JSON.parse(readFileSync(join(jobsDir, file), "utf8"));
        jobs.set(job.id, job);
        if (!TERMINAL.has(job.status)) {
          job.status = "interrupted";
          job.finishedAt = now();
          job.error = "插件重载时作业中断：请用 ppt_master_status 重新检查实际状态";
          persist(job);
          recovered.push(job.id);
        }
      } catch {
        /* corrupt record — drop */
      }
    }
    return recovered;
  };

  const submit = ({ kind, run }) => {
    counter += 1;
    const id = `${kind}-${Date.now().toString(36)}-${counter}`;
    const job = {
      id,
      kind,
      status: "running",
      createdAt: now(),
      startedAt: now(),
      finishedAt: null,
      error: null,
      result: null,
    };
    jobs.set(id, job);
    persist(job);
    prune();
    const controller = new AbortController();
    job._controller = controller;
    const ctx = {
      signal: controller.signal,
      log: (line) => {
        job.logTail = [...(job.logTail ?? []).slice(-49), String(line).slice(0, 500)];
        logger?.(`[${id}] ${line}`);
      },
    };
    void (async () => {
      try {
        job.result = await run(ctx);
        job.status = controller.signal.aborted ? "cancelled" : "succeeded";
      } catch (error) {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.error = String(error?.message ?? error).slice(0, 2000);
      } finally {
        job.finishedAt = now();
        job._controller = undefined;
        persist(job);
      }
    })();
    return { id, status: job.status };
  };

  const get = (id) => {
    const job = jobs.get(String(id));
    if (!job) return null;
    const { _controller, ...publicJob } = job;
    return publicJob;
  };

  const list = () =>
    [...jobs.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, MAX_PERSISTED_JOBS)
      .map((job) => get(job.id));

  const cancel = (id) => {
    const job = jobs.get(String(id));
    if (!job) return { ok: false, reason: "not-found" };
    if (TERMINAL.has(job.status) || job.status === "interrupted") {
      return { ok: false, reason: `already-${job.status}` };
    }
    job._controller?.abort();
    return { ok: true };
  };

  return { submit, get, list, cancel, recover };
}
