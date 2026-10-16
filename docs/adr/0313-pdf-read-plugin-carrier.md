# ADR 0313: PDFRead Moves to a Bundled Plugin

- Status: Accepted
- Date: 2026-10-16
- Deciders: LaboFlow core
- Related: ADR 0312, ADR 0040, ADR 0211

## Context

ADR 0312 shipped PDFRead as a host-local tool registered on the agent sidecar
(next to `GenerateImages` / `BrowserPreview`), with the MinerU configuration
in a static "Document Tools" settings tab. Product review (same day) asked
for the plugin carrier instead:

1. A plugin is independently disable-able and uninstall-able, and can later
   be distributed or versioned outside the app release train.
2. The settings the user asked for belong with the plugin: the settings
   dialog already renders `contributes.settings` sheets per plugin, which is
   exactly the "PDF 工具设置" surface the original request described. The
   static settings tab duplicated that mechanism.
3. The bundled-plugin pattern is established (ADR 0040, `laboflow.slides`):
   vendored runtime inside the plugin, trusted first-party code, enabled by
   default.

The blocker ADR 0312 had noted — plugin tool context carries no model
capabilities — is now bridged at the host layer rather than being a reason
to avoid the plugin.

## Decision

1. **Carrier**: a bundled first-party plugin `laboflow.pdf`
   (`apps/desktop/resources/plugins/laboflow.pdf/`), enabled by default. The
   engine (pdf.js text layer, operator-list bitmaps, PNG encoding, MinerU v4
   client) is vendored inside the plugin (`lib/`, `vendor/pdfjs/`); the
   former host-runtime copy is removed so the plugin is the single home.
   Tests moved with it (`apps/desktop/test/pdf-plugin.test.mjs`).
2. **Model-facing name**: `plugin_laboflow_pdf_read` (the standard
   `plugin_<id>_<name>` namespace). host-core Read's binary refusal for
   `.pdf` redirects to that name.
3. **Settings**: MinerU endpoint + API token are `contributes.settings`
   entries owned by the plugin; the host renders and persists them through
   the existing plugin-settings sheet, and the plugin reads them via
   `pi.plugin.getSettings()`. The ADR 0312 static settings tab, its i18n
   keys, and the `pdfTools` AppSettings section are removed.
4. **Vision bridge**: the desktop host resolves, best-effort, whether the
   session's pinned model accepts images (`enrichSession` over
   `session.get`) and passes `supportsVision` in the plugin tool execution
   context (`RegisteredPluginTool.execute` ctx, threaded through
   `plugins.execute` → plugin child → `tool.execute`). Undefined means
   unresolved; the plugin then skips page imaging and routes scanned pages
   to MinerU or the actionable error, per ADR 0312's layered rules.
5. **Network**: the plugin holds `net.fetch` + `net.anyHost` — the
   documented escape hatch for plugins whose endpoints the user types in.
   The MinerU flow uses the JSON base64 upload endpoint
   (`POST /api/v4/file-queue/file`) so every request fits `pi.net.fetch`'s
   text body; the result archive is fetched with a new
   `responseFormat: "base64"` option on `pi.net.fetch` for binary bodies.
6. **Plan mode**: the tool declares `planSafeActions: ["read"]` with a
   constant `action: "read"` parameter, riding the ADR 0211 gate instead of
   the host-local allowlist ADR 0312 had used.

## Alternatives considered

- **Keep the host-local tool and only move settings** — half the benefit,
  two surfaces to maintain; rejected.
- **`desktop.invoke` host bridge for the engine** — the desktop operations
  channel is consent-gated for dangerous operations (session delete,
  permission changes); a per-read consent dialog would be unusable.
- **Extending the plugin fs-policy roots (attachments/scratch)** — the
  trusted-first-party pattern (ADR 0040) already runs plugin code with full
  Node builtins; the plugin's `lib/paths.js` implements the same three-root
  realpath containment the host uses for prompt attachments instead.

## Consequences

- The engine is plain JS inside the plugin; its tests run under the
  desktop `node --test` suite rather than a package vitest config.
- `pi.net.fetch` gains a `responseFormat` field (additive; SDK change).
- The plugin's data-dir derivation (`getDataPath()` + verified `../../..`)
  depends on the host's `plugins/data/<id>` layout; a layout change fails
  closed in `dataDirFromPluginDataPath` (roots must exist).
- Disabling the plugin removes PDF reading entirely; Read's redirect then
  names a tool that is not loaded, and the model falls back to asking the
  user — acceptable for an explicitly disabled capability.
- ADR 0312's layered reading semantics (per-page classification, budgets,
  encryption handling, vision gating, MinerU fallback) carry over unchanged;
  only the carrier and settings surface changed.
