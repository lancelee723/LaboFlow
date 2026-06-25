import { Routes, Route, Navigate } from "react-router-dom"
import { I18nextProvider } from "react-i18next"
import * as Sentry from "@sentry/react"
import i18n from "./i18n"
import { LocaleProvider } from "./hooks/LocaleContext"
import { useAuth } from "./hooks/useAuth"
import { Shell } from "./components/Shell"
import { LoginPage } from "./pages/LoginPage"
import { ProjectsListPage } from "./pages/ProjectsListPage"
import { ProjectDisplayPage } from "./pages/ProjectDisplayPage"
import { ProjectEditorPage } from "./pages/ProjectEditorPage"
import { SettingsPage } from "./pages/SettingsPage"
import { TemplatesPage } from "./pages/TemplatesPage"
import { TemplateWizardPage } from "./pages/TemplateWizardPage"
import { ProfilePage } from "./pages/ProfilePage"
import { UsagePage } from "./pages/UsagePage"
import { SharePage } from "./pages/SharePage"

function AppRoutes() {
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  return (
    <Routes>
      {/* Public routes (no auth required) */}
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/share/:token" element={<SharePage />} />

      {/* Authenticated routes */}
      <Route element={user ? <Shell /> : <Navigate to="/login" replace />}>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsListPage />} />
        <Route path="/projects/new" element={<ProjectEditorPage />} />
        <Route path="/projects/:id" element={<ProjectDisplayPage />} />
        <Route path="/projects/:id/edit" element={<ProjectEditorPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/templates/new" element={<TemplateWizardPage />} />
        <Route path="/settings/profile" element={<ProfilePage />} />
        <Route path="/settings/llm" element={<SettingsPage />} />
        <Route path="/settings/usage" element={<UsagePage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function App() {
  // G4.10: Sentry — no-op if VITE_SENTRY_DSN is not set
  const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, tracesSampleRate: 0.1 })
  }

  const content = (
    <I18nextProvider i18n={i18n}>
      <LocaleProvider>
        <AppRoutes />
      </LocaleProvider>
    </I18nextProvider>
  )

  if (!sentryDsn) return content

  return (
    <Sentry.ErrorBoundary fallback={<div className="p-6 text-center text-muted-foreground">Something went wrong. Please refresh the page.</div>}>
      {content}
    </Sentry.ErrorBoundary>
  )
}

export default App
