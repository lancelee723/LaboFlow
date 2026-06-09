import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

// Mock react-i18next — returns keys as-is so tests can check i18n key names
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
}))

import { WorkspaceStatus } from "./WorkspaceStatus"

describe("WorkspaceStatus", () => {
  it("renders step 3 strategy status", () => {
    const html = renderToStaticMarkup(
      <WorkspaceStatus pipelineStep={3} isRunning={true} />,
    )
    expect(html).toContain("phase_reviewingStrategy")
  })

  it("renders step 5 generate status", () => {
    const html = renderToStaticMarkup(
      <WorkspaceStatus pipelineStep={5} isRunning={true} />,
    )
    expect(html).toContain("phase_generatingSVGs")
  })

  it("renders step 6 export status", () => {
    const html = renderToStaticMarkup(
      <WorkspaceStatus pipelineStep={6} isRunning={true} />,
    )
    expect(html).toContain("phase_assemblingPPTX")
  })

  it("renders step 1 source processing status", () => {
    const html = renderToStaticMarkup(
      <WorkspaceStatus pipelineStep={1} isRunning={true} />,
    )
    expect(html).toContain("phase_sourceProcessing")
  })

  it("includes animation style element", () => {
    const html = renderToStaticMarkup(
      <WorkspaceStatus pipelineStep={3} isRunning={true} />,
    )
    expect(html).toContain("@keyframes breathe")
    expect(html).toContain("@keyframes dotStagger")
  })
})
