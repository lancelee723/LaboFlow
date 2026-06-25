import { useEffect, useReducer } from "react"
import { useTranslation } from "react-i18next"

/**
 * Forces a component to re-render when the i18n language changes.
 * Use this in page-level components that contain hardcoded text or
 * t()-calls that don't react to i18next's languageChanged event
 * on their own (e.g. strings used outside JSX at module level).
 */
export function useLocaleReRender() {
  const { i18n } = useTranslation()
  const [, forceRender] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    const onLanguageChanged = () => forceRender()
    i18n.on("languageChanged", onLanguageChanged)
    return () => { i18n.off("languageChanged", onLanguageChanged) }
  }, [i18n])
}
