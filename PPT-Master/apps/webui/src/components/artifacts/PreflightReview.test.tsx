import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { PreflightReview } from "./PreflightReview"

const baseProps = {
  projectBrief: "",
  templateId: null,
  canvasFormat: "ppt169",
  pageCount: 12,
  colors: [{ name: "primary", hex: "#1a73e8" }],
  typography: {
    font_family: "Microsoft YaHei",
    title_family: "Microsoft YaHei",
    body_family: "Microsoft YaHei",
    body_size: 22,
  },
  iconLibrary: "tabler_filled",
  imageStrategy: "placeholder",
  pages: [{ title: "Cover", type: "cover" }],
  onStart: vi.fn(),
}

describe("PreflightReview", () => {
  it("renders Page Count as its own section, separate from Canvas", () => {
    const html = renderToStaticMarkup(<PreflightReview {...baseProps} />)
    // Canvas section no longer says "— N pages"
    expect(html).toContain("Canvas")
    expect(html).toContain("Page Count")
    expect(html).not.toMatch(/ppt169\s*—\s*12 pages/)
  })

  it("shows the AI rationale block when reasoning is provided", () => {
    const html = renderToStaticMarkup(
      <PreflightReview
        {...baseProps}
        pageCountReasoning="Source has 11 chapters plus a closing summary."
        pageCountMode="ai_decide"
      />,
    )
    expect(html).toContain("AI rationale")
    expect(html).toContain("11 chapters")
  })

  it("hides the rationale block when no reasoning is provided", () => {
    const html = renderToStaticMarkup(<PreflightReview {...baseProps} />)
    expect(html).not.toContain("AI rationale")
  })

  it("page count input reflects the supplied prop value", () => {
    const html = renderToStaticMarkup(<PreflightReview {...baseProps} pageCount={20} />)
    // Number input renders with value="20"
    expect(html).toMatch(/value="20"/)
  })
})
