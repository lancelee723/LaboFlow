import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { NumberInputGate } from "./NumberInputGate"

describe("NumberInputGate", () => {
  it("renders both radio options with descriptive labels", () => {
    const html = renderToStaticMarkup(
      <NumberInputGate
        title="Page Count"
        prompt="Determine the page count for this presentation."
        onSubmit={vi.fn()}
      />,
    )
    // Apostrophe is HTML-entity-encoded in static markup: I&#x27;ll → check substring after it
    expect(html).toContain("specify the page count")
    expect(html).toContain("Let AI decide based on materials")
    expect(html).toContain("Page Count")
    expect(html).toContain("Determine the page count")
  })

  it("does NOT render any 'Use AI recommendation' checkbox", () => {
    const html = renderToStaticMarkup(
      <NumberInputGate title="Page Count" prompt="" onSubmit={vi.fn()} />,
    )
    expect(html).not.toContain("Use AI recommendation")
  })

  it("renders the unit suffix", () => {
    const html = renderToStaticMarkup(
      <NumberInputGate title="Page Count" prompt="" unit="pages" onSubmit={vi.fn()} />,
    )
    expect(html).toContain("pages")
  })

  it("does not error when prompt is empty", () => {
    expect(() =>
      renderToStaticMarkup(
        <NumberInputGate title="Page Count" prompt="" onSubmit={vi.fn()} />,
      ),
    ).not.toThrow()
  })
})
