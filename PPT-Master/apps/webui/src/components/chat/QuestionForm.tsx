import { useState } from "react"
import { Check, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface QuestionOption {
  value: string
  label: string
  description?: string
}

interface Question {
  id: string
  type: "radio" | "checkbox"
  label: string
  required: boolean
  options: QuestionOption[]
  maxSelections?: number
}

interface QuestionFormData {
  id: string
  title: string
  questions: Question[]
}

interface QuestionFormProps {
  form: QuestionFormData
  onSubmit: (answers: Record<string, string | string[]>) => void
  onDismiss?: () => void
  locked?: boolean
  initialAnswers?: Record<string, string | string[]>
}

export function QuestionForm({ form, onSubmit, onDismiss, locked = false, initialAnswers }: QuestionFormProps) {
  const { t } = useTranslation("editor")
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(initialAnswers || {})
  const [submitted, setSubmitted] = useState(false)

  // Once the user submits, the form should look and behave exactly like a parent-locked one:
  // dimmed chips, Submit replaced by the "Submitted: …" summary, no duplicate POSTs.
  const isLocked = locked || submitted

  const handleRadioSelect = (questionId: string, value: string) => {
    if (isLocked) return
    setAnswers((prev) => ({ ...prev, [questionId]: value }))
  }

  const handleCheckboxToggle = (questionId: string, value: string, maxSelections?: number) => {
    if (isLocked) return
    setAnswers((prev) => {
      const current = (prev[questionId] as string[]) || []
      if (current.includes(value)) {
        return { ...prev, [questionId]: current.filter((v) => v !== value) }
      }
      if (maxSelections && current.length >= maxSelections) {
        return prev
      }
      return { ...prev, [questionId]: [...current, value] }
    })
  }

  const isComplete = form.questions.every((q) => {
    if (!q.required) return true
    const answer = answers[q.id]
    if (!answer) return false
    if (q.type === "checkbox") return (answer as string[]).length > 0
    return true
  })

  const handleSubmit = () => {
    if (isLocked || !isComplete) return
    setSubmitted(true)
    onSubmit(answers)
  }

  return (
    <div className={cn("rounded-lg border bg-card p-4", isLocked && "opacity-60")}>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold">{form.title}</h4>
        {onDismiss && !isLocked && (
          <button onClick={onDismiss} className="rounded p-1 hover:bg-muted" title="Dismiss">
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      <div className="space-y-4">
        {form.questions.map((question) => (
          <div key={question.id} className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {question.label}
              {question.required && <span className="ml-1 text-destructive">*</span>}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option) => {
                const isSelected =
                  question.type === "radio"
                    ? answers[question.id] === option.value
                    : ((answers[question.id] as string[]) || []).includes(option.value)

                return (
                  <button
                    key={option.value}
                    onClick={() =>
                      question.type === "radio"
                        ? handleRadioSelect(question.id, option.value)
                        : handleCheckboxToggle(question.id, option.value, question.maxSelections)
                    }
                    disabled={isLocked}
                    title={option.description}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                      isSelected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted bg-background text-muted-foreground hover:border-input hover:text-foreground",
                      isLocked && "cursor-default",
                      !isLocked && "cursor-pointer"
                    )}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {!isLocked && (
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={handleSubmit} disabled={!isComplete}>
            {t("gate_confirm")}
          </Button>
        </div>
      )}

      {isLocked && (
        <div className="mt-3 text-xs text-muted-foreground">
          {t("question_form_submitted", {
            value: Object.values(answers).flat().join(", ") || t("question_form_no_selection")
          })}
        </div>
      )}
    </div>
  )
}
