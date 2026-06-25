import { useTranslation } from "react-i18next"
import {
  CheckCircle,
  ClipboardCheck,
  FileSearch,
  FolderOpen,
  Package,
  Palette,
  type LucideIcon,
} from "lucide-react"

interface WorkspaceStatusProps {
  pipelineStep: number
  isRunning: boolean
}

interface PhaseConfig {
  icon: LucideIcon
  labelKey: string
  descKey: string
  accentColor: string
}

const PHASE_CONFIG: Record<number, PhaseConfig> = {
  1: {
    icon: FileSearch,
    labelKey: "phase_sourceProcessing",
    descKey: "phase_sourceProcessingDesc",
    accentColor: "#f59e0b",
  },
  2: {
    icon: FolderOpen,
    labelKey: "phase_initializing",
    descKey: "phase_initializingDesc",
    accentColor: "#3b82f6",
  },
  3: {
    icon: CheckCircle,
    labelKey: "phase_reviewingStrategy",
    descKey: "phase_reviewingStrategyDesc",
    accentColor: "#6366f1",
  },
  4: {
    icon: ClipboardCheck,
    labelKey: "phase_preparingPreflight",
    descKey: "phase_preparingPreflightDesc",
    accentColor: "#f59e0b",
  },
  5: {
    icon: Palette,
    labelKey: "phase_generatingSVGs",
    descKey: "phase_generatingSVGsDesc",
    accentColor: "#10b981",
  },
  6: {
    icon: Package,
    labelKey: "phase_assemblingPPTX",
    descKey: "phase_assemblingPPTXDesc",
    accentColor: "#8b5cf6",
  },
}

const keyframesStyle = `
@keyframes breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}
@keyframes glowPulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); }
  50% { box-shadow: 0 0 24px 0 var(--accent-glow); }
}
@keyframes shimmer {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
@keyframes dotStagger {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
`

export function WorkspaceStatus({ pipelineStep }: WorkspaceStatusProps) {
  const { t } = useTranslation("editor")
  const config = PHASE_CONFIG[pipelineStep] ?? PHASE_CONFIG[3]
  const Icon = config.icon

  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center gap-5 px-6 text-center min-h-0">
      <style>{keyframesStyle}</style>
      <div
        className="flex flex-col items-center gap-5 rounded-2xl px-10 py-14"
        style={{
          background: `linear-gradient(135deg, ${config.accentColor}08 0%, ${config.accentColor}10 50%, ${config.accentColor}06 100%)`,
          backgroundSize: "200% 200%",
          animation: "shimmer 4s ease infinite",
        }}
      >
        <div
          className="flex h-[72px] w-[72px] items-center justify-center rounded-full"
          style={{
            background: `${config.accentColor}20`,
            animation: "breathe 2s ease-in-out infinite, glowPulse 2s ease-in-out infinite",
            ["--accent-glow" as string]: `${config.accentColor}30`,
          }}
        >
          <Icon
            className="h-8 w-8"
            style={{ color: config.accentColor }}
            strokeWidth={1.5}
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-[17px] font-bold text-foreground">
            {t(config.labelKey)}
          </p>
          <p className="text-[13px] text-muted-foreground max-w-[360px] leading-relaxed">
            {t(config.descKey)}
          </p>
        </div>

        <div className="flex gap-2.5">
          <div
            className="h-2 w-2 rounded-full"
            style={{
              background: config.accentColor,
              animation: "dotStagger 1.5s ease-in-out infinite",
              animationDelay: "0s",
            }}
          />
          <div
            className="h-2 w-2 rounded-full"
            style={{
              background: config.accentColor,
              animation: "dotStagger 1.5s ease-in-out infinite",
              animationDelay: "0.2s",
            }}
          />
          <div
            className="h-2 w-2 rounded-full"
            style={{
              background: config.accentColor,
              animation: "dotStagger 1.5s ease-in-out infinite",
              animationDelay: "0.4s",
            }}
          />
        </div>
      </div>
    </div>
  )
}
