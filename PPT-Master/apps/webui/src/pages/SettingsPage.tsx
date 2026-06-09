import { useLocale } from "@/hooks/LocaleContext"
import { LLMProvidersSection } from "@/components/settings/LLMProvidersSection"
import { ImageBackendsSection } from "@/components/settings/ImageBackendsSection"
import { ImageSearchSection } from "@/components/settings/ImageSearchSection"

export function SettingsPage() {
  useLocale() // re-renders on locale change via React context

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <LLMProvidersSection />
      <ImageBackendsSection />
      <ImageSearchSection />
    </div>
  )
}
