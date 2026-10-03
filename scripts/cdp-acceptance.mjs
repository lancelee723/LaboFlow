#!/usr/bin/env node
/** CDP driver for LaboFlow real-machine acceptance (DEVPLAN §6.3 GUI tier). */
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.CDP_PORT ?? 9223);
async function target() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((p) => p.type === "page" && !p.url.includes("plugin-launcher"));
  if (!page) throw new Error("main page not found: " + JSON.stringify(list.map((p) => p.url)));
  return page;
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  static async connect() {
    const page = await target();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 60_000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error("page threw: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    return r.result?.value;
  }
  async screenshot(path) {
    const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return path;
  }
}
