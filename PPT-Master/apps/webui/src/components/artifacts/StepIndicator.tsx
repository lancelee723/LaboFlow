import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

const STEP_KEY_MAP: Record<number, string> = {
  0: "stepSource",
  1: "stepInit",
  2: "stepTemplate",
  3: "stepStrategy",
  4: "stepReview",
  5: "stepGenerate",
  6: "stepExport",
}

interface StepIndicatorProps {
  currentStep: number
  className?: string
}

export function StepIndicator({ currentStep, className }: StepIndicatorProps) {
  const { t } = useTranslation("editor")

  return (
    <div className={cn("flex items-center", className)}>
      {Array.from({ length: 7 }, (_, i) => {
        const isCompleted = i < currentStep
        const isCurrent = i === currentStep
        const label = t(STEP_KEY_MAP[i])

        return (
          <div key={i} className="flex items-center">
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1 text-[11px] font-medium leading-5 transition-colors select-none",
                isCurrent && "bg-foreground text-primary-foreground",
                isCompleted && "bg-muted text-muted-foreground",
                !isCompleted && !isCurrent && "bg-white text-muted-foreground border",
              )}
            >
              <span className={cn(
                "flex h-4 w-4 items-center justify-center rounded-full text-[10px]",
                isCurrent && "bg-primary-foreground/20",
                isCompleted && "bg-muted-foreground/15",
                !isCompleted && !isCurrent && "bg-muted",
              )}>
                {isCompleted ? "✓" : i + 1}
              </span>
              {label}
            </div>
            {i < 6 && (
              <svg width="10" height="24" viewBox="0 0 10 24" className="mx-0.5 shrink-0">
                <polygon points="2,4 8,12 2,20" fill="#d1d5db" />
              </svg>
            )}
          </div>
        )
      })}
    </div>
  )
}
