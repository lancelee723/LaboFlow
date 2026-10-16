# ADR 0312: PDFRead Tool — Native Layered PDF Reading for the Agent

- Status: Superseded in part by ADR 0313 (carrier and settings surface; the
  layered reading semantics below remain authoritative)
- Date: 2026-10-16
- Deciders: LaboFlow core
- Related: ADR 0040, ADR 0163, `docs/spec/03-runtime/11-provider-model-system.md`

## Context

Consulting workflows feed the agent PDFs — annual reports, research notes,
scanned financial statements. Today the agent cannot read any of them:

- PDF attachments travel to the model as bounded file references only
  (`prompt-attachments.ts`); pi-ai 1.0.0 has no PDF content block, and the
  settings-facing `pdf` input modality is metadata, not transport.
- The host-core Read tool refuses `.pdf` as binary
  (`crates/host-core/src/tools/mod.rs` `BINARY_EXTENSIONS`).
- The skill-market Anthropic `pdf` skill works only on machines with Python,
  poppler, and Tesseract installed — not a consultant's stock machine.
- Scanned (image-only) pages have no text layer at all; extraction requires
  either model vision or an OCR service.

Decisions from the design review (2026-10-16):

1. Scope: PDF only, but the output contract and settings pane are shaped so
   Office formats (`docx.read`-style tools) can join later without redesign.
2. Strictly no new third-party dependencies: text extraction via the already
   shipped `pdfjs-dist`; scanned-page images are taken from the decoded
   operator-list bitmaps and re-encoded as PNG with Node's built-in `zlib`.
3. Vision path only when the session's effective model supports vision;
   otherwise scanned pages fall back to MinerU.
4. MinerU is opt-in, default off, user-configured (cloud API or self-hosted
   endpoint). No cloud egress happens without explicit user configuration.

## Decision

1. **Tool**: a host-local tool `PDFRead`, registered through the existing
   `AgentSidecar.setLocalTool` seam (same class as `GenerateImages` and
   `BrowserPreview`). The handler executes in Electron main; the engine lives
   in `packages/host-runtime/src/pdf/` as pure functions with vitest coverage.
   `PDFRead` is read-only and therefore admitted in Plan mode alongside
   `BrowserPreview` in the agent-sidecar gate.

2. **Contract** (name follows the PascalCase tool convention, not `pdf.read`):
   input `{ path, pages?, password? }` — `path` accepts the same forms Read
   accepts (workspace-relative, absolute inside session scratch, `attachments/`
   content-addressed refs); `pages` is a 1-based spec like `1-3,7`; `password`
   is supplied on a retry when the tool reports the document is encrypted.
   The agent asks the user for the password in chat; no OS dialog is built.

3. **Layered behavior per page** (classification is per page, not per file —
   real reports mix digital and scanned pages):
   - Text-layer pages: pdf.js text extraction with page numbers, bounded by
     the same output-budget philosophy as Read.
   - Image-only pages: when the effective model supports vision, the largest
     decoded page image is downscaled (≤1600 px long edge) and returned as a
     real image content block via the tool result `images` array (#1073
     mechanism; pi-ai adapters already serialize tool-result images). When
     vision is unavailable, or the page bitmap cannot be recovered, the page
     is routed to MinerU when configured.
   - No vision and no MinerU endpoint: an actionable error names both
     remedies. Never a silent failure.
   - Encrypted documents: detected before any parsing; the tool returns a
     `PDF_ENCRYPTED` actionable error; a retry with `password` decrypts in
     memory only — no decrypted copy is written to disk.

4. **Vision gating**: the agent runtime (which owns the effective model
   config, the same source attachment inlining uses) injects
   `capabilities: { vision }` into the `tools.execute` params; the sidecar
   passes it to local-tool handlers. host-core's Rust `ToolsExecuteParams`
   ignores the extra field (serde default), so no Rust protocol change.

5. **MinerU integration**: a client for the official MinerU v4 HTTP API
   (task submit + poll), executed in Electron main. Endpoint URL and API key
   live in a new `pdfTools` AppSettings section; the key is stored in app
   settings exactly like proxy credentials today. The settings pane is a new
   static「Document Tools」tab in the「Agent」settings group (the literal
  「Extensions」group is reserved for plugin-provided views). Cloud usage is
   opt-in with an on-screen confidentiality notice: documents sent to a cloud
   endpoint leave the machine. Self-hosted endpoints must expose the
   v4-compatible API.

6. **Discoverability**: host-core Read's binary refusal for `.pdf` gains a
   pointer to `PDFRead`, so a model that tries Read first is redirected.

## Alternatives considered

- **Native PDF content block in pi-ai** — correct long-term, but requires an
  upstream protocol change across every provider adapter; pdf.js extraction
  in our runtime delivers the user value without waiting for it.
- **Anthropic `pdf` skill as the only path** — zero code, but depends on
  per-machine Python/poppler/Tesseract and Tesseract's Chinese-table quality
  is poor. Stays in the market for power users; not the default.
- **Vendored Python extraction runtime (slides-plugin pattern)** — proven, but
  the zero-new-dependency decision makes the pure-JS engine cheaper to ship
  and maintain; a Python runtime remains available later if a format gap
  appears.
- **MinerU vendored into the app** — rejected: AGPL-3.0 makes distribution a
  licensing hazard, and self-hosting is the consulting-compatible deployment
  anyway. The arm's-length endpoint keeps LaboFlow out of AGPL scope.
- **Local page rasterization with `@napi-rs/canvas`** — rejected by the
  zero-dependency decision; decoded operator-list bitmaps + Node `zlib` PNG
  encoding cover the same need for embedded-image pages.

## Consequences

- The vision path depends on pdf.js decode support for a page's image codec
  (JPEG/JPX/JBIG2 wasm decoders ship with `pdfjs-dist`); pages whose bitmaps
  cannot be recovered fall back to MinerU.
- Tool-result images are persisted in session history like #1073 images;
  the tool bounds image count and bytes per call to protect context and
  storage (attachment-history budgets remain the outer cap).
- The MinerU v4 client couples us to that API's shape; self-hosted
  deployments must run a v4-compatible gateway. This is the documented
  integration surface and will be revisited if MinerU's self-host API
  diverges.
- `docx/xlsx/pptx` remain skill-mediated; this ADR's contract (page/section
  locators + settings pane) is the template for their future native tools.
