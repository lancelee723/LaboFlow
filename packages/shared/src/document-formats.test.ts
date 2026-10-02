import { expect, it } from "vitest";
import {
  DOCUMENT_PREVIEW_EXTENSIONS,
  DOCUMENT_PREVIEW_MIME,
  isDocumentPreviewPath,
} from "./document-formats.js";

it("recognizes every previewable document extension, case-insensitively", () => {
  for (const ext of DOCUMENT_PREVIEW_EXTENSIONS) {
    expect(isDocumentPreviewPath(`report.${ext}`)).toBe(true);
    expect(isDocumentPreviewPath(`report.${ext.toUpperCase()}`)).toBe(true);
    expect(isDocumentPreviewPath(`a/b/c/file.${ext}`)).toBe(true);
    expect(isDocumentPreviewPath(`C:\\dir\\file.${ext}`)).toBe(true);
  }
});

it("rejects non-document paths and ambiguous names", () => {
  expect(isDocumentPreviewPath("archive.zip")).toBe(false);
  expect(isDocumentPreviewPath("legacy.doc")).toBe(false);
  expect(isDocumentPreviewPath("legacy.ppt")).toBe(false);
  expect(isDocumentPreviewPath("notes.md")).toBe(false);
  expect(isDocumentPreviewPath("no-extension")).toBe(false);
  expect(isDocumentPreviewPath(".pdf")).toBe(false); // dotfile, not an extension
  expect(isDocumentPreviewPath("")).toBe(false);
  expect(isDocumentPreviewPath(null)).toBe(false);
});

it("every extension maps to a canonical MIME", () => {
  for (const ext of DOCUMENT_PREVIEW_EXTENSIONS) {
    expect(DOCUMENT_PREVIEW_MIME[ext]).toMatch(
      /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.)/,
    );
  }
});
