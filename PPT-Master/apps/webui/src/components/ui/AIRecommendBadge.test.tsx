import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AIRecommendBadge } from "./AIRecommendBadge"

describe("AIRecommendBadge", () => {
  it("renders the badge text", () => {
    const html = renderToStaticMarkup(<AIRecommendBadge />)
    expect(html).toContain("AI recommends")
  })

  it("renders a span element with purple styling", () => {
    const html = renderToStaticMarkup(<AIRecommendBadge />)
    expect(html).toContain("text-purple-700")
    expect(html).toContain("bg-purple-50")
  })

  it("does not throw on render", () => {
    expect(() => renderToStaticMarkup(<AIRecommendBadge />)).not.toThrow()
  })
})
