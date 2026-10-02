/**
 * T53.3 本机 HTTP 服务（通用 Webhook）: `POST /im/task` runs a headless
 * assistant turn — sync `{reply, files}` within the budget, otherwise
 * `{taskId}` plus `GET /im/task/:id` polling and an SSE event stream.
 * `/api/schedules` exposes the automation registry on the same auth domain
 * (FR-MC-16). Security: binds 127.0.0.1 by default (LAN opt-in is an explicit
 * setting), constant-time secret comparison, no CORS, secrets never logged.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type WebhookConfig = {
  secret: string;
  port: number;
  /** LAN opt-in (explicit confirm in settings); default loopback only. */
  lanOpen: boolean;
  syncBudgetMs: number;
};

export type WebhookTask = {
  id: string;
  state: "running" | "succeeded" | "failed";
  message: string;
  createdAt: number;
  finishedAt?: number;
  reply?: string;
  files?: string[];
  error?: string;
  /** SSE listeners resolved on completion. */
  listeners: Set<(event: string) => void>;
};

export type WebhookStatus = {
  running: boolean;
  port: number | null;
  lanOpen: boolean;
  secretSet: boolean;
  /** Masked for UI display; never the raw secret. */
  secretPreview: string;
};

export type HeadlessRunner = (input: {
  message: string;
  signal: AbortSignal;
}) => Promise<{ reply: string; files: string[] }>;

const MAX_TASKS = 200;

/** Constant-time secret match for plain body secrets and HMAC digests. */
export function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison to keep timing flat across length mismatches.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function hmacSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function createWebhookServer(input: {
  config: WebhookConfig;
  runner: HeadlessRunner;
  listSchedules?: () => Promise<unknown>;
  log?: (level: string, message: string) => void;
}): {
  start(): Promise<number>;
  stop(): Promise<void>;
  tasks(): Map<string, WebhookTask>;
  reconfigure(patch: {
    secret?: string;
    port?: number;
    lanOpen?: boolean;
  }): Promise<WebhookStatus>;
  describe(): WebhookStatus;
} {
  const { config, runner } = input;
  let running = false;
  const taskMap = new Map<string, WebhookTask>();
  let server: Server | null = null;
  let restarts = 0;

  const log = input.log ?? (() => undefined);

  function rememberTask(task: WebhookTask): void {
    taskMap.set(task.id, task);
    if (taskMap.size > MAX_TASKS) {
      const oldest = [...taskMap.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) taskMap.delete(oldest.id);
    }
  }

  function emit(task: WebhookTask, event: string): void {
    for (const listener of task.listeners) listener(event);
    task.listeners.clear();
  }

  async function execute(task: WebhookTask): Promise<void> {
    const controller = new AbortController();
    try {
      const result = await runner({ message: task.message, signal: controller.signal });
      task.state = "succeeded";
      task.reply = result.reply;
      task.files = result.files;
      task.finishedAt = Date.now();
      emit(task, JSON.stringify({ type: "completed", reply: result.reply }));
    } catch (error) {
      task.state = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.finishedAt = Date.now();
      emit(task, JSON.stringify({ type: "failed", error: task.error }));
    }
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          reject(Object.assign(new Error("body too large"), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "null",
    });
    res.end(payload);
  }

  const serverHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // No CORS: local tooling and Shortcuts don't need it; browsers must not.
    if (req.method === "OPTIONS") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (!pathAuthorized(url, req)) {
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "secret required" } });
      return;
    }
    if (req.method === "POST" && url.pathname === "/im/task") {
      let body: { message?: unknown; secret?: unknown };
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        sendJson(res, (error as { statusCode?: number }).statusCode ?? 400, {
          error: { code: "EBODY", message: "invalid json body" },
        });
        return;
      }
      const message = String(body.message ?? "").trim();
      if (!message) {
        sendJson(res, 422, { error: { code: "EEMPTY", message: "message is required" } });
        return;
      }
      const task: WebhookTask = {
        id: `im-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        state: "running",
        message,
        createdAt: Date.now(),
        listeners: new Set(),
      };
      rememberTask(task);
      const execution = execute(task);
      const raced = await Promise.race([
        execution.then(() => "done" as const),
        new Promise<"budget">((resolve) => setTimeout(() => resolve("budget"), config.syncBudgetMs)),
      ]);
      if (raced === "done") {
        sendJson(res, 200, { reply: task.reply ?? "", files: task.files ?? [] });
      } else {
        sendJson(res, 202, { taskId: task.id });
      }
      return;
    }
    const taskMatch = url.pathname.match(/^\/im\/task\/([\w-]+)(\/events)?$/);
    if (req.method === "GET" && taskMatch) {
      const task = taskMap.get(taskMatch[1]!);
      if (!task) {
        sendJson(res, 404, { error: { code: "ENOTFOUND", message: "unknown task" } });
        return;
      }
      if (url.pathname.endsWith("/events") || req.headers.accept === "text/event-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        if (task.state !== "running") {
          res.write(`data: ${JSON.stringify({ type: task.state })}\n\n`);
          res.end();
          return;
        }
        const listener = (event: string) => {
          res.write(`data: ${event}\n\n`);
          res.end();
        };
        task.listeners.add(listener);
        return;
      }
      sendJson(res, 200, {
        taskId: task.id,
        state: task.state,
        ...(task.reply !== undefined ? { reply: task.reply } : {}),
        ...(task.files ? { files: task.files } : {}),
        ...(task.error ? { error: task.error } : {}),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/schedules" && input.listSchedules) {
      sendJson(res, 200, await input.listSchedules());
      return;
    }
    sendJson(res, 404, { error: { code: "ENOTFOUND", message: "unknown path" } });
  };

  /** Auth: Authorization: Bearer <secret> | X-LaboFlow-Secret | HMAC header. */
  function pathAuthorized(url: URL, req: IncomingMessage): boolean {
    const provided = bearerToken(req) ?? String(req.headers["x-laboflow-secret"] ?? "");
    if (provided) return secretMatches(provided, config.secret);
    const signature = String(req.headers["x-laboflow-signature"] ?? "");
    if (signature) {
      // HMAC path authenticates the raw body; presence checked post-read.
      return true;
    }
    return false;
  }

  function bearerToken(req: IncomingMessage): string | null {
    const header = String(req.headers.authorization ?? "");
    return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  }

  function describe(): WebhookStatus {
    return {
      running,
      port: server?.listening ? (config.lanOpen ? config.port : config.port) : null,
      lanOpen: config.lanOpen,
      secretSet: Boolean(config.secret && config.secret !== "pending"),
      secretPreview: config.secret ? `${config.secret.slice(0, 5)}…${config.secret.slice(-4)}` : "",
    };
  }

  async function start(): Promise<number> {
      running = false;
      let attemptPort = config.port;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          server = createServer((req, res) => {
            void serverHandler(req, res).catch((error) => {
              log("error", `webhook handler: ${String(error)}`);
              try {
                sendJson(res, 500, { error: { code: "EINTERNAL", message: "internal error" } });
              } catch {
                /* socket gone */
              }
            });
          });
          // HMAC signature verification needs the raw body: wrap once more.
          server.on("request", (req, res) => {
            const signature = String(req.headers["x-laboflow-signature"] ?? "");
            if (signature && !res.writableEnded) {
              const chunks: Buffer[] = [];
              req.on("data", (chunk: Buffer) => chunks.push(chunk));
              req.on("end", () => {
                const payload = Buffer.concat(chunks).toString("utf8");
                if (!secretMatches(signature, hmacSignature(payload, config.secret))) {
                  res.writeHead(401, { "content-type": "application/json" });
                  res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "bad signature" } }));
                  req.destroy();
                }
              });
            }
          });
          const host = config.lanOpen ? "0.0.0.0" : "127.0.0.1";
          const bound = await new Promise<number>((resolve, reject) => {
            server!.once("error", reject);
            server!.listen(attemptPort, host, () => {
              const address = server!.address();
              resolve(typeof address === "object" && address ? address.port : attemptPort);
            });
          });
          log("info", `webhook server on ${host}:${bound}`);
          running = true;
          // NFR-MC3: unexpected close (not our stop) restarts up to 3 times.
          server!.on("close", () => {
            if (!running) return;
            running = false;
            restarts += 1;
            if (restarts > 3) {
              log("error", "webhook server exceeded restart budget; giving up");
              return;
            }
            log("warn", `webhook server closed; restarting (${restarts}/3)`);
            void (async () => {
              try {
                await start();
              } catch (error) {
                log("error", `webhook restart failed: ${String(error)}`);
              }
            })();
          });
          return bound;
        } catch {
          server = null;
          attemptPort += 1;
        }
      }
      throw new Error("no available port for webhook server");
  }

  async function stop(): Promise<void> {
      running = false;
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
  }

  async function reconfigure(patch: {
    secret?: string;
    port?: number;
    lanOpen?: boolean;
  }): Promise<WebhookStatus> {
    if (patch.secret !== undefined) config.secret = patch.secret;
    if (patch.lanOpen !== undefined) config.lanOpen = patch.lanOpen;
    const needsRebind = patch.port !== undefined && patch.port !== config.port;
    if (patch.port !== undefined) config.port = patch.port;
    if (needsRebind && running) {
      await stop();
      await start();
    }
    return describe();
  }

  return { start, stop, tasks: () => taskMap, reconfigure, describe };
}
