import { useCallback } from "react"
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Home, Layout, Settings, Presentation, LogOut } from "lucide-react"
import { useAuth } from "@/hooks/useAuth"
import { useLocale } from "@/hooks/LocaleContext"
import { usePipelineStore } from "@/stores/pipeline"
import { apiFetch } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function Shell() {
  const { t, i18n } = useTranslation(["shell", "common"])
  const currentLocale = useLocale()

  const navItems = [
    { to: "/projects", icon: Home, key: "home" as const },
    { to: "/templates", icon: Layout, key: "templates" as const },
  ]

  const settingsItems = [
    { to: "/settings/profile", key: "profile" as const },
    { to: "/settings/llm", key: "llmProviders" as const },
    { to: "/settings/usage", key: "usage" as const },
  ]
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const settingsActive = location.pathname.startsWith("/settings")

  const toggleLocale = useCallback(() => {
    const target = currentLocale === "zh" ? "en" : "zh"
    try { localStorage.setItem("i18n-locale", target) } catch { /* quota */ }
    i18n.changeLanguage(target)
    apiFetch("/api/users/me", {
      method: "PATCH",
      body: JSON.stringify({ locale: target }),
    }).catch(() => { /* best-effort */ })
  }, [currentLocale, i18n])

  const { data: running = [] } = useQuery({
    queryKey: ["running-sessions"],
    queryFn: () => apiFetch<{ session_id: string; project_id: string; project_name: string }[]>("/api/sessions/running"),
    refetchInterval: 5000,
    staleTime: 4000,
  })
  const runningCount = running.length

  const isPipelineActive = usePipelineStore((s) => s.isActive)
  const requestLeave = usePipelineStore((s) => s.requestLeave)

  const guardedNav = (to: string) => {
    if (isPipelineActive) {
      requestLeave(() => navigate(to))
    } else {
      navigate(to)
    }
  }

  const handleLogout = async () => {
    await logout()
    navigate("/login")
  }

  return (
    <div className="flex h-screen">
      <aside className="flex w-16 flex-col items-center border-r bg-muted/30 py-4">
        <div className="mb-6 text-lg font-bold">
          <Presentation className="h-6 w-6" />
        </div>
        <nav className="flex flex-1 flex-col gap-2">
          {navItems.map(({ to, icon: Icon, key }) => (
            <NavLink
              key={to}
              to={to}
              onClick={(e) => { e.preventDefault(); guardedNav(to) }}
              className={({ isActive }) =>
                cn(
                  "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )
              }
              title={t(`shell:${key}`)}
            >
              {key === "home" ? (
                <div className="relative">
                  <Icon className="h-5 w-5" />
                  {runningCount > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-medium text-white">
                      {runningCount > 9 ? "9+" : runningCount}
                    </span>
                  )}
                </div>
              ) : (
                <Icon className="h-5 w-5" />
              )}
            </NavLink>
          ))}

          {/* Settings popover */}
          <div className="group relative">
            <button
              type="button"
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
                settingsActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              title={t("shell:settings")}
              aria-label={t("shell:settings")}
              aria-haspopup="menu"
            >
              <Settings className="h-5 w-5" />
            </button>
            <div className="invisible absolute left-14 top-0 z-50 group-hover:visible group-focus-within:visible">
              <div role="menu" className="min-w-[160px] rounded-md border bg-white p-1 shadow-lg">
                {settingsItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={(e) => { e.preventDefault(); guardedNav(item.to) }}
                    role="menuitem"
                    className={({ isActive }) =>
                      cn(
                        "block rounded px-3 py-1.5 text-sm",
                        isActive ? "bg-accent" : "hover:bg-accent"
                      )
                    }
                  >
                    {t(`shell:${item.key}`)}
                  </NavLink>
                ))}
              </div>
            </div>
          </div>
        </nav>
        <div className="mt-auto flex flex-col items-center gap-2">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title={user?.email ?? undefined}
            onClick={() => guardedNav("/settings/profile")}
          >
            {user?.email?.charAt(0).toUpperCase()}
          </button>
          <button
            type="button"
            className="flex h-6 items-center justify-center rounded-full bg-primary/10 px-2 text-[10px] font-semibold text-primary hover:bg-primary/20 transition-colors"
            onClick={toggleLocale}
            title={t("shell:localeToggle")}
          >
            {currentLocale === "zh" ? "EN" : "中"}
          </button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleLogout} title={t("shell:signOut")}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
