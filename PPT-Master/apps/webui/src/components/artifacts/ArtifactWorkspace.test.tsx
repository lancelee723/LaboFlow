import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
}))

import { usePipelineStore } from "@/stores/pipeline"
import {
  ArtifactWorkspace,
  type ArtifactContent,
  type ArtifactEntry,
} from "./ArtifactWorkspace"

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

describe("ArtifactWorkspace", () => {
  it("renders available artifacts and selected text content", () => {
    const artifacts: ArtifactEntry[] = [
      {
        path: "outline.json",
        kind: "outline",
        label: "Outline",
        content_type: "text",
        size: 42,
        updated_at: "2026-05-31T10:00:00Z",
        url: "/api/projects/p1/artifacts/file?path=outline.json",
      },
      {
        path: "design_spec.md",
        kind: "design_spec",
        label: "Design Spec",
        content_type: "text",
        size: 84,
        updated_at: "2026-05-31T10:00:00Z",
        url: "/api/projects/p1/artifacts/file?path=design_spec.md",
      },
    ]

    const selectedContent: ArtifactContent = {
      path: "design_spec.md",
      kind: "design_spec",
      content_type: "text",
      text: "# Design spec\n\nBody copy",
    }

    const html = renderToStaticMarkup(
      <ArtifactWorkspace
        artifacts={artifacts}
        selectedArtifactPath="design_spec.md"
        selectedContent={selectedContent}
        isLoading={false}
        isContentLoading={false}
        onSelect={vi.fn()}
      />,
    )

    expect(html).toContain("Outline")
    expect(html).toContain("Design Spec")
    expect(html).toContain("# Design spec")
    expect(html).toContain("Body copy")
  })

  it("renders svg artifacts as file previews", () => {
    const artifacts: ArtifactEntry[] = [
      {
        path: "svg_output/page_001.svg",
        kind: "svg",
        label: "Page 001",
        content_type: "svg",
        size: 128,
        updated_at: "2026-05-31T10:00:00Z",
        url: "/api/projects/p1/artifacts/file?path=svg_output%2Fpage_001.svg",
      },
    ]

    const html = renderToStaticMarkup(
      <ArtifactWorkspace
        artifacts={artifacts}
        selectedArtifactPath="svg_output/page_001.svg"
        selectedContent={null}
        isLoading={false}
        isContentLoading={false}
        onSelect={vi.fn()}
      />,
    )

    expect(html).toContain("img")
    expect(html).toContain("page_001.svg")
  })

  it("renders WorkspaceStatus when running and no artifacts", () => {
    usePipelineStore.setState({ pipelineStep: 3, isRunning: true })
    const html = renderToStaticMarkup(
      <ArtifactWorkspace
        artifacts={[]}
        selectedArtifactPath={null}
        selectedContent={null}
        isLoading={false}
        isContentLoading={false}
        onSelect={vi.fn()}
      />,
    )
    expect(html).toContain("phase_reviewingStrategy")
  })

  it("renders static empty state when not running and no artifacts", () => {
    usePipelineStore.setState({ pipelineStep: 0, isRunning: false })
    const html = renderToStaticMarkup(
      <ArtifactWorkspace
        artifacts={[]}
        selectedArtifactPath={null}
        selectedContent={null}
        isLoading={false}
        isContentLoading={false}
        onSelect={vi.fn()}
      />,
    )
    expect(html).toContain("Artifact workspace")
    expect(html).not.toContain("phase_reviewingStrategy")
  })

  it("renders SvgProgressHeader in sidebar when generating", () => {
    usePipelineStore.setState({
      pipelineStep: 5,
      isRunning: true,
      svgProgress: { page: 3, total: 20 },
    })
    const artifacts: ArtifactEntry[] = [
      {
        path: "svg_output/01_cover.svg",
        kind: "svg",
        label: "01_cover",
        content_type: "svg",
        size: 128,
        updated_at: "2026-05-31T10:00:00Z",
        url: "/api/projects/p1/artifacts/file?path=svg_output%2F01_cover.svg",
      },
    ]
    const html = renderToStaticMarkup(
      <ArtifactWorkspace
        artifacts={artifacts}
        selectedArtifactPath="svg_output/01_cover.svg"
        selectedContent={null}
        isLoading={false}
        isContentLoading={false}
        onSelect={vi.fn()}
      />,
    )
    expect(html).toContain("Generating Slides")
    expect(html).toContain("3 / 20")
  })
})
