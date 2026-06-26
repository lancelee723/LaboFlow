import { useState, useCallback, useRef, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useParams, useNavigate } from "react-router-dom"
import { Loader2, Square, Monitor } from "lucide-react"
import { apiFetch, resumeSession } from "@/lib/api"
import { randomUUID } from "@/lib/uuid"
import { ArtifactWorkspace, type ArtifactContent, type ArtifactEntry } from "@/components/artifacts/ArtifactWorkspace"
import { ImageAcquisitionPanel } from "@/components/workspace/ImageAcquisitionPanel"
import { ProjectSetup } from "@/components/artifacts/ProjectSetup"
import { TemplateSelector } from "@/components/artifacts/TemplateSelector"
import { CanvasFormatSelector } from "@/components/artifacts/CanvasFormatSelector"
import { NumberInputGate } from "@/components/artifacts/NumberInputGate"
import { StyleModeSelector } from "@/components/artifacts/StyleModeSelector"
import { ColorSchemeEditor } from "@/components/artifacts/ColorSchemeEditor"
import { AudienceEditor } from "@/components/artifacts/AudienceEditor"
import { IconLibrarySelector } from "@/components/artifacts/IconLibrarySelector"
import { TypographyEditor } from "@/components/artifacts/TypographyEditor"
import { ImageStrategySelector } from "@/components/artifacts/ImageStrategySelector"
import { GateConfirmation } from "@/components/artifacts/GateConfirmation"
import { PreflightReview } from "@/components/artifacts/PreflightReview"
import { StepIndicator } from "@/components/artifacts/StepIndicator"
import { InterruptedSessionOverlay } from "@/components/artifacts/InterruptedSessionOverlay"
import { ChatBubble } from "@/components/chat/ChatBubble"
import { ChatDrawer } from "@/components/chat/ChatDrawer"
import { useWebSocket, type WSEvent } from "@/hooks/useWebSocket"
import { useLocale } from "@/hooks/LocaleContext"
import { usePipelineStore } from "@/stores/pipeline"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ErrorBanner } from "@/components/ui/ErrorBanner"
import { Input } from "@/components/ui/input"



function _parseSpecLockField(spec: string, section: string, field: string): string {
  const re = new RegExp(`## ${section}\\n([\\s\\S]*?)(?=\\n## |$)`, "m")
  const sec = spec.match(re)?.[1] || ""
  const match = sec.match(new RegExp(`- ${field}: (.+)`))
  return match?.[1]?.trim() || ""
}

function _parseColors(spec: string): Array<{ name: string; hex: string }> {
  const result: Array<{ name: string; hex: string }> = []
  const re = /## colors\n([\s\S]*?)(?=\n## |$)/m
  const sec = spec.match(re)?.[1]
  if (!sec) return result
  for (const line of sec.split("\n")) {
    const m = line.match(/- (\w+(?:_\w+)*):\s*(#[0-9A-Fa-f]{6})/)
    if (m) result.push({ name: m[1], hex: m[2] })
  }
  return result
}

function _parseTypography(spec: string): { font_family: string; title_family: string; body_family: string; body_size: number } {
  return {
    font_family: _parseSpecLockField(spec, "typography", "font_family"),
    title_family: _parseSpecLockField(spec, "typography", "title_family") || _parseSpecLockField(spec, "typography", "font_family"),
    body_family: _parseSpecLockField(spec, "typography", "body_family") || _parseSpecLockField(spec, "typography", "font_family"),
    body_size: parseInt(_parseSpecLockField(spec, "typography", "body") || "22"),
  }
}

interface QuestionFormData {
  id: string; title: string
  questions: Array<{ id: string; type: "radio" | "checkbox"; label: string; required: boolean; options: Array<{ value: string; label: string; description?: string }>; maxSelections?: number }>
}

interface ChatMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  agent?: string
}

interface ProjectDetails {
  id: string
  name: string
  status: string
  current_step: number
}

// Comprehensive gate-to-step map — covers all 8 strategist gates (fixes C6-1)
const GATE_TO_STEP: Record<string, number> = {
  source_processing: 1,
  template_selection: 2,
  canvas: 3,
  page_count: 3,
  audience: 3,
  style: 3,
  colors: 3,
  icons: 3,
  typography: 3,
  images_strategy: 3,
  images: 3,
  preflight: 4,
}

// Map gate names to i18n editor namespace keys for title localization.
// Falls back to the raw gate name (title-cased) when no key is found.
const GATE_TITLE_KEYS: Record<string, string> = {
  source_processing: "gate_sourceProcessing",
  template_selection: "gate_templateTitle",
  canvas: "canvas_title",
  page_count: "preflight_pageCount",
  audience: "audience_title",
  style: "style_title",
  colors: "colors_title",
  icons: "icons_title",
  typography: "typography_title",
  images: "images_title",
  preflight: "preflight_title",
  preflight_review: "preflight_title",
}

export function ProjectEditorPage() {
  useLocale() // re-renders on locale change via React context
  const { t } = useTranslation("editor")
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isNew = !id
  const scrollRef = useRef<HTMLDivElement>(null)
  // When step_7 broadcasts artifact_updated for the export, queue its path
  // here so the artifacts useEffect can promote it to the active selection
  // once the refetch lands. Without this the user stays on whichever SVG
  // they last clicked and has to manually open the Exports group.
  const pendingExportSelectRef = useRef<string | null>(null)
  // Detects the running→completed transition as a safety net when the export
  // artifact_updated WS event is dropped at the tail of step 7 (race against
  // connection teardown or session-end cleanup).
  const prevIsRunningRef = useRef(false)

  // Clear stale pipeline state when entering the editor for any project.
  // Without this, a leftover activeGate or pipelineStep from a previous
  // project's session (e.g. "canvas") leaks into the current project's view,
  // causing the wrong UI to render — e.g. CanvasFormatSelector instead of
  // the export ArtifactWorkspace when opening a completed project from
  // /projects → /projects/:id → "Edit in editor". The session-restore effect
  // below repopulates pipelineStep/sessionId from sessionStorage when needed,
  // and the WS replay re-delivers any in-flight blocking_gate event.
  // Uses getState() to avoid hoisting issues.
  useEffect(() => {
    const store = usePipelineStore.getState()
    store.resetWorkspace()
    store.setPipelineStep(0)
  }, [id])

  const [projectName, setProjectName] = useState("")
  const [chatInput, setChatInput] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [thinking, setThinking] = useState("")
  const [selectedArtifactPath, setSelectedArtifactPath] = useState<string | null>(null)
  const [gatePrompt, setGatePrompt] = useState("")
  const [gateTitle, setGateTitle] = useState("")
  const [gateName, setGateName] = useState<string | null>(null)
  const [gateForm, setGateForm] = useState<QuestionFormData | null>(null)
  const [preflightData, setPreflightData] = useState<any>(null)
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [gateRecommendation, setGateRecommendation] = useState<Record<string, unknown> | null>(null)
  // G4.11: Error UX — retry + report
  const [lastError, setLastError] = useState<string | null>(null)
  const lastUserMessageRef = useRef("")

  // Pipeline lifecycle state (canonical source — usePipelineStore)
  const isRunning = usePipelineStore((s) => s.isRunning)
  const setIsRunning = usePipelineStore((s) => s.setIsRunning)
  const pipelineStep = usePipelineStore((s) => s.pipelineStep)
  const setPipelineStep = usePipelineStore((s) => s.setPipelineStep)
  const activeGate = usePipelineStore((s) => s.activeGate)
  const setActiveGate = usePipelineStore((s) => s.setActiveGate)
  const setSvgProgress = usePipelineStore((s) => s.setSvgProgress)
  const setRecoveryStep = usePipelineStore((s) => s.setRecoveryStep)
  const setRecoveryCompleted = usePipelineStore((s) => s.setRecoveryCompleted)
  const resetWorkspace = usePipelineStore((s) => s.resetWorkspace)
  const tokenIn = usePipelineStore((s) => s.tokenIn)
  const tokenOut = usePipelineStore((s) => s.tokenOut)
  const addTokens = usePipelineStore((s) => s.addTokens)

  // Persist pipelineStep to sessionStorage so it survives navigation
  useEffect(() => {
    if (id && pipelineStep > 0) {
      try { sessionStorage.setItem(`step-${id}`, String(pipelineStep)) } catch { /* quota */ }
    }
  }, [id, pipelineStep])

  const setPipelineActive = usePipelineStore((s) => s.setActive)
  const pendingLeave = usePipelineStore((s) => s.pendingNav)
  const clearPendingLeave = usePipelineStore((s) => s.clearPendingNav)

  // Sync pipeline active state to store for Shell nav guard
  useEffect(() => {
    setPipelineActive(!!sessionId)
    return () => { setPipelineActive(false) }
  }, [sessionId, setPipelineActive])

  // Navigation guard — warn on browser tab close / refresh
  useEffect(() => {
    if (!sessionId) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [sessionId])

  const [showRecoveryOverlay, setShowRecoveryOverlay] = useState(false)
  const [recoveryStatus, setRecoveryStatus] = useState<"interrupted" | "aborted" | "failed">("interrupted")
  const [recoveryAbortReason, setRecoveryAbortReason] = useState<string | null>(null)
  const [annotationModeOverride, setAnnotationModeOverride] = useState<boolean | null>(null)

  const { data: project } = useQuery({
    queryKey: ["project", id],
    queryFn: () => apiFetch<ProjectDetails>(`/api/projects/${id}`),
    enabled: !!id,
  })

  // Sync pipelineStep from server when re-opening a project whose sessionStorage
  // was cleared (different tab, after browser restart). Without this, completed
  // projects open with pipelineStep=0 → annotationMode=false → SVG renders as
  // <img> without click handlers, and annotation mode silently fails.
  // Monotonic: only advances forward, never clobbers in-flight WS updates.
  useEffect(() => {
    if (!project) return
    if (project.current_step > usePipelineStore.getState().pipelineStep) {
      setPipelineStep(project.current_step)
    }
  }, [project?.current_step, setPipelineStep])

  const { data: artifacts = [], isLoading: isArtifactsLoading } = useQuery({
    queryKey: ["project-artifacts", id],
    queryFn: () => apiFetch<ArtifactEntry[]>(`/api/projects/${id}/artifacts`),
    enabled: !!id,
  })

  useEffect(() => {
    if (!artifacts.length) {
      setSelectedArtifactPath(null)
      return
    }

    if (pendingExportSelectRef.current) {
      const target = pendingExportSelectRef.current
      if (artifacts.some((artifact) => artifact.path === target)) {
        pendingExportSelectRef.current = null
        setSelectedArtifactPath(target)
        return
      }
    }

    if (!selectedArtifactPath) {
      // Default to the export for completed projects so re-entry lands on
      // the download view instead of outline.json/the first auxiliary file.
      if (project?.status === "completed") {
        const exportArtifact = artifacts.find((a) => a.kind === "export")
        if (exportArtifact) {
          setSelectedArtifactPath(exportArtifact.path)
          return
        }
      }
      setSelectedArtifactPath(artifacts[0].path)
      return
    }

    if (!artifacts.some((artifact) => artifact.path === selectedArtifactPath)) {
      setSelectedArtifactPath(artifacts[0].path)
    }
  }, [artifacts, selectedArtifactPath, project?.status])

  // Safety net: when the pipeline transitions from running → not running with
  // post-processing done (pipelineStep >= 6), force-queue export selection and
  // refresh artifacts. Covers the case where the artifact_updated WS event for
  // the export was lost mid-flight at the tail of step 7.
  useEffect(() => {
    const wasRunning = prevIsRunningRef.current
    prevIsRunningRef.current = isRunning
    if (!id) return
    if (wasRunning && !isRunning && pipelineStep >= 6) {
      pendingExportSelectRef.current = "exports/output.pptx"
      queryClient.invalidateQueries({ queryKey: ["project-artifacts", id] })
    }
  }, [isRunning, pipelineStep, id, queryClient])

  // Restore session on mount — survives navigation away from editor
  useEffect(() => {
    if (!id || sessionId) return
    const stored = sessionStorage.getItem(`session-${id}`)
    if (!stored) return
    const savedStep = sessionStorage.getItem(`step-${id}`)
    let cancelled = false
    apiFetch<{ status: string; current_step: number; completed_steps: number[]; abort_reason?: string | null }>(
      `/api/sessions/${stored}/status`,
    )
      .then((data) => {
        if (cancelled) return
        // Restore progress bar from the last persisted step
        if (savedStep) setPipelineStep(parseInt(savedStep, 10) || 0)
        if (data.status === "running" || data.status === "waiting_for_input") {
          setSessionId(stored)
          setIsRunning(data.status === "running")
        } else if (data.status === "interrupted") {
          setSessionId(stored)
          setRecoveryStep(data.current_step)
          setRecoveryCompleted(data.completed_steps)
          setRecoveryStatus("interrupted")
          setRecoveryAbortReason(null)
          setShowRecoveryOverlay(true)
        } else if (data.status === "aborted") {
          // Aborted: don't restore sessionId, show distinct overlay (no resume)
          setSessionId(stored)
          setRecoveryStatus("aborted")
          setRecoveryAbortReason(data.abort_reason ?? null)
          setShowRecoveryOverlay(true)
        } else if (data.status === "failed") {
          setSessionId(stored)
          setRecoveryStatus("failed")
          setRecoveryAbortReason(data.abort_reason ?? null)
          setShowRecoveryOverlay(true)
        }
      })
      .catch(() => { /* session expired or gone */ })
    return () => { cancelled = true }
  }, [id, sessionId])

  const selectedArtifact = artifacts.find((artifact) => artifact.path === selectedArtifactPath) ?? null

  const { data: selectedArtifactContent = null, isLoading: isArtifactContentLoading } = useQuery({
    queryKey: ["project-artifact-content", id, selectedArtifact?.path],
    queryFn: () => apiFetch<ArtifactContent>(`/api/projects/${id}/artifacts/content?path=${encodeURIComponent(selectedArtifact!.path)}`),
    enabled: !!id && !!selectedArtifact && selectedArtifact.content_type === "text",
  })

  const advanceStep = useCallback((gate: string) => {
    const target = GATE_TO_STEP[gate]
    if (target !== undefined && target > usePipelineStore.getState().pipelineStep) {
      setPipelineStep(target)
    }
  }, [setPipelineStep])

  const handleWSEvent = useCallback((event: WSEvent) => {
    switch (event.type) {
      case "thinking":
        setThinking((prev) => prev + (event.delta as string || ""))
        break
      case "agent_message":
        setThinking("")
        setMessages((prev) => [
          ...prev,
          {
            id: randomUUID(),
            role: "assistant",
            content: event.content as string,
            agent: event.agent as string,
          },
        ])
        break
      case "tool_call":
        setMessages((prev) => [
          ...prev,
          {
            id: randomUUID(),
            role: "system",
            content: `Running ${event.tool}...`,
            agent: event.agent as string,
          },
        ])
        break
      case "tool_result":
        if (typeof event.tokens_in === "number" || typeof event.tokens_out === "number") {
          addTokens(
            typeof event.tokens_in === "number" ? event.tokens_in : 0,
            typeof event.tokens_out === "number" ? event.tokens_out : 0,
          )
        }
        break
      case "svg_progress":
        setSvgProgress({
          page: event.page as number,
          total: event.total as number,
        })
        break
      case "step_completed": {
        if (id) {
          queryClient.invalidateQueries({ queryKey: ["project-artifacts", id] })
          queryClient.invalidateQueries({ queryKey: ["project", id] })
        }
        // Backend step (1..7) → FE pipelineStep (0..6 StepIndicator slots).
        // Step 6 (executor) finishes generation → advance to Export view.
        // Step 7 (post-processing) finishes → pipeline complete, clear isRunning
        // so annotationMode unlocks for live-preview editing.
        const backendStep = event.step as number | undefined
        if (typeof backendStep === "number") {
          if (backendStep >= 6) {
            const cur = usePipelineStore.getState().pipelineStep
            if (cur < 6) setPipelineStep(6)
          }
          if (backendStep >= 7) {
            setIsRunning(false)
          }
        }
        break
      }
      case "artifact_updated":
        if (id && (!event.project_id || event.project_id === id)) {
          queryClient.invalidateQueries({ queryKey: ["project-artifacts", id] })
          if (typeof event.path === "string") {
            queryClient.invalidateQueries({ queryKey: ["project-artifact-content", id, event.path] })
            if (event.kind === "export") {
              pendingExportSelectRef.current = event.path
            }
          }
        }
        break
      case "blocking_gate": {
        setThinking("")
        const gate = (event.gate as string) || null
        setActiveGate(gate)
        setGatePrompt(event.prompt as string || "")
        // Store the raw gate name; gateTitle is derived in render via i18n
        setGateName(gate)
        setGateTitle(
          (event.question_form as QuestionFormData | undefined)?.title ||
          gate?.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) || ""
        )
        setGateForm((event.question_form as QuestionFormData) || null)
        setPreflightData(event.preflight_data || null)
        setGateRecommendation((event.recommendation as Record<string, unknown> | null) ?? null)

        // Chat gets the prompt as a plain message — no forms embedded.
        setMessages((prev) => [
          ...prev,
          {
            id: randomUUID(),
            role: "assistant",
            content: event.prompt as string,
            agent: "strategist",
          },
        ])
        break
      }
      case "agent_error":
        setLastError(event.error as string)
        setThinking("")
        setIsRunning(false)
        setActiveGate(null)
        // B9: No sessionStorage clear here — B5/B6 ensure terminal sessions
        // have status_locked set, so the L177 mount-restore effect won't restore
        // a terminal session into active state on page reload.
        setMessages((prev) => [
          ...prev,
          {
            id: randomUUID(),
            role: "system",
            content: `Error: ${event.error}`,
          },
        ])
        break
    }
  }, [id, queryClient])

  const { isConnected } = useWebSocket({
    sessionId,
    onEvent: handleWSEvent,
    enabled: sessionId !== null,
  })

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, thinking])

  const handleTemplateSelect = useCallback(async (templateId: string | null) => {
    if (!sessionId) return
    advanceStep("template_selection")
    setActiveGate(null)
    try {
      await resumeSession(sessionId, {
        answers: { selection: templateId || "free_design" },
        answer: templateId || "free_design",
      })
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: randomUUID(), role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
      ])
    }
  }, [sessionId])

  const handleTemplateSkip = useCallback(async () => {
    if (!sessionId) return
    advanceStep("template_selection")
    setActiveGate(null)
    try {
      await resumeSession(sessionId, { answers: { selection: "free_design" }, answer: "free_design" })
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: randomUUID(), role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
      ])
    }
  }, [sessionId])

  // Extract Live Preview URL from assistant messages
  useEffect(() => {
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.content.includes("Live Preview:")) {
        const match = msg.content.match(/https?:\/\/localhost:\d+/)
        if (match) { setLivePreviewUrl(match[0]); break }
      }
    }
  }, [messages])

  useEffect(() => {
    if (!sessionId || !id) return

    let cancelled = false
    apiFetch<{ status: string; current_step: number; completed_steps: number[]; abort_reason?: string | null }>(
      `/api/sessions/${sessionId}/status`,
    )
      .then((data) => {
        if (cancelled) return
        if (data.status === "interrupted") {
          setRecoveryStep(data.current_step)
          setRecoveryCompleted(data.completed_steps)
          setRecoveryStatus("interrupted")
          setRecoveryAbortReason(null)
          setShowRecoveryOverlay(true)
        } else if (data.status === "aborted") {
          setRecoveryStatus("aborted")
          setRecoveryAbortReason(data.abort_reason ?? null)
          setShowRecoveryOverlay(true)
        } else if (data.status === "failed") {
          setRecoveryStatus("failed")
          setRecoveryAbortReason(data.abort_reason ?? null)
          setShowRecoveryOverlay(true)
        }
      })
      .catch(() => {
        /* status check failed — session may not exist, ignore */
      })

    return () => { cancelled = true }
  }, [sessionId, id])

  const handleCreateProject = async () => {
    if (!projectName.trim()) return

    const project = await apiFetch<{ id: string }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: projectName.trim() }),
    })

    navigate(`/projects/${project.id}/edit`, { replace: true })
  }

  const handleSendMessage = async () => {
    if (!chatInput.trim() || !id) return

    const userMsg = chatInput.trim()
    lastUserMessageRef.current = userMsg
    setChatInput("")
    setLastError(null)
    setMessages((prev) => [...prev, { id: randomUUID(), role: "user", content: userMsg }])
    setThinking("")

    if (sessionId) {
      try {
        await resumeSession(sessionId, { answer: userMsg })
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { id: randomUUID(), role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
        ])
        setLastError(err instanceof Error ? err.message : "Unknown")
      }
    } else {
      setMessages((prev) => [
        ...prev,
        { id: randomUUID(), role: "assistant", content: `Please start the pipeline first by clicking the Start button.` },
      ])
    }
  }

  // G4.11: Retry last message
  const handleRetry = () => {
    const lastMsg = lastUserMessageRef.current
    if (lastMsg && sessionId) {
      setChatInput(lastMsg)
      handleSendMessage()
    }
  }

  // G4.11: Report error — copy session info to clipboard
  const handleReportError = () => {
    const report = [
      `Time: ${new Date().toISOString()}`,
      `Session: ${sessionId || "none"}`,
      `Error: ${lastError || "unknown"}`,
    ].join("\n")
    navigator.clipboard.writeText(report).catch(() => {})
  }

  const handleStartFromPanel = useCallback(async (userBrief: string, llmConfigId: string | null) => {
    if (!id) return
    setPipelineStep(1)
    setSvgProgress(null)
    setAnnotationModeOverride(null)
    setIsRunning(true)
    const brief = userBrief || ""
    setMessages((prev) => [
      ...prev,
      { id: randomUUID(), role: "user", content: brief || "Start pipeline" },
    ])
    try {
      const sess = await apiFetch<{ session_id: string }>("/api/orchestrate/start", {
        method: "POST",
        body: JSON.stringify({
          project_id: id,
          source_files: [],
          user_brief: brief,
          llm_config_id: llmConfigId,
        }),
      })
      setSessionId(sess.session_id)
      try { sessionStorage.setItem(`session-${id}`, sess.session_id) } catch { /* quota exceeded */ }
    } catch (err) {
      setIsRunning(false)
      setMessages((prev) => [
        ...prev,
        { id: randomUUID(), role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
      ])
    }
  }, [id])

  const handleGateSubmit = useCallback(async (answers: Record<string, string | string[]>) => {
    if (!sessionId) return
    const gate = usePipelineStore.getState().activeGate
    if (gate) advanceStep(gate)
    setActiveGate(null)
    setGateForm(null)
    try {
      await resumeSession(sessionId, { answers, answer: answers.decision || answers.approve || "" })
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: randomUUID(), role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
      ])
    }
  }, [sessionId])

  const handlePreflightStart = useCallback(async () => {
    if (!sessionId) return
    setPipelineStep(5)
    setActiveGate(null)
    try {
      await resumeSession(sessionId, { answer: "confirmed" })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown"
      // Session already resumed (e.g. after restoring from navigation) — silent no-op
      if (msg.includes("not waiting")) return
      setMessages((prev) => [
        ...prev,
        { id: randomUUID(), role: "assistant", content: `Error: ${msg}` },
      ])
    }
  }, [sessionId])

  // Compute the displayed gate title: prefer i18n key from GATE_TITLE_KEYS,
  // fall back to the raw title from the backend (which is already English).
  const displayGateTitle = gateName && GATE_TITLE_KEYS[gateName]
    ? t(GATE_TITLE_KEYS[gateName])
    : gateTitle

  return (
    <div className="flex h-full overflow-hidden">
      {/* Artifact Workspace (left ~70%) */}
      <div className="flex flex-1 flex-col border-r min-h-0">
        <header className="flex h-12 items-center border-b px-4">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-sm">{isNew ? t("editor_newProject") : t("title")}</span>
          </div>
        </header>

        <div className="relative flex flex-1 flex-col min-h-0">
          {!isNew && sessionId && (
            <div className="flex items-center justify-between border-b px-4 py-1.5">
              <StepIndicator currentStep={pipelineStep} />
              <div className="flex items-center gap-2 shrink-0">
                {isRunning && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
                {isConnected && (
                  <span className="flex items-center gap-1 text-xs text-green-600">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    {t("connection_live")}
                  </span>
                )}
                {livePreviewUrl && (
                  <a href={livePreviewUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <Monitor className="h-3 w-3" />
                    {t("livePreview")}
                  </a>
                )}
                {(tokenIn > 0 || tokenOut > 0) && (
                  <span className="text-xs text-muted-foreground">
                    {t("tokens_display", {
                      ns: "common",
                      in: tokenIn >= 1000 ? `${(tokenIn / 1000).toFixed(1)}k` : tokenIn,
                      out: tokenOut >= 1000 ? `${(tokenOut / 1000).toFixed(1)}k` : tokenOut,
                    })}
                  </span>
                )}
                {isRunning && (
                  <Button size="sm" variant="ghost"
                    className="h-7 text-xs text-destructive hover:bg-destructive/10"
                    onClick={async () => {
                      if (!confirm(t("stopConfirm"))) return
                      try { await apiFetch(`/api/sessions/${sessionId}/stop`, { method: "POST" }) }
                      catch (err) { alert(err instanceof Error ? err.message : "Stop failed") }
                      resetWorkspace(); setThinking("")
                    }}>
                    <Square className="mr-1 h-3 w-3 fill-current" /> {t("stopButton")}
                  </Button>
                )}
              </div>
            </div>
          )}
          {(() => {
            const showProjectSetup = !!id && project?.status === "draft" && !sessionId
            // For completed projects, always show the export workspace —
            // even if activeGate is non-null from stale Zustand state or a
            // WS replay of historical blocking_gate events. Gate UI is only
            // meaningful while the pipeline is actively waiting for input.
            const isProjectCompleted = project?.status === "completed"
            const showArtifactWorkspace = !isNew && !showProjectSetup && (isProjectCompleted || activeGate === null)

            if (showArtifactWorkspace) {
              const annotationMode = annotationModeOverride ?? (pipelineStep >= 5 && !isRunning)
              return (
                <div className="flex flex-1 flex-col min-h-0">
                  {pipelineStep >= 4 && id && (
                    <div className="border-b overflow-y-auto max-h-[40%]">
                      <ImageAcquisitionPanel projectId={id} sessionId={sessionId} />
                    </div>
                  )}
                  <div className="flex flex-1 min-h-0">
                    <ArtifactWorkspace
                      artifacts={artifacts}
                      selectedArtifactPath={selectedArtifactPath}
                      selectedContent={selectedArtifactContent}
                      isLoading={isArtifactsLoading}
                      isContentLoading={isArtifactContentLoading}
                      onSelect={(path) => {
                        setSelectedArtifactPath(path)
                        if (annotationModeOverride === false) {
                          setAnnotationModeOverride(null)
                        }
                      }}
                      annotationMode={annotationMode}
                      onExitAnnotation={() => setAnnotationModeOverride(false)}
                      projectId={id}
                    />
                  </div>
                </div>
              )
            }

            return (
              <div className="flex flex-1 flex-col items-center min-h-0 overflow-y-auto">
                {isNew ? (
                  <Card className="mx-4 w-full max-w-md p-6">
                    <h2 className="mb-4 text-lg font-semibold">{t("projectCreate_title")}</h2>
                    <div className="space-y-4">
                      <div>
                        <label className="text-sm font-medium">{t("projectSetup_nameLabel")}</label>
                        <Input
                          placeholder={t("projectSetup_namePlaceholder")}
                          value={projectName}
                          onChange={(e) => setProjectName(e.target.value)}
                        />
                      </div>
                      <Button className="w-full" onClick={handleCreateProject} disabled={!projectName.trim()}>
                        {t("startPipeline")}
                      </Button>
                    </div>
                    <div className="mt-6 text-center text-xs text-muted-foreground">
                      {t("editor_ai_journey", { ns: "common" })}
                    </div>
                  </Card>
                ) : activeGate === "template_selection" ? (
                  <TemplateSelector
                    onSubmit={handleTemplateSelect}
                    onSkip={handleTemplateSkip}
                    disabled={!sessionId}
                  />
                ) : activeGate === "canvas" ? (
                  <CanvasFormatSelector
                    prompt={gatePrompt}
                    recommendation={gateRecommendation}
                    onSubmit={async (formatId) => {
                      setActiveGate(null)
                      advanceStep("canvas")
                      try {
                        await resumeSession(sessionId, { answers: { decision: "approve", selected_format: formatId }, answer: formatId })
                      } catch (err) {
                        setMessages((prev) => [
                          ...prev,
                          { id: randomUUID(), role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
                        ])
                      }
                    }}
                    disabled={!sessionId}
                  />
                ) : activeGate === "page_count" ? (
                  <NumberInputGate
                    title={displayGateTitle}
                    prompt={gatePrompt}
                    recommendation={gateRecommendation}
                    min={3}
                    max={100}
                    unit="pages"
                    onSubmit={async (result) => {
                      setActiveGate(null)
                      const answers =
                        result.mode === "explicit"
                          ? { decision: "approve", page_count_mode: "explicit", page_count: result.value }
                          : { decision: "approve", page_count_mode: "ai_decide" }
                      const answer = result.mode === "explicit" ? String(result.value) : "ai_decide"
                      advanceStep("page_count")
                      try {
                        await resumeSession(sessionId, { answers, answer })
                      } catch (err) {
                        setMessages((prev) => [
                          ...prev,
                          {
                            id: randomUUID(),
                            role: "assistant",
                            content: `Error: ${err instanceof Error ? err.message : "Unknown"}`,
                          },
                        ])
                      }
                    }}
                    disabled={!sessionId}
                  />
                ) : activeGate === "audience" ? (
                  <AudienceEditor
                    prompt={gatePrompt}
                    recommendation={gateRecommendation}
                    onSubmit={async (data) => {
                      setActiveGate(null)
                      const summary = [
                        data.audiences.length > 0 ? `Audience: ${data.audiences.join(", ")}` : "",
                        data.occasion ? `Occasion: ${data.occasion}` : "",
                        data.coreMessage ? `Core message: ${data.coreMessage}` : "",
                      ].filter(Boolean).join("; ")
                      advanceStep("audience")
                      try {
                        await resumeSession(sessionId, { answers: { decision: "approve" }, answer: summary || "No changes" })
                      } catch (err) {
                        setMessages((prev) => [
                          ...prev,
                          { id: randomUUID(), role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
                        ])
                      }
                    }}
                    disabled={!sessionId}
                  />
                ) : activeGate === "style" ? (
                  <StyleModeSelector
                    prompt={gatePrompt}
                    recommendation={gateRecommendation}
                    onSubmit={async (data) => {
                      setActiveGate(null)
                      advanceStep("style")
                      try {
                        await resumeSession(sessionId, { answers: { decision: "approve" }, answer: `Mode ${data.mode}: ${data.descriptor || "no descriptor"}` })
                      } catch (err) {
                        setMessages((prev) => [
                          ...prev,
                          { id: randomUUID(), role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
                        ])
                      }
                    }}
                    disabled={!sessionId}
                  />
                ) : activeGate === "colors" ? (
                  <ColorSchemeEditor
                    prompt={gatePrompt}
                    recommendation={gateRecommendation}
                    onSubmit={async (colors) => {
                      setActiveGate(null)
                      const summary = colors.map(c => `${c.role}: ${c.hex}`).join(", ")
                      advanceStep("colors")
                      try {
                        await resumeSession(sessionId, { answers: { decision: "approve" }, answer: summary })
                      } catch (err) {
                        setMessages((prev) => [
                          ...prev,
                          { id: randomUUID(), role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
                        ])
                      }
                    }}
                    disabled={!sessionId}
                  />
                ) : activeGate === "icons" ? (
                  <IconLibrarySelector
                    prompt={gatePrompt}
                    recommendation={gateRecommendation}
                    onSubmit={async (data) => {
                      setActiveGate(null)
                      const sw = data.strokeWidth ? ` stroke=${data.strokeWidth}px` : ""
                      const summary = `Library: ${data.library}${sw} | Inventory: ${data.inventory || "use common icons"}`
                      advanceStep("icons")
                      try {
                        await resumeSession(sessionId, { answers: { decision: "approve" }, answer: summary })
                      } catch (err) {
                        setMessages((prev) => [
                          ...prev,
                          { id: randomUUID(), role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
                        ])
                      }
                    }}
                    disabled={!sessionId}
                  />
                ) : activeGate === "typography" ? (
                  <TypographyEditor
                    prompt={gatePrompt}
                    recommendation={gateRecommendation}
                    onSubmit={async (data) => {
                      setActiveGate(null)
                      const summary = [
                        `Title: ${data.titleFamily}`, `Body: ${data.bodyFamily} (${data.bodySize}px)`,
                        `Code: ${data.codeFamily}`, `Formula: ${data.formulaPolicy}`,
                      ].join(" | ")
                      advanceStep("typography")
                      try {
                        await resumeSession(sessionId, { answers: { decision: "approve" }, answer: summary })
                      } catch (err) {
                        setMessages((prev) => [
                          ...prev,
                          { id: randomUUID(), role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
                        ])
                      }
                    }}
                    disabled={!sessionId}
                  />
                ) : activeGate === "images" ? (
                  <ImageStrategySelector
                    prompt={gatePrompt}
                    recommendation={gateRecommendation}
                    onSubmit={async (data) => {
                      setActiveGate(null)
                      const summary = `Default: ${data.defaultStrategy}${data.notes ? ` | Notes: ${data.notes}` : ""}`
                      advanceStep("images")
                      try {
                        await resumeSession(sessionId, { answers: { decision: "approve" }, answer: summary })
                      } catch (err) {
                        setMessages((prev) => [
                          ...prev,
                          { id: randomUUID(), role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
                        ])
                      }
                    }}
                    disabled={!sessionId}
                  />
                ) : activeGate === "preflight_review" ? (
                  <PreflightReview
                    projectBrief={preflightData?.user_brief || ""}
                    templateId={preflightData?.template_name || null}
                    canvasFormat={preflightData?.canvas_format || "ppt169"}
                    pageCount={preflightData?.page_count > 0 ? preflightData.page_count : undefined}
                    pageCountReasoning={preflightData?.page_count_reasoning}
                    pageCountMode={preflightData?.page_count_mode}
                    colors={_parseColors(preflightData?.spec_lock || "")}
                    typography={_parseTypography(preflightData?.spec_lock || "")}
                    iconLibrary={_parseSpecLockField(preflightData?.spec_lock || "", "icons", "library")}
                    imageStrategy={preflightData?.spec_lock || ""}
                    pages={preflightData?.pages || []}
                    onStart={handlePreflightStart}
                    onPageCountChange={async (newCount) => {
                      if (!sessionId) return
                      try {
                        await resumeSession(sessionId, {
                          answers: { decision: "re_finalize" },
                          page_count_change: newCount,
                        })
                      } catch (err) {
                        setMessages((prev) => [
                          ...prev,
                          {
                            id: randomUUID(),
                            role: "assistant",
                            content: `Error: ${err instanceof Error ? err.message : "Unknown"}`,
                          },
                        ])
                      }
                    }}
                    disabled={!sessionId}
                  />
                ) : activeGate ? (
                  <GateConfirmation
                    title={displayGateTitle}
                    prompt={gatePrompt}
                    questionForm={gateForm}
                    onSubmit={handleGateSubmit}
                    disabled={!sessionId}
                  />
                ) : id && project?.status === "draft" && !sessionId ? (
                  <ProjectSetup projectId={id} onSubmit={handleStartFromPanel} isStarting={isRunning} />
                ) : null}
              </div>
            )
          })()}
          {showRecoveryOverlay && sessionId && (
            <InterruptedSessionOverlay
              sessionId={sessionId}
              status={recoveryStatus}
              abortReason={recoveryAbortReason}
              onResume={async () => {
                setShowRecoveryOverlay(false)
                setIsRunning(true)
                try {
                  await resumeSession(sessionId, { answer: "resume" })
                } catch (err) {
                  setIsRunning(false)
                  setShowRecoveryOverlay(true)
                  setMessages((prev) => [
                    ...prev,
                    { id: randomUUID(), role: "system",
                      content: `Resume failed: ${err instanceof Error ? err.message : "Unknown"}` },
                  ])
                }
              }}
              onFullReset={async () => {
                setShowRecoveryOverlay(false)
                try {
                  await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" })
                } catch { /* session may already be gone */ }
                setSessionId(null)
                resetWorkspace(); setMessages([])
              }}
              onSoftReset={async () => {
                setShowRecoveryOverlay(false)
                try {
                  await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" })
                } catch { /* session may already be gone */ }
                setSessionId(null)
                setIsRunning(true)
                try {
                  const sess = await apiFetch<{ session_id: string }>("/api/orchestrate/start", {
                    method: "POST",
                    body: JSON.stringify({ project_id: id, source_files: [], user_brief: "" }),
                  })
                  setSessionId(sess.session_id)
                } catch (err) {
                  setIsRunning(false)
                  setMessages((prev) => [
                    ...prev,
                    { id: randomUUID(), role: "system",
                      content: `Restart failed: ${err instanceof Error ? err.message : "Unknown"}` },
                  ])
                }
              }}
              onNewSession={() => {
                // For aborted/failed: clear stored session so mount-restore skips it
                setShowRecoveryOverlay(false)
                if (id) {
                  try { sessionStorage.removeItem(`session-${id}`) } catch { /* quota */ }
                  try { sessionStorage.removeItem(`step-${id}`) } catch { /* quota */ }
                  try { sessionStorage.removeItem(`ws-cursor-${sessionId}`) } catch { /* quota */ }
                }
                setSessionId(null)
                resetWorkspace()
                setMessages([])
              }}
            />
          )}
        </div>
      </div>

      {/* G4.11: Error banner with retry + report */}
      {lastError && (
        <div className="fixed bottom-24 right-6 z-25 w-[340px]">
          <ErrorBanner
            error={lastError}
            onRetry={handleRetry}
            onReport={handleReportError}
          />
        </div>
      )}

      {/* Floating chat bubble / drawer — visible while pipeline is running */}
      {isRunning && sessionId && (
        chatOpen ? (
          <ChatDrawer
            messages={messages}
            thinking={thinking}
            chatInput={chatInput}
            setChatInput={setChatInput}
            onSend={handleSendMessage}
            scrollRef={scrollRef}
            sessionId={sessionId}
            onClose={() => setChatOpen(false)}
          />
        ) : (
          <ChatBubble onClick={() => setChatOpen(true)} />
        )
      )}

      {/* Navigation guard modal — shown when Shell triggers leave via store */}
      {pendingLeave !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm bg-black/30">
          <div className="w-full max-w-sm rounded-xl border bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold">{t("navGuard_title")}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("navGuard_desc")}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={clearPendingLeave}>
                {t("navGuard_stay")}
              </Button>
              <Button onClick={() => { const fn = pendingLeave; clearPendingLeave(); fn() }}>
                {t("navGuard_leave")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
