import { useState } from "react"
import { AlertTriangle, ArrowRight, RotateCcw, XCircle } from "lucide-react"
import { useTranslation } from "react-i18next"

import { usePipelineStoreSSR } from "@/stores/pipeline"

export interface InterruptedSessionOverlayProps {
  sessionId: string
  /** Discriminates rendering: interrupted=recoverable pause, aborted=user stopped, failed=crash */
  status?: "interrupted" | "aborted" | "failed"
  /** For failed status — surfaced from session.abort_reason */
  abortReason?: string | null
  onResume: () => void
  onFullReset: () => void
  onSoftReset: () => void
  /** Called for aborted/failed single-CTA "start new session" */
  onNewSession?: () => void
}

export function InterruptedSessionOverlay({
  sessionId: _sessionId,
  status = "interrupted",
  abortReason,
  onResume,
  onFullReset,
  onSoftReset,
  onNewSession,
}: InterruptedSessionOverlayProps) {
  const { t } = useTranslation("editor")
  const currentStep = usePipelineStoreSSR((s) => s.recoveryStep)
  const [mode, setMode] = useState<"main" | "reset">("main")

  // ── Aborted: user explicitly cancelled — single CTA, no resume ──────────
  if (status === "aborted") {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
        <div className="z-20 w-full max-w-sm rounded-xl border bg-white p-6 shadow-xl">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <XCircle className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-base font-semibold">{t("overlay_cancelled_title")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("overlay_cancelled_desc")}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            onClick={onNewSession ?? onFullReset}
          >
            {t("overlay_new_session")}
          </button>
        </div>
      </div>
    )
  }

  // ── Failed: pipeline crashed — show error reason, single CTA ────────────
  if (status === "failed") {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
        <div className="z-20 w-full max-w-sm rounded-xl border bg-white p-6 shadow-xl">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <XCircle className="h-5 w-5 text-destructive" />
            </div>
            <div>
              <h3 className="text-base font-semibold">{t("overlay_failed_title")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("overlay_failed_desc")}
              </p>
            </div>
          </div>
          {abortReason && (
            <div className="mb-4 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground font-mono break-all">
              {abortReason}
            </div>
          )}
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            onClick={onNewSession ?? onFullReset}
          >
            {t("overlay_new_session")}
          </button>
        </div>
      </div>
    )
  }

  // ── Interrupted (default): recoverable pause — Resume / Reset ────────────
  if (mode === "reset") {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
        <div className="z-20 w-full max-w-sm rounded-xl border bg-white p-6 shadow-xl">
          <h3 className="mb-4 text-base font-semibold">{t("overlay_choose_reset")}</h3>
          <div className="space-y-3">
            <button
              type="button"
              className="flex w-full items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors"
              onClick={onFullReset}
            >
              <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div>
                <div className="text-sm font-medium">{t("overlay_full_reset")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("overlay_full_reset_desc")}
                </div>
              </div>
            </button>
            <button
              type="button"
              className="flex w-full items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors"
              onClick={onSoftReset}
            >
              <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <div className="text-sm font-medium">{t("overlay_soft_reset")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("overlay_soft_reset_desc")}
                </div>
              </div>
            </button>
          </div>
          <button
            type="button"
            className="mt-3 text-xs text-muted-foreground hover:underline"
            onClick={() => setMode("main")}
          >
            {t("overlay_back")}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
      <div className="z-20 w-full max-w-sm rounded-xl border bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
          </div>
          <div>
            <h3 className="text-base font-semibold">{t("overlay_interrupted_title")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("overlay_interrupted_desc", { step: currentStep })}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            onClick={onResume}
          >
            {t("overlay_continue")}
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
            onClick={() => setMode("reset")}
          >
            <RotateCcw className="h-4 w-4" />
            {t("overlay_restart")}
          </button>
        </div>
      </div>
    </div>
  )
}
