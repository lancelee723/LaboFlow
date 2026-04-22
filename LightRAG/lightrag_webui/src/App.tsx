import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActivityIcon,
  FileTextIcon,
  GithubIcon,
  LogOutIcon,
  MessageSquareTextIcon,
  Share2Icon,
  ZapIcon
} from 'lucide-react'

import { getAuthStatus, InvalidApiKeyError, RequireApiKeError } from '@/api/lightrag'
import ApiKeyAlert from '@/components/ApiKeyAlert'
import AppSettings from '@/components/AppSettings'
import StatusIndicator from '@/components/status/StatusIndicator'
import Button from '@/components/ui/Button'
import DocumentManager from '@/features/DocumentManager'
import GraphViewer from '@/features/GraphViewer'
import RetrievalTesting from '@/features/RetrievalTesting'
import { SiteInfo, webuiPrefix } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { navigationService } from '@/services/navigation'
import { useBackendState, useAuthStore } from '@/stores/state'
import { useSettingsStore } from '@/stores/settings'

type WorkspaceTab = 'documents' | 'knowledge-graph' | 'retrieval'

const surfaceShadow =
  'shadow-[0_4px_18px_rgba(0,0,0,0.04),0_2.025px_7.84688px_rgba(0,0,0,0.027),0_0.8px_2.925px_rgba(0,0,0,0.02),0_0.175px_1.04062px_rgba(0,0,0,0.01)]'

function App() {
  const { t } = useTranslation()
  const message = useBackendState.use.message()
  const pipelineBusy = useBackendState.use.pipelineBusy()
  const enableHealthCheck = useSettingsStore.use.enableHealthCheck()
  const currentTab = useSettingsStore.use.currentTab()
  const setCurrentTab = useSettingsStore.use.setCurrentTab()
  const { isGuestMode, coreVersion, apiVersion, username } = useAuthStore()

  const [apiKeyAlertOpen, setApiKeyAlertOpen] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const versionCheckRef = useRef(false)
  const isMountedRef = useRef(true)

  const handleApiKeyAlertOpenChange = useCallback((open: boolean) => {
    setApiKeyAlertOpen(open)
    if (!open) {
      useBackendState.getState().clear()
    }
  }, [])

  const handleLogout = useCallback(() => {
    navigationService.navigateToLogin()
  }, [])

  const handleTabChange = useCallback(
    (tab: WorkspaceTab) => {
      setCurrentTab(tab)
    },
    [setCurrentTab]
  )

  useEffect(() => {
    isMountedRef.current = true

    const handleBeforeUnload = () => {
      isMountedRef.current = false
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      isMountedRef.current = false
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  useEffect(() => {
    const performHealthCheck = async () => {
      try {
        if (isMountedRef.current) {
          await useBackendState.getState().check()
        }
      } catch (error) {
        console.error('Health check error:', error)
      }
    }

    useBackendState.getState().setHealthCheckFunction(performHealthCheck)

    if (!enableHealthCheck || apiKeyAlertOpen) {
      useBackendState.getState().clearHealthCheckTimer()
      return
    }

    useBackendState.getState().resetHealthCheckTimer()

    return () => {
      useBackendState.getState().clearHealthCheckTimer()
    }
  }, [enableHealthCheck, apiKeyAlertOpen])

  useEffect(() => {
    const checkVersion = async () => {
      if (versionCheckRef.current) {
        return
      }
      versionCheckRef.current = true

      const versionCheckedFromLogin = sessionStorage.getItem('VERSION_CHECKED_FROM_LOGIN') === 'true'
      if (versionCheckedFromLogin) {
        setInitializing(false)
        return
      }

      try {
        setInitializing(true)

        const token = localStorage.getItem('LIGHTRAG-API-TOKEN')
        const status = await getAuthStatus()

        if (!status.auth_configured && status.access_token) {
          const currentState = useAuthStore.getState()

          if (token && currentState.isAuthenticated && !currentState.isGuestMode) {
            useAuthStore.getState().login(
              token,
              false,
              status.core_version,
              status.api_version,
              status.webui_title || null,
              status.webui_description || null
            )
          } else {
            useAuthStore.getState().login(
              status.access_token,
              true,
              status.core_version,
              status.api_version,
              status.webui_title || null,
              status.webui_description || null
            )
          }
        } else if (
          token &&
          (status.core_version ||
            status.api_version ||
            status.webui_title ||
            status.webui_description)
        ) {
          const nextGuestMode =
            status.auth_mode === 'disabled' || useAuthStore.getState().isGuestMode

          useAuthStore.getState().login(
            token,
            nextGuestMode,
            status.core_version,
            status.api_version,
            status.webui_title || null,
            status.webui_description || null
          )
        }

        sessionStorage.setItem('VERSION_CHECKED_FROM_LOGIN', 'true')
      } catch (error) {
        console.error('Failed to get version info:', error)
      } finally {
        setInitializing(false)
      }
    }

    checkVersion()
  }, [])

  useEffect(() => {
    if (currentTab === 'api') {
      useSettingsStore.getState().setCurrentTab('documents')
    }
  }, [currentTab])

  useEffect(() => {
    if (message && (message.includes(InvalidApiKeyError) || message.includes(RequireApiKeError))) {
      setApiKeyAlertOpen(true)
    }
  }, [message])

  const activeTab: WorkspaceTab =
    currentTab === 'knowledge-graph' || currentTab === 'retrieval'
      ? currentTab
      : 'documents'

  const versionDisplay = coreVersion && apiVersion ? `${coreVersion}/${apiVersion}` : null

  const workspaceSections = useMemo(
    () => [
      {
        id: 'documents' as const,
        title: t('shell.sections.documents.title'),
        description: t('shell.sections.documents.description'),
        icon: FileTextIcon
      },
      {
        id: 'knowledge-graph' as const,
        title: t('shell.sections.knowledgeGraph.title'),
        description: t('shell.sections.knowledgeGraph.description'),
        icon: Share2Icon
      },
      {
        id: 'retrieval' as const,
        title: t('shell.sections.retrieval.title'),
        description: t('shell.sections.retrieval.description'),
        icon: MessageSquareTextIcon
      }
    ],
    [t]
  )

  const renderWorkspace = () => {
    switch (activeTab) {
      case 'knowledge-graph':
        return <GraphViewer />
      case 'retrieval':
        return <RetrievalTesting />
      case 'documents':
      default:
        return <DocumentManager />
    }
  }

  if (initializing) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground lg:flex-row">
        <aside className="w-full shrink-0 border-b border-black/10 bg-white lg:w-[240px] lg:border-r lg:border-b-0">
          <div className="flex h-full min-h-0 flex-col overflow-hidden p-4 lg:p-5">
            <div className="shell-sidebar-scroll flex-1 overflow-x-hidden overflow-y-scroll pr-2">
              <div className="flex min-h-full flex-col gap-5">
                <div className="flex items-center gap-3">
                  <div className="flex size-11 items-center justify-center rounded-[10px] bg-[#0075de] text-white">
                    <ZapIcon className="size-5" aria-hidden="true" />
                  </div>
                  <div className="space-y-2">
                    <div className="h-3 w-24 animate-pulse rounded-full bg-[#d9d3cd]" />
                    <div className="h-6 w-32 animate-pulse rounded-full bg-[#ece8e3]" />
                  </div>
                </div>

                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <div key={index} className="rounded-[12px] border border-black/8 bg-white/70 p-3.5">
                      <div className="h-4 w-20 animate-pulse rounded-full bg-[#ece8e3]" />
                      <div className="mt-3 h-9 animate-pulse rounded-2xl bg-[#f4f1ed]" />
                    </div>
                  ))}
                </div>

                <div className="mt-auto space-y-3 pb-1">
                  <div className="rounded-[12px] border border-black/10 bg-white/80 p-3.5">
                    <div className="h-4 w-28 animate-pulse rounded-full bg-[#ece8e3]" />
                    <div className="mt-4 h-16 animate-pulse rounded-2xl bg-[#f4f1ed]" />
                  </div>
                  <div className="rounded-[12px] border border-black/10 bg-white/80 p-3.5">
                    <div className="h-4 w-24 animate-pulse rounded-full bg-[#ece8e3]" />
                    <div className="mt-3 h-10 animate-pulse rounded-2xl bg-[#f4f1ed]" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="min-h-0 flex-1 p-4 lg:p-6">
            <div className={cn('h-full min-h-0 rounded-[16px] border border-black/10 bg-white', surfaceShadow)} />
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground lg:flex-row">
      <aside className="w-full shrink-0 border-b border-black/10 bg-white lg:w-[240px] lg:border-r lg:border-b-0">
        <div className="flex h-full min-h-0 flex-col overflow-hidden p-4 lg:p-5">
          <div className="shell-sidebar-scroll flex-1 overflow-x-hidden overflow-y-scroll pr-2">
            <div className="flex min-h-full flex-col gap-5">
              <a href={webuiPrefix} className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-[10px] bg-[#0075de] text-white shadow-[0_8px_20px_rgba(0,117,222,0.22)]">
                  <ZapIcon className="size-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#097fe8]">
                    {t('shell.brandBadge')}
                  </div>
                  <div className="truncate text-[24px] font-bold tracking-[-0.625px] text-[#1f1e1c]">
                    {SiteInfo.name}
                  </div>
                </div>
              </a>

              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a847e]">
                  {t('shell.sidebarLabel')}
                </div>
                <nav className="space-y-2">
                  {workspaceSections.map((section) => {
                    const Icon = section.icon
                    const isActive = section.id === activeTab

                    return (
                      <button
                        key={section.id}
                        type="button"
                        aria-current={isActive ? 'page' : undefined}
                        onClick={() => handleTabChange(section.id)}
                        className={cn(
                          'flex w-full items-start gap-2.5 rounded-[8px] border px-3.5 py-3 text-left transition-all duration-200',
                          isActive
                            ? `border-[#0075de]/20 bg-white ${surfaceShadow}`
                            : 'border-transparent bg-transparent hover:border-black/10 hover:bg-white/65'
                        )}
                      >
                        <div
                          className={cn(
                            'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border transition-colors',
                            isActive
                              ? 'border-[#0075de]/15 bg-[#f2f9ff] text-[#097fe8]'
                              : 'border-black/8 bg-white/80 text-[#615d59]'
                          )}
                        >
                          <Icon className="size-4.5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-[#1f1e1c]">{section.title}</span>
                            {isActive && (
                              <span className="rounded-full bg-[#f2f9ff] px-2 py-0.5 text-[11px] font-semibold tracking-[0.125px] text-[#097fe8]">
                                {t('shell.activeBadge')}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#766f69]">{section.description}</p>
                        </div>
                      </button>
                    )
                  })}
                </nav>
              </div>

              <div className="mt-auto space-y-3 pb-1">
                <div className={cn('rounded-[12px] border border-black/10 bg-white/82 p-3.5', surfaceShadow)}>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a847e]">
                    {t('shell.systemLabel')}
                  </div>
                  <div className="mt-2.5 space-y-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[#615d59]">{t('shell.pipelineStatus')}</span>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-[0.125px]',
                          pipelineBusy ? 'bg-[#fff3ef] text-[#c2571a]' : 'bg-[#f2f9ff] text-[#097fe8]'
                        )}
                      >
                        <ActivityIcon className="size-3.5" aria-hidden="true" />
                        {pipelineBusy ? t('shell.pipelineBusy') : t('shell.pipelineIdle')}
                      </span>
                    </div>

                    {versionDisplay && (
                      <div className="flex items-center justify-between gap-3 text-[#766f69]">
                        <span>{t('shell.versionLabel')}</span>
                        <span className="font-medium text-[#1f1e1c]">v{versionDisplay}</span>
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-3">
                      <StatusIndicator variant="inline" />
                    </div>
                  </div>
                </div>

                <div className={cn('flex items-center justify-between gap-3 rounded-[12px] border border-black/10 bg-white/82 px-3 py-2.5', surfaceShadow)}>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[#1f1e1c]">
                      {isGuestMode ? t('login.guestMode') : username || t('shell.memberLabel')}
                    </div>
                    <div className="text-xs text-[#766f69]">{t('shell.footerHint')}</div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button asChild variant="ghost" size="icon" side="bottom" tooltip={t('header.projectRepository')}>
                      <a href={SiteInfo.github} target="_blank" rel="noopener noreferrer">
                        <GithubIcon className="size-4" aria-hidden="true" />
                      </a>
                    </Button>
                    <AppSettings className="rounded-[6px] hover:bg-[#f6f5f4]" />
                    {!isGuestMode && (
                      <Button
                        variant="ghost"
                        size="icon"
                        side="bottom"
                        tooltip={`${t('header.logout')} (${username || t('shell.memberLabel')})`}
                        onClick={handleLogout}
                      >
                        <LogOutIcon className="size-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </div>

              </div>
            </div>
          </div>
        </div>
      </aside>

      <main className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="min-h-0 flex-1 p-4 lg:p-6">
          <div className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[16px] border border-black/10 bg-white', surfaceShadow)}>
            {renderWorkspace()}
          </div>
        </div>

        <ApiKeyAlert open={apiKeyAlertOpen} onOpenChange={handleApiKeyAlertOpenChange} />
      </main>
    </div>
  )
}

export default App
