import { getAISettings, getProviderApiKey, ensureServerSettingsLoaded } from './config'
import { streamOpenAI, type ChatMessage } from './openaiStream'
import { getProvider, type ProviderKey } from './providers'
import { analyzeTaskType, selectModelForTask, getTaskDescription } from './modelRouter'

export type StreamHandler = {
  onDelta?: (chunk: string) => void
  onError?: (e: any) => void
  onDone?: () => void
}

export interface StreamOptions {
  provider?: ProviderKey
  model?: string
  taskContext?: {
    isChat?: boolean
    slideCount?: number
    hasDocument?: boolean
  }
}

export function streamGenerate(
  userPrompt: string,
  systemPrompt?: string,
  handler?: StreamHandler,
  controller?: AbortController,
  options?: StreamOptions,
): AbortController {
  const messages: ChatMessage[] = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: userPrompt })

  const ctrl = controller ?? new AbortController()

  ;(async () => {
    try {
      await ensureServerSettingsLoaded()
      const settings = getAISettings()

      let finalProvider = settings.provider
      let finalModel = settings.model

      if (options?.provider && options?.model) {
        finalProvider = options.provider
        finalModel = options.model
      }
      else if (options?.taskContext) {
        const taskType = analyzeTaskType(userPrompt, {
          ...options.taskContext,
          promptLength: userPrompt.length,
        })
        const modelConfig = selectModelForTask(taskType)
        finalProvider = modelConfig.provider
        finalModel = modelConfig.model
      }

      const providerApiKey = getProviderApiKey(finalProvider, settings)
      const hasKey = !!providerApiKey

      if (hasKey) {
        const provider = getProvider(finalProvider)
        const baseUrl = finalProvider === 'custom' ? (settings.baseUrl || '') : provider.baseUrl
        if (!baseUrl) throw new Error('Base URL is not configured')

        await streamOpenAI({
          url: baseUrl.replace(/\/$/, '') + '/chat/completions',
          apiKey: providerApiKey,
          model: finalModel,
          messages,
          temperature: settings.temperature,
          signal: ctrl.signal,
        }, (d) => handler?.onDelta?.(d))
      } else {
        const { aiApi } = await import('@/api/ai')
        await aiApi.streamTrial({
          model: settings.model,
          messages,
          temperature: settings.temperature,
          headers: { 'x-user-id': localStorage.getItem('uid') || '', 'x-user-role': localStorage.getItem('role') || 'guest' },
          signal: ctrl.signal,
        }, (d: string) => handler?.onDelta?.(d))
      }

      handler?.onDone?.()
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        handler?.onError?.(e)
      } else {
        handler?.onError?.(e)
      }
    }
  })()

  return ctrl
}
