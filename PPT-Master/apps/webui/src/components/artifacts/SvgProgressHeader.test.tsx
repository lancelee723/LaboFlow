import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SvgProgressHeader } from "./SvgProgressHeader"

describe("SvgProgressHeader", () => {
  it("renders progress with mid-generation stats", () => {
    const html = renderToStaticMarkup(
      <SvgProgressHeader page={8} total={20} />,
    )
    expect(html).toContain("Generating Slides")
    expect(html).toContain("8 / 20")
    expect(html).toContain("Rendering page 9")
    expect(html).toContain("12 remaining")
    expect(html).toContain("40%")
  })

  it("renders complete state at 100%", () => {
    const html = renderToStaticMarkup(
      <SvgProgressHeader page={20} total={20} />,
    )
    expect(html).toContain("20 / 20")
    expect(html).not.toContain("Rendering page")
    expect(html).not.toContain("remaining")
    expect(html).toContain("100%")
  })

  it("renders first page correctly", () => {
    const html = renderToStaticMarkup(
      <SvgProgressHeader page={1} total={20} />,
    )
    expect(html).toContain("1 / 20")
    expect(html).toContain("Rendering page 2")
    expect(html).toContain("19 remaining")
  })
})
