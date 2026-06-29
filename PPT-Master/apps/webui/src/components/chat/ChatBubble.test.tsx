import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi, beforeEach } from "vitest"

import { ChatBubble } from "./ChatBubble"
import { usePipelineStore } from "@/stores/pipeline"

describe("ChatBubble", () => {
  beforeEach(() => {
    usePipelineStore.setState({ pipelineStep: 5, isRunning: true })
  })

  it("shows animated dots while running", () => {
    const html = renderToStaticMarkup(<ChatBubble onClick={vi.fn()} />)
    expect(html).toContain("pulseDot")
    expect(html).toContain("phase_generatingSVGs")  // i18n raw key (test env has no init)
  })

  it("hides dots and shows done label when pipelineStep=7", () => {
    usePipelineStore.setState({ pipelineStep: 7, isRunning: false })
    const html = renderToStaticMarkup(<ChatBubble onClick={vi.fn()} />)
    expect(html).not.toContain("pulseDot")
    expect(html).not.toContain("breathe")
    expect(html).toContain("phase_done")
  })

  it("shows animated state while mid-pipeline even when isRunning=false (waiting at gate)", () => {
    usePipelineStore.setState({ pipelineStep: 3, isRunning: false })
    const html = renderToStaticMarkup(<ChatBubble onClick={vi.fn()} />)
    expect(html).toContain("pulseDot")
    expect(html).not.toContain("phase_done")
  })
})
