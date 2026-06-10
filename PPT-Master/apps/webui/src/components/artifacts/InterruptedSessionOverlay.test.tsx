import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { usePipelineStore } from "@/stores/pipeline"
import { InterruptedSessionOverlay } from "./InterruptedSessionOverlay"

beforeEach(() => {
  usePipelineStore.setState({
    isRunning: false,
    pipelineStep: 0,
    activeGate: null,
    svgProgress: null,
    recoveryStep: 0,
    recoveryCompleted: [],
  })
})

describe("InterruptedSessionOverlay", () => {
  it("renders the main dialog with Continue and Restart buttons", () => {
    usePipelineStore.setState({ recoveryStep: 4, recoveryCompleted: [1, 2, 3, 4] })
    const html = renderToStaticMarkup(
      <InterruptedSessionOverlay
        sessionId="sess-1"
        onResume={vi.fn()}
        onFullReset={vi.fn()}
        onSoftReset={vi.fn()}
      />,
    )
    expect(html).toContain("Continue")
    expect(html).toContain("Restart")
    // "Step 4" may appear as "Step 4 / 7" in static markup
    expect(html).toMatch(/Step\s*4/)
  })

  it("does NOT render the reset options dialog initially", () => {
    usePipelineStore.setState({ recoveryStep: 3, recoveryCompleted: [1, 2, 3] })
    const html = renderToStaticMarkup(
      <InterruptedSessionOverlay
        sessionId="sess-1"
        onResume={vi.fn()}
        onFullReset={vi.fn()}
        onSoftReset={vi.fn()}
      />,
    )
    expect(html).not.toContain("Full Reset")
    expect(html).not.toContain("Soft Reset")
  })

  it("renders the overlay with semi-transparent background", () => {
    usePipelineStore.setState({ recoveryStep: 2, recoveryCompleted: [1, 2] })
    const html = renderToStaticMarkup(
      <InterruptedSessionOverlay
        sessionId="sess-1"
        onResume={vi.fn()}
        onFullReset={vi.fn()}
        onSoftReset={vi.fn()}
      />,
    )
    expect(html).toContain("bg-black/40")
  })

  it("shows task interrupted heading", () => {
    usePipelineStore.setState({ recoveryStep: 5, recoveryCompleted: [1, 2, 3, 4, 5] })
    const html = renderToStaticMarkup(
      <InterruptedSessionOverlay
        sessionId="sess-1"
        onResume={vi.fn()}
        onFullReset={vi.fn()}
        onSoftReset={vi.fn()}
      />,
    )
    expect(html).toContain("interrupted")
  })
})
