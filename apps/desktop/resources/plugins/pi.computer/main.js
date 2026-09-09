/**
 * Computer Use — bundled first-party plugin (LaboFlow P3, FR-C-24).
 *
 * Ported from the frozen LaboFlow computer-use-service: osascript-driven app
 * activation, keystrokes, and screencapture, gated by the host permission
 * engine plus an explicit enable switch and an emergency stop. macOS only.
 */

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const os = require("node:os");
const path = require("node:path");

const execFileAsync = promisify(execFile);

let registered = false;
let stopped = false;

const TOOL = {
  name: "computer",
  description:
    "See and drive this Mac (macOS only): take a screenshot to a file, activate an application, type text into the focused app, or press a key by macOS key code. Every action requires permission; disabled until enabled in plugin settings.",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["screenshot", "activate", "type", "key"],
        description: "screenshot | activate | type | key",
      },
      app: { type: "string", description: "activate: application name" },
      text: { type: "string", description: "type: text to keystroke" },
      key: {
        type: "string",
        description: "key: macOS key code, e.g. 36 Return, 48 Tab, 53 Escape",
      },
    },
    required: ["action"],
  },
};

function assertMac() {
  if (process.platform !== "darwin") {
    throw new Error("Computer Use currently supports macOS only.");
  }
}

/** osascript needs Accessibility (TCC). A no-op script fails without it. */
async function accessibilityGranted() {
  try {
    await execFileAsync("osascript", ["-e", "true"]);
    return true;
  } catch {
    return false;
  }
}

function accessibilityHint() {
  return "macOS Accessibility permission is missing. Grant it in System Settings → Privacy & Security → Accessibility, then retry.";
}

async function execute(args) {
  if (stopped) {
    return {
      error:
        "Computer Use is emergency-stopped. The user can reset it with the 'Computer Use: emergency stop' command toggle.",
    };
  }
  assertMac();

  const action = String(args?.action ?? "");
  try {
    if (action === "screenshot") {
      const file = path.join(os.tmpdir(), `laboflow-computer-${Date.now()}.png`);
      await execFileAsync("screencapture", ["-x", file]);
      return { content: `Screenshot saved to ${file}`, details: { file } };
    }
    if (action === "activate") {
      const app = String(args?.app ?? "").trim();
      if (!app) return { error: "activate requires 'app' (application name)." };
      await execFileAsync("osascript", [
        "-e",
        `tell application "${app.replace(/"/g, '\\"')}" to activate`,
      ]);
      return { content: `Activated ${app}.` };
    }
    if (action === "type") {
      const text = String(args?.text ?? "");
      if (!text) return { error: "type requires 'text'." };
      if (!(await accessibilityGranted())) return { error: accessibilityHint() };
      await execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to keystroke ${JSON.stringify(text)}`,
      ]);
      return { content: `Typed ${text.length} character(s).` };
    }
    if (action === "key") {
      const key = String(args?.key ?? "").trim();
      if (!/^\d+$/.test(key)) {
        return {
          error: "key requires 'key' as a macOS key code number (36 Return, 48 Tab, 53 Escape).",
        };
      }
      if (!(await accessibilityGranted())) return { error: accessibilityHint() };
      await execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to key code ${key}`,
      ]);
      return { content: `Pressed key code ${key}.` };
    }
    return { error: `Unknown computer action: ${action || "(empty)"}` };
  } catch (error) {
    const message = error?.message || String(error);
    if (/not allowed assistive|Accessib|1002|-25211/.test(message)) {
      return { error: accessibilityHint() };
    }
    return { error: message };
  }
}

async function setToolRegistered(enabled) {
  if (enabled && !registered) {
    await pi.agent.registerTool({ ...TOOL, execute });
    registered = true;
    return;
  }
  if (!enabled && registered) {
    await pi.agent.unregisterTool("computer");
    registered = false;
  }
}

async function onLoad() {
  const settings = await pi.plugin.getSettings();
  await pi.commands.register({
    id: "computer-stop",
    title: "Computer Use: emergency stop",
    keywords: ["computer", "stop"],
    run: async () => {
      stopped = !stopped;
      await pi.ui.showToast(
        stopped
          ? "Computer Use: emergency stop ON. All further actions are refused."
          : "Computer Use: emergency stop cleared.",
      );
    },
  });
  await setToolRegistered(Boolean(settings.enabled));
  pi.events.on("plugin:settingsChanged", async () => {
    const next = await pi.plugin.getSettings();
    await setToolRegistered(Boolean(next.enabled));
  });
}

async function onUnload() {
  await pi.commands.unregister("computer-stop");
  if (registered) {
    await pi.agent.unregisterTool("computer");
    registered = false;
  }
}

module.exports = { onLoad, onUnload, execute, TOOL };
