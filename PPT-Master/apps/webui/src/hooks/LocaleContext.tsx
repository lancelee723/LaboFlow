import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"

const LocaleContext = createContext<string>("en")

export function LocaleProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const [locale, setLocale] = useState(i18n.language || "en")

  useEffect(() => {
    const onChanged = (lng: string) => setLocale(lng)
    i18n.on("languageChanged", onChanged)
    return () => { i18n.off("languageChanged", onChanged) }
  }, [i18n])

  return (
    <LocaleContext.Provider value={locale}>
      {children}
    </LocaleContext.Provider>
  )
}

/** Returns the current locale string ("en" | "zh") and re-renders the
 *  component whenever the language changes. */
export function useLocale(): string {
  return useContext(LocaleContext)
}
