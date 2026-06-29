import { useTranslation } from "react-i18next"
import { FileSearch, FolderOpen, CheckCircle, ClipboardCheck, Palette, Package, MessageCircle, LucideIcon } from "lucide-react"
import { usePipelineStoreSSR } from "@/stores/pipeline"

interface PhaseInfo {
  icon: LucideIcon
  labelKey: string
  color: string
}

const PHASE_CONFIG: Record<number, PhaseInfo> = {
  1: { icon: FileSearch,     labelKey: "phase_sourceProcessing", color: "#6366f1" },
  2: { icon: FolderOpen,     labelKey: "phase_initializing",     color: "#6366f1" },
  3: { icon: CheckCircle,    labelKey: "phase_reviewingStrategy", color: "#8b5cf6" },
  4: { icon: ClipboardCheck, labelKey: "phase_reviewingStrategy", color: "#8b5cf6" },
  5: { icon: Palette,        labelKey: "phase_generatingSVGs",    color: "#a855f7" },
  6: { icon: Package,        labelKey: "phase_assemblingPPTX",    color: "#7c3aed" },
  7: { icon: MessageCircle,  labelKey: "phase_done",              color: "#94a3b8" },
}

const DEFAULT_PHASE = PHASE_CONFIG[3]

interface AnimatedDotsProps {
  color: string
}

function AnimatedDots({ color }: AnimatedDotsProps) {
  return (
    <span className="flex items-center gap-[3px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor: color,
            opacity: 0.6,
            animation: `pulseDot 1.4s ease-in-out infinite`,
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes pulseDot {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
          40% { opacity: 1; transform: scale(1); }
        }
        @keyframes breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.08); }
        }
      `}</style>
    </span>
  )
}

interface ChatBubbleProps {
  onClick: () => void
}

export function ChatBubble({ onClick }: ChatBubbleProps) {
  const { t } = useTranslation("editor")
  const step = usePipelineStoreSSR((s) => s.pipelineStep)
  const phase = PHASE_CONFIG[step] ?? DEFAULT_PHASE
  const Icon = phase.icon
  // Only the explicit completion sentinel (set by the pipeline_completed WS handler)
  // counts as done. This avoids false-positive done renders when isRunning is false
  // mid-pipeline (e.g. session was restored at a waiting_for_input gate).
  const done = step >= 7

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("openChat")}
      className="fixed bottom-20 right-6 z-20 flex h-12 items-center gap-2.5 rounded-full border border-[#e5e5e5] bg-white px-4 shadow-[0_4px_24px_rgba(0,0,0,0.10)] transition-transform hover:-translate-y-px hover:shadow-[0_6px_28px_rgba(0,0,0,0.14)] focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
    >
      {/* Phase icon circle */}
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{
          backgroundColor: `${phase.color}18`,
          color: phase.color,
          animation: done ? undefined : "breathe 2s ease-in-out infinite",
        }}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      {/* Label */}
      <span className="max-w-[140px] truncate text-sm font-medium text-foreground">
        {t(phase.labelKey)}
      </span>

      {/* Animated dots */}
      {!done && <AnimatedDots color={phase.color} />}
    </button>
  )
}
