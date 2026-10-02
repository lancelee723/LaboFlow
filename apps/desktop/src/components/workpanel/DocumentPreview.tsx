import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FsDocumentKind } from "@pi-desktop/shared";
import type { PptxViewer } from "@aiden0z/pptx-renderer";
import { Button, cx } from "../ui";
import { IconChevronLeft, IconChevronRight } from "../icons";

/**
 * In-app preview for "document"-kind files (PDF + modern Office formats).
 *
 * PDF renders through pdf.js; DOCX through docx-preview; PPTX through the
 * pptx-renderer engine; XLSX through SheetJS sheet-to-HTML. Each receives the
 * file as a base64 data URL from `fs.read` — the bytes never leave the app.
 * All four renderers run entirely in the renderer process; a document that
 * fails to parse falls back to the file tab's binary/empty state text.
 */

const MAX_CANVAS_SCALE = 2;

/* ------------------------------- PDF (pdf.js) ------------------------------ */

async function pdfWorkerPort(): Promise<Worker> {
  // One shared worker for every document: pdf.js multiplexes documents over a
  // single port. Vite inlines the worker so it also loads from file:// builds.
  const mod = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker&inline");
  return new mod.default();
}

type PdfController = {
  numPages: number;
  renderPage: (page: number, canvas: HTMLCanvasElement) => Promise<void>;
};

let sharedPdfWorker: Promise<Worker> | null = null;
function getSharedPdfWorker(): Promise<Worker> {
  sharedPdfWorker ??= pdfWorkerPort();
  return sharedPdfWorker;
}

async function openPdf(data: ArrayBuffer): Promise<PdfController> {
  const pdfjs = await import("pdfjs-dist");
  // One shared worker multiplexes every document (vite ?worker&inline keeps it
  // loadable from file:// builds and inside the CSP's script-src blob:).
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    pdfjs.GlobalWorkerOptions.workerPort = await getSharedPdfWorker();
  }
  // CJK cmaps, standard fonts, and the JPX/JBIG2 image-decoder WASM live in
  // the renderer's public tree (copyPdfjsAssets in electron.vite.config.ts);
  // without them scanned pages and non-embedded-CJK text render blank.
  // Absolute against the document base: the inline worker resolves relative
  // URLs against its blob: origin, which would 404. (Prod note: fetch() of
  // file:// assets needs a privileged renderer-assets scheme — follow-up.)
  const assetBase = new URL("pdfjs/", document.baseURI).href;
  // pdf.js transfers (detaches) the buffer it is handed. Hand it a copy so
  // StrictMode's double effect invocation and any later re-open do not hit a
  // detached ArrayBuffer — the caller keeps its `data` intact for reuse.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    iccUrl: `${assetBase}iccs/`,
  }).promise;
  return {
    numPages: doc.numPages,
    renderPage: async (page, canvas) => {
      const pdfPage = await doc.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_SCALE);
      const viewport = pdfPage.getViewport({ scale: dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(base.width)}px`;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas unavailable");
      await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
    },
  };
}

function PdfPreview({ data }: { data: ArrayBuffer }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdf, setPdf] = useState<PdfController | null>(null);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPdf(null);
    setPage(1);
    setFailed(false);
    openPdf(data)
      .then((controller) => {
        if (!cancelled) setPdf(controller);
      })
      .catch((error) => {
        console.error("[doc-preview] pdf open failed:", error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    pdf
      .renderPage(page, canvasRef.current)
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pdf, page]);

  if (failed) return <PreviewFailed />;
  if (!pdf) return <PreviewLoading label={t("panel.files.docLoading")} />;
  return (
    <div className="doc-preview pdf">
      <div className="doc-preview-toolbar">
        <Button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          aria-label={t("panel.files.prevPage")}
        >
          <IconChevronLeft size={13} />
        </Button>
        <span className="doc-preview-page">
          {page} / {pdf.numPages}
        </span>
        <Button
          type="button"
          disabled={page >= pdf.numPages}
          onClick={() => setPage((p) => Math.min(pdf.numPages, p + 1))}
          aria-label={t("panel.files.nextPage")}
        >
          <IconChevronRight size={13} />
        </Button>
      </div>
      <div className="doc-preview-scroll">
        <canvas ref={canvasRef} className="doc-preview-pdf-canvas" />
      </div>
    </div>
  );
}

/* ------------------------------ DOCX (docx-preview) ------------------------ */

function DocxPreview({ data }: { data: ArrayBuffer }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    setState("loading");
    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        container.innerHTML = "";
        await renderAsync(new Blob([data]), container, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          experimental: true,
        });
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
      container.innerHTML = "";
    };
  }, [data]);

  if (state === "failed") return <PreviewFailed />;
  return (
    <div className="doc-preview docx">
      {state === "loading" ? <PreviewLoading label={t("panel.files.docLoading")} /> : null}
      <div ref={containerRef} className="doc-preview-docx-container" />
    </div>
  );
}

/* ------------------------------ PPTX (pptx-renderer) ---------------------- */

function PptxPreview({ data }: { data: ArrayBuffer }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let viewer: PptxViewer | null = null;
    let cancelled = false;
    setState("loading");
    void (async () => {
      try {
        const { parseZip, buildPresentation, PptxViewer } = await import(
          "@aiden0z/pptx-renderer"
        );
        if (cancelled) return;
        const files = await parseZip(data);
        if (cancelled) return;
        const presentation = buildPresentation(files);
        container.innerHTML = "";
        viewer = new PptxViewer(container, { fitMode: "contain" });
        viewer.load(presentation);
        await viewer.renderList();
        if (!cancelled) setState("ready");
        else viewer.destroy();
      } catch {
        viewer?.destroy();
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
      viewer?.destroy();
      container.innerHTML = "";
    };
  }, [data]);

  if (state === "failed") return <PreviewFailed />;
  return (
    <div className="doc-preview pptx">
      {state === "loading" ? <PreviewLoading label={t("panel.files.docLoading")} /> : null}
      <div ref={containerRef} className="doc-preview-pptx-container" />
    </div>
  );
}

/* ------------------------------ XLSX (SheetJS) ---------------------------- */

type SheetSummary = { name: string; rows: string[][] };

async function xlsxSheets(data: ArrayBuffer): Promise<SheetSummary[]> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(data, { type: "array" });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    return {
      name,
      rows: rows.slice(0, 500).map((row) =>
        row.map((cell) => String(cell ?? "")),
      ),
    };
  });
}

function XlsxPreview({ data }: { data: ArrayBuffer }) {
  const { t } = useTranslation();
  const [sheets, setSheets] = useState<SheetSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setActive(0);
    setFailed(false);
    xlsxSheets(data)
      .then((parsed) => {
        if (!cancelled) setSheets(parsed);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  const current = useMemo(() => sheets?.[active] ?? null, [sheets, active]);
  if (failed) return <PreviewFailed />;
  if (!sheets) return <PreviewLoading label={t("panel.files.docLoading")} />;
  return (
    <div className="doc-preview xlsx">
      {sheets.length > 1 ? (
        <div className="doc-preview-toolbar" role="tablist" aria-label={t("panel.files.sheets")}>
          {sheets.map((sheet, index) => (
            <Button
              key={sheet.name}
              type="button"
              role="tab"
              aria-selected={index === active}
              className={cx(index === active && "active")}
              onClick={() => setActive(index)}
            >
              {sheet.name}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="doc-preview-scroll">
        <table className="doc-preview-sheet">
          <tbody>
            {current?.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* --------------------------------- Shell ---------------------------------- */

function PreviewLoading({ label }: { label: string }) {
  return (
    <div className="doc-preview-loading" role="status">
      <span className="tool-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function PreviewFailed() {
  const { t } = useTranslation();
  return (
    <div className="doc-preview-loading" role="alert">
      <span>{t("panel.files.docFailed")}</span>
    </div>
  );
}

export function DocumentPreview({
  documentKind,
  dataUrl,
}: {
  documentKind: FsDocumentKind;
  dataUrl: string;
}) {
  const data = useMemo<ArrayBuffer | null>(() => {
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    } catch {
      return null;
    }
  }, [dataUrl]);

  if (!data) return <PreviewFailed />;
  if (documentKind === "pdf") return <PdfPreview data={data} />;
  if (documentKind === "docx") return <DocxPreview data={data} />;
  if (documentKind === "pptx") return <PptxPreview data={data} />;
  return <XlsxPreview data={data} />;
}
