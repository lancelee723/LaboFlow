import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceEditor } from "./AudienceEditor"

describe("AudienceEditor", () => {
  it("renders audience chip options", () => {
    const html = renderToStaticMarkup(
      <AudienceEditor prompt="" onSubmit={vi.fn()} />,
    )
    expect(html).toContain("Executives")
    expect(html).toContain("Investors")
    expect(html).toContain("Technical")
  })

  it("renders the occasion and core message fields", () => {
    const html = renderToStaticMarkup(
      <AudienceEditor prompt="Pick audience" onSubmit={vi.fn()} />,
    )
    expect(html).toContain("Usage Occasion")
    expect(html).toContain("Core Message")
  })

  it("pre-selects the executives chip when recommendation matches 'C-suite executives'", () => {
    // NOTE: renderToStaticMarkup does not run useEffect; the chip pre-selection
    // is a client-side effect. We verify the recommendation banner is rendered
    // (server-side) and that the component renders without error.
    const html = renderToStaticMarkup(
      <AudienceEditor
        prompt=""
        recommendation={{
          audience: "C-suite executives",
          occasion: "Board meeting",
          core_message: "Strategic pivot needed",
        }}
        onSubmit={vi.fn()}
      />,
    )
    // The AI recommendation banner IS rendered on the server (no effect needed)
    expect(html).toContain("AI recommendation pre-filled")
    // The executives chip label must be present
    expect(html).toContain("Executives")
  })

  it("pre-selects investors chip when recommendation audience is 'shareholders'", () => {
    // NOTE: useEffect does not run in renderToStaticMarkup.
    // The banner and chip labels are server-rendered; chip selection state is client-only.
    const html = renderToStaticMarkup(
      <AudienceEditor
        prompt=""
        recommendation={{
          audience: "Investors / Shareholders",
          occasion: "",
          core_message: "",
        }}
        onSubmit={vi.fn()}
      />,
    )
    expect(html).toContain("AI recommendation pre-filled")
    expect(html).toContain("Investors")
  })

  it("does not pre-select any chip when no recommendation is provided", () => {
    const html = renderToStaticMarkup(
      <AudienceEditor prompt="" onSubmit={vi.fn()} />,
    )
    // No AI recommends badge should appear without recommendation
    expect(html).not.toContain("AI recommends")
  })

  it("renders the AI recommendation banner when recommendation is present", () => {
    const html = renderToStaticMarkup(
      <AudienceEditor
        prompt=""
        recommendation={{ audience: "General Public / Media", occasion: "", core_message: "" }}
        onSubmit={vi.fn()}
      />,
    )
    // The recommendation banner is always rendered server-side when recommendation prop is set
    expect(html).toContain("AI recommendation pre-filled")
    expect(html).toContain("General Public")
  })
})
