type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
import { clearUnattendedPolicy, registerUnattendedPolicy } from "../assistant/unattended-policy";
export type ScheduledLaunch = {
  sessionId: string;
  prompt: string;
  runId: string;
  /** Full task snapshot from the host; carries the per-task overrides. */
  task?: {
    unattendedPolicy?: string | null;
    catchUpEnabled?: boolean | null;
    outputDestination?: string | null;
  } | null;
};

/** FR-MC-17 tiers, validated host-side before they ever persist. */
const UNATTENDED_POLICIES = ["strict", "degraded", "lenient"] as const;
type UnattendedPolicyName = (typeof UNATTENDED_POLICIES)[number];

/** R5-6: scheduled runs default to strict — ask-class calls auto-deny. */
function taskUnattendedPolicy(task: ScheduledLaunch["task"]): UnattendedPolicyName {
  const policy = task?.unattendedPolicy;
  return UNATTENDED_POLICIES.find((name) => name === policy) ?? "strict";
}

/** Runs through the same prompt entry point as an interactive desktop turn. */
export async function executeScheduledTask(options: {
  host: Host;
  isCurrent: () => boolean;
  id: string;
  automatic: boolean;
  runs: Map<string, string>;
  prompt: (sessionId: string, content: string) => Promise<unknown>;
}): Promise<ScheduledLaunch> {
  const { host, id, automatic, runs, prompt, isCurrent } = options;
  const launch = await host.call<ScheduledLaunch>("scheduled.run", { id, automatic });
  try {
    if (!isCurrent()) throw new Error("scheduled runtime stopped");
    runs.set(launch.sessionId, launch.runId);
    // FR-MC-17: the task's own policy wins; strict stays the default.
    registerUnattendedPolicy(launch.sessionId, taskUnattendedPolicy(launch.task));
    await prompt(launch.sessionId, launch.prompt);
    return launch;
  } catch (error) {
    clearUnattendedPolicy(launch.sessionId);
    if (runs.get(launch.sessionId) === launch.runId) runs.delete(launch.sessionId);
    try {
      await host.call("scheduled.finishRun", {
        runId: launch.runId,
        status: "error",
        errorCode: "SCHEDULE_DISPATCH_FAILED",
      });
    } catch (persistenceError) {
      throw new AggregateError([error, persistenceError], "Scheduled dispatch and failure recording both failed");
    }
    throw error;
  }
}

export function createScheduledRunner(options: {
  getHost: () => Host | null;
  execute: (id: string) => Promise<unknown>;
  report: (error: unknown) => void;
}) {
  let stopped = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const dispatches = new Map<string, { host: Host }>();
  const tick = async () => {
    if (stopped || polling) return;
    const host = options.getHost();
    if (!host) return;
    polling = true;
    try {
      const { ids } = await host.call<{ ids: string[] }>("scheduled.due");
      for (const id of ids) {
        if (stopped || options.getHost() !== host) break;
        if (dispatches.get(id)?.host === host) continue;
        const owner = { host };
        dispatches.set(id, owner);
        // Polling owns admission requests, not the duration of prompt setup.
        // Host remains authoritative for enabled/due/overlap checks. Keep a
        // local owner until setup settles so another poll cannot dispatch the
        // same task while its admission request is still in flight.
        void (async () => {
          try {
            await options.execute(id);
          } catch (error) {
            options.report(error);
          } finally {
            if (dispatches.get(id) === owner) dispatches.delete(id);
          }
        })();
      }
    } catch (error) {
      options.report(error);
    } finally {
      polling = false;
    }
  };
  return {
    tick,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => void tick(), 30_000);
      timer.unref();
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
