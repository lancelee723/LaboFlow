import i18next from "i18next"
import { initReactI18next } from "react-i18next"

import enCommon from "./locales/en/common.json"
import enEditor from "./locales/en/editor.json"
import enProjects from "./locales/en/projects.json"
import enShell from "./locales/en/shell.json"
import enSettings from "./locales/en/settings.json"
import enWorkspace from "./locales/en/workspace.json"
import zhCommon from "./locales/zh/common.json"
import zhEditor from "./locales/zh/editor.json"
import zhProjects from "./locales/zh/projects.json"
import zhShell from "./locales/zh/shell.json"
import zhSettings from "./locales/zh/settings.json"
import zhWorkspace from "./locales/zh/workspace.json"

function detectLocale(): string {
  try {
    const cached = localStorage.getItem("i18n-locale")
    if (cached === "en" || cached === "zh") return cached
  } catch {
    // localStorage unavailable
  }
  if (typeof navigator !== "undefined" && navigator.language?.startsWith("zh")) {
    return "zh"
  }
  return "en"
}

const instance = i18next.createInstance()

instance.use(initReactI18next).init({
  lng: detectLocale(),
  fallbackLng: "en",
  ns: ["common", "editor", "projects", "shell", "settings", "workspace"],
  defaultNS: "common",
  interpolation: {
    escapeValue: false,
  },
  resources: {
    en: {
      common: enCommon,
      editor: enEditor,
      projects: enProjects,
      shell: enShell,
      settings: enSettings,
      workspace: enWorkspace,
    },
    zh: {
      common: zhCommon,
      editor: zhEditor,
      projects: zhProjects,
      shell: zhShell,
      settings: zhSettings,
      workspace: zhWorkspace,
    },
  },
})

export default instance
