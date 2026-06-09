import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface Question {
  id: string
  type: "radio" | "checkbox"
  label: string
  required: boolean
  options: Array<{ value: string; label: string; description?: string }>
  maxSelections?: number
}

interface QuestionFormData {
  id: string
  title: string
  questions: Question[]
}

interface GateConfirmationProps {
  title: string
  prompt: string
  questionForm?: QuestionFormData | null
  onSubmit: (answers: Record<string, string | string[]>) => void
  disabled?: boolean
}

export function GateConfirmation({ title, prompt, questionForm, onSubmit, disabled }: GateConfirmationProps) {
  const { t } = useTranslation("editor")
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [feedback, setFeedback] = useState("")

  const questions = questionForm?.questions || []
  const hasReviseOption = questions.some(q =>
    q.options.some(o => o.value === "revise")
  )
  const currentDecision = Object.values(answers).flat().join("")

  const handleRadioSelect = (questionId: string, value: string) => {
    setAnswers(prev => ({ ...prev, [questionId]: value }))
  }

  const handleCheckboxToggle = (questionId: string, value: string) => {
    setAnswers(prev => {
      const current = (prev[questionId] as string[]) || []
      if (current.includes(value)) return { ...prev, [questionId]: current.filter(v => v !== value) }
      return { ...prev, [questionId]: [...current, value] }
    })
  }

  const isComplete = questions.every(q => {
    if (!q.required) return true
    const a = answers[q.id]
    if (!a) return false
    if (q.type === "checkbox") return (a as string[]).length > 0
    return true
  })

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-4 text-sm leading-relaxed">
          {prompt}
        </div>
      </div>

      {questions.length > 0 && (
        <div className="space-y-4">
          {questions.map(q => (
            <div key={q.id} className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                {q.label}
                {q.required && <span className="ml-1 text-destructive">*</span>}
              </label>
              <div className="flex flex-wrap gap-2">
                {q.options.map(opt => {
                  const isSelected =
                    q.type === "radio"
                      ? answers[q.id] === opt.value
                      : ((answers[q.id] as string[]) || []).includes(opt.value)
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        q.type === "radio"
                          ? handleRadioSelect(q.id, opt.value)
                          : handleCheckboxToggle(q.id, opt.value)
                      }
                      disabled={disabled}
                      title={opt.description}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                        isSelected
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-muted bg-background text-muted-foreground hover:border-input hover:text-foreground"
                      )}
                    >
                      {isSelected && <Check className="h-3.5 w-3.5" />}
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {hasReviseOption && currentDecision === "revise" && (
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            {t("gate_reviseLabel")}
          </label>
          <textarea
            className="mt-1 min-h-[80px] w-full resize-y rounded-md border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder={t("gate_revisePlaceholder")}
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            disabled={disabled}
          />
        </div>
      )}

      <div className="flex justify-end">
        <Button
          onClick={() => onSubmit({ ...answers, ...(feedback ? { feedback } : {}) })}
          disabled={disabled || !isComplete}
        >
          {t("gate_confirm")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
