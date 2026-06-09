import { useState, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Upload, FileText, CheckCircle, Loader2, ArrowRight } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useLocale } from "@/hooks/LocaleContext"
import { Step2ConfirmFields, ConfirmedFields, ExtractedFields } from "@/components/templates/Step2ConfirmFields"
import { TemplateKind } from "@/components/templates/KindSelector"

type WizardStep = "upload" | "confirm" | "generate" | "done"

interface UploadResponse {
  upload_id: string
  filename: string
  status: string
  message: string
  error?: string
  parse_result?: {
    manifest: Record<string, unknown>
    svg_paths: string[]
    asset_paths: string[]
    temp_dir: string
  }
}

interface GenerateResponse {
  status: string
  template_id: string
  kind: string
  name: string
  page_count: number
  svg_pages: number
  design_spec_preview: string
  qc_warnings: number
  qc_errors: number
  register_ok: boolean
}

export function TemplateWizardPage() {
  useLocale() // re-renders on locale change via React context
  const { t } = useTranslation("common")
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<WizardStep>("upload")
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadData, setUploadData] = useState<UploadResponse | null>(null)
  const [extractedFields, setExtractedFields] = useState<ExtractedFields>({})
  const [autoDetectedKind, setAutoDetectedKind] = useState<TemplateKind | null>(null)
  const [generateResult, setGenerateResult] = useState<GenerateResponse | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const STEP_LABELS = [
    { key: "upload", label: t("wizard.step_upload") },
    { key: "confirm", label: t("wizard.step_confirm") },
    { key: "generate", label: t("wizard.step_generate") },
    { key: "done", label: t("wizard.step_done") },
  ] as const

  const currentStepIdx = STEP_LABELS.findIndex((s) => s.key === step)

  // Step 1: Upload + Analyze
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !file.name.endsWith(".pptx")) {
      setUploadError(t("wizard.pptx_only_error"))
      return
    }
    setUploadFile(file)
    setUploadError(null)
  }, [t])

  const handleUpload = useCallback(async () => {
    if (!uploadFile) return
    setIsAnalyzing(true)
    setUploadError(null)

    try {
      const formData = new FormData()
      formData.append("file", uploadFile)
      const res = await fetch("/api/templates/upload", {
        method: "POST",
        credentials: "include",
        body: formData,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || "Upload failed")

      setUploadData(data)

      if (data.status === "ready" && data.parse_result?.manifest) {
        // Extract fields and auto-detect kind
        const extractRes = await apiFetch<{ fields: ExtractedFields; auto_detected_kind: string }>(
          `/api/templates/uploads/${data.upload_id}/extract-fields?kind_hint=${data.parse_result.manifest.slideSize ? "auto" : "layout"}`
        )
        setExtractedFields(extractRes.fields || {})
        setAutoDetectedKind((extractRes.auto_detected_kind || "deck") as TemplateKind)
        setStep("confirm")
      } else if (data.status === "import_failed") {
        setUploadError(data.error || "PPTX analysis failed")
      } else {
        // No manifest — still let user proceed to Step 2
        setExtractedFields({})
        setAutoDetectedKind(null)
        setStep("confirm")
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setIsAnalyzing(false)
    }
  }, [uploadFile, t])

  // Step 2 -> Step 3: Confirm & Generate
  const handleConfirm = useCallback(async (fields: ConfirmedFields) => {
    if (!uploadData?.upload_id) return
    setIsGenerating(true)
    setStep("generate")
    setGenerateError(null)

    try {
      const res = await apiFetch<GenerateResponse>(
        `/api/templates/uploads/${uploadData.upload_id}/generate`,
        { method: "POST", body: JSON.stringify(fields) }
      )
      setGenerateResult(res)
      queryClient.invalidateQueries({ queryKey: ["templates"] })
      setStep("done")
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Generation failed")
      setStep("confirm") // go back to confirm so user can retry
    } finally {
      setIsGenerating(false)
    }
  }, [uploadData, queryClient])

  // Skip upload -> go directly to Step 2 with empty fields
  const handleSkipUpload = useCallback(() => {
    setExtractedFields({})
    setAutoDetectedKind(null)
    setStep("confirm")
  }, [])

  // Reset for new template
  const handleCreateAnother = useCallback(() => {
    setStep("upload")
    setUploadFile(null)
    setUploadData(null)
    setExtractedFields({})
    setAutoDetectedKind(null)
    setGenerateResult(null)
    setUploadError(null)
    setGenerateError(null)
  }, [])

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-2 text-2xl font-bold">{t("wizard.title")}</h1>
      <p className="mb-8 text-sm text-muted-foreground">{t("wizard.subtitle")}</p>

      {/* Step indicator */}
      <div className="mb-10 flex items-center justify-center gap-2">
        {STEP_LABELS.map((s, idx) => (
          <div key={s.key} className="flex items-center gap-2">
            {idx > 0 && (
              <div className={cn("h-px w-8", idx <= currentStepIdx ? "bg-primary" : "bg-muted")} />
            )}
            <div className="flex flex-col items-center gap-1">
              <div className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium",
                idx < currentStepIdx ? "bg-primary text-primary-foreground" :
                idx === currentStepIdx ? "border-2 border-primary bg-primary/10 text-primary" :
                "border-2 border-muted-foreground/30 text-muted-foreground"
              )}>
                {idx < currentStepIdx ? <CheckCircle className="h-4 w-4" /> : idx + 1}
              </div>
              <span className={cn(
                "text-xs",
                idx <= currentStepIdx ? "text-foreground font-medium" : "text-muted-foreground"
              )}>
                {s.label}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Step 1: Upload */}
      {step === "upload" && (
        <div className="space-y-6">
          <div
            className={cn(
              "relative rounded-lg border-2 border-dashed p-12 text-center transition-colors",
              uploadFile ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-primary/50"
            )}
          >
            <input
              type="file"
              accept=".pptx"
              onChange={handleFileChange}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
            {uploadFile ? (
              <div className="flex flex-col items-center gap-3">
                <FileText className="h-12 w-12 text-primary" />
                <div>
                  <p className="font-medium">{uploadFile.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {(uploadFile.size / 1024 / 1024).toFixed(1)} MB
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Upload className="h-12 w-12 text-muted-foreground" />
                <p className="font-medium">{t("wizard.drop_hint")}</p>
                <p className="text-sm text-muted-foreground">{t("wizard.drop_limit")}</p>
              </div>
            )}
          </div>

          {uploadError && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {uploadError}
            </div>
          )}

          <div className="flex items-center justify-between">
            <button
              onClick={handleSkipUpload}
              className="text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              {t("wizard.skip_upload")}
            </button>
            <button
              onClick={handleUpload}
              disabled={!uploadFile || isAnalyzing}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("wizard.analyzing")}
                </>
              ) : (
                <>
                  {t("wizard.upload_analyze")}
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Confirm Fields */}
      {step === "confirm" && (
        <>
          {generateError && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {generateError}
            </div>
          )}
          <Step2ConfirmFields
            extracted={extractedFields}
            autoDetectedKind={autoDetectedKind}
            onConfirm={handleConfirm}
            onBack={() => { setStep("upload"); setGenerateError(null) }}
            isSubmitting={isGenerating}
          />
        </>
      )}

      {/* Step 3: Generate */}
      {step === "generate" && (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="mt-4 text-lg font-medium">{t("wizard.generating")}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("wizard.generating_desc")}
          </p>
          <div className="mt-6 w-64 rounded-full bg-muted">
            <div className="h-2 animate-pulse rounded-full bg-primary" style={{ width: "60%" }} />
          </div>
        </div>
      )}

      {/* Step 4: Done */}
      {step === "done" && generateResult && (
        <div className="space-y-6">
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
              <CheckCircle className="h-10 w-10 text-green-600 dark:text-green-400" />
            </div>
            <h2 className="text-xl font-semibold">{t("wizard.template_created")}</h2>
            <p className="text-sm text-muted-foreground">
              {generateResult.name} ({generateResult.kind})
            </p>
          </div>

          <div className="rounded-lg border bg-card p-6">
            <h3 className="mb-4 text-sm font-medium">{t("wizard.summary_title")}</h3>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("wizard.summary_template_id")}</dt>
              <dd className="font-mono">{generateResult.template_id}</dd>
              <dt className="text-muted-foreground">{t("wizard.summary_kind")}</dt>
              <dd className="capitalize">{generateResult.kind}</dd>
              <dt className="text-muted-foreground">{t("wizard.summary_svg_pages")}</dt>
              <dd>{generateResult.svg_pages}</dd>
              <dt className="text-muted-foreground">{t("wizard.summary_qc_warnings")}</dt>
              <dd className={generateResult.qc_warnings > 0 ? "text-yellow-600" : "text-green-600"}>
                {generateResult.qc_warnings > 0
                  ? t("wizard.summary_qc_warnings_count", { count: generateResult.qc_warnings })
                  : t("wizard.summary_qc_warnings_none")}
              </dd>
              <dt className="text-muted-foreground">{t("wizard.summary_registered")}</dt>
              <dd>{generateResult.register_ok ? t("wizard.summary_yes") : t("wizard.summary_no")}</dd>
            </dl>
          </div>

          {generateResult.design_spec_preview && (
            <div className="rounded-lg border bg-card p-6">
              <h3 className="mb-2 text-sm font-medium">{t("wizard.design_spec_preview")}</h3>
              <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono max-h-40 overflow-y-auto">
                {generateResult.design_spec_preview}
              </pre>
            </div>
          )}

          <div className="flex justify-center gap-4 pt-4">
            <button
              onClick={handleCreateAnother}
              className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
            >
              {t("wizard.create_another")}
            </button>
            <button
              onClick={() => navigate("/templates")}
              className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("wizard.view_templates")}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
