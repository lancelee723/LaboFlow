import { useCallback, useMemo } from 'react'
import { QueryMode, QueryRequest } from '@/api/lightrag'
// Removed unused import for Text component
import Checkbox from '@/components/ui/Checkbox'
import Input from '@/components/ui/Input'
import UserPromptInputWithHistory from '@/components/ui/UserPromptInputWithHistory'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/Select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/Tooltip'
import { useSettingsStore } from '@/stores/settings'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'

const ResetButton = ({ onClick, title }: { onClick: () => void; title: string }) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="mr-1 flex h-9 w-9 items-center justify-center rounded-xl border border-black/10 bg-white text-[#766f69] transition-colors hover:bg-[#f6f5f4] hover:text-[#1f1e1c] dark:border-white/10 dark:bg-white/8 dark:text-white/65 dark:hover:bg-white/12 dark:hover:text-white"
          title={title}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">
        <p>{title}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

export default function QuerySettings() {
  const { t } = useTranslation()
  const querySettings = useSettingsStore((state) => state.querySettings)
  const userPromptHistory = useSettingsStore((state) => state.userPromptHistory)
  const fieldLabelClassName =
    'ml-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a847e] dark:text-white/55'
  const numericInputClassName =
    'h-10 flex-1 rounded-xl border-black/10 bg-white/90 pr-2 shadow-none dark:border-white/10 dark:bg-white/8 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]'
  const toggleRowClassName =
    'flex items-center gap-2 rounded-xl border border-black/6 bg-[#faf8f5] px-3 py-2 dark:border-white/8 dark:bg-white/4'

  const handleChange = useCallback((key: keyof QueryRequest, value: any) => {
    useSettingsStore.getState().updateQuerySettings({ [key]: value })
  }, [])

  const handleSelectFromHistory = useCallback((prompt: string) => {
    handleChange('user_prompt', prompt)
  }, [handleChange])

  const handleDeleteFromHistory = useCallback((index: number) => {
    const newHistory = [...userPromptHistory]
    newHistory.splice(index, 1)
    useSettingsStore.getState().setUserPromptHistory(newHistory)
  }, [userPromptHistory])

  // Default values for reset functionality
  const defaultValues = useMemo(() => ({
    mode: 'mix' as QueryMode,
    top_k: 40,
    chunk_top_k: 20,
    max_entity_tokens: 6000,
    max_relation_tokens: 8000,
    max_total_tokens: 30000
  }), [])

  const handleReset = useCallback((key: keyof typeof defaultValues) => {
    handleChange(key, defaultValues[key])
  }, [handleChange, defaultValues])

  return (
    <Card className="flex w-[320px] shrink-0 flex-col overflow-hidden rounded-[24px] border-black/10 bg-white/92 shadow-[0_4px_18px_rgba(0,0,0,0.04),0_2.025px_7.84688px_rgba(0,0,0,0.027),0_0.8px_2.925px_rgba(0,0,0,0.02),0_0.175px_1.04062px_rgba(0,0,0,0.01)] dark:border-white/10 dark:bg-[#1f1c1a]/92">
      <CardHeader className="border-b border-black/6 px-5 pb-4 pt-5 dark:border-white/8">
        <CardTitle className="text-[18px] font-bold tracking-[-0.25px] text-[#1f1e1c] dark:text-white">{t('retrievePanel.querySettings.parametersTitle')}</CardTitle>
        <CardDescription className="sr-only">{t('retrievePanel.querySettings.parametersDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="m-0 flex grow flex-col p-0 text-xs">
        <div className="relative size-full">
          <div className="absolute inset-0 flex flex-col gap-3 overflow-auto px-4 py-4">
            {/* User Prompt - Moved to top for better dropdown space */}
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label htmlFor="user_prompt" className={fieldLabelClassName}>
                      {t('retrievePanel.querySettings.userPrompt')}
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p>{t('retrievePanel.querySettings.userPromptTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <div>
                <UserPromptInputWithHistory
                  id="user_prompt"
                  value={querySettings.user_prompt || ''}
                  onChange={(value) => handleChange('user_prompt', value)}
                  onSelectFromHistory={handleSelectFromHistory}
                  onDeleteFromHistory={handleDeleteFromHistory}
                  history={userPromptHistory}
                  placeholder={t('retrievePanel.querySettings.userPromptPlaceholder')}
                  className="h-10 rounded-xl border-black/10 bg-white/90 shadow-none dark:border-white/10 dark:bg-white/8"
                />
              </div>
            </>

            {/* Query Mode */}
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label htmlFor="query_mode_select" className={fieldLabelClassName}>
                      {t('retrievePanel.querySettings.queryMode')}
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p>{t('retrievePanel.querySettings.queryModeTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <div className="flex items-center gap-1">
                <Select
                  value={querySettings.mode}
                  onValueChange={(v) => handleChange('mode', v as QueryMode)}
                >
                  <SelectTrigger
                    id="query_mode_select"
                    className="h-10 flex-1 cursor-pointer rounded-xl border-black/10 bg-white/90 text-left shadow-none hover:bg-[#f6f5f4] focus:ring-0 focus:ring-offset-0 focus:outline-0 active:right-0 dark:border-white/10 dark:bg-white/8 dark:hover:bg-white/12 [&>span]:break-all [&>span]:line-clamp-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="naive">{t('retrievePanel.querySettings.queryModeOptions.naive')}</SelectItem>
                      <SelectItem value="local">{t('retrievePanel.querySettings.queryModeOptions.local')}</SelectItem>
                      <SelectItem value="global">{t('retrievePanel.querySettings.queryModeOptions.global')}</SelectItem>
                      <SelectItem value="hybrid">{t('retrievePanel.querySettings.queryModeOptions.hybrid')}</SelectItem>
                      <SelectItem value="mix">{t('retrievePanel.querySettings.queryModeOptions.mix')}</SelectItem>
                      <SelectItem value="bypass">{t('retrievePanel.querySettings.queryModeOptions.bypass')}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <ResetButton
                  onClick={() => handleReset('mode')}
                  title="Reset to default (Mix)"
                />
              </div>
            </>

            {/* Top K */}
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label htmlFor="top_k" className={fieldLabelClassName}>
                      {t('retrievePanel.querySettings.topK')}
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p>{t('retrievePanel.querySettings.topKTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <div className="flex items-center gap-1">
                <Input
                  id="top_k"
                  type="number"
                  value={querySettings.top_k ?? ''}
                  onChange={(e) => {
                    const value = e.target.value
                    handleChange('top_k', value === '' ? '' : parseInt(value) || 0)
                  }}
                  onBlur={(e) => {
                    const value = e.target.value
                    if (value === '' || isNaN(parseInt(value))) {
                      handleChange('top_k', 40)
                    }
                  }}
                  min={1}
                  placeholder={t('retrievePanel.querySettings.topKPlaceholder')}
                  className={numericInputClassName}
                />
                <ResetButton
                  onClick={() => handleReset('top_k')}
                  title="Reset to default"
                />
              </div>
            </>

            {/* Chunk Top K */}
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label htmlFor="chunk_top_k" className={fieldLabelClassName}>
                      {t('retrievePanel.querySettings.chunkTopK')}
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p>{t('retrievePanel.querySettings.chunkTopKTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <div className="flex items-center gap-1">
                <Input
                  id="chunk_top_k"
                  type="number"
                  value={querySettings.chunk_top_k ?? ''}
                  onChange={(e) => {
                    const value = e.target.value
                    handleChange('chunk_top_k', value === '' ? '' : parseInt(value) || 0)
                  }}
                  onBlur={(e) => {
                    const value = e.target.value
                    if (value === '' || isNaN(parseInt(value))) {
                      handleChange('chunk_top_k', 20)
                    }
                  }}
                  min={1}
                  placeholder={t('retrievePanel.querySettings.chunkTopKPlaceholder')}
                  className={numericInputClassName}
                />
                <ResetButton
                  onClick={() => handleReset('chunk_top_k')}
                  title="Reset to default"
                />
              </div>
            </>

            {/* Max Entity Tokens */}
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label htmlFor="max_entity_tokens" className={fieldLabelClassName}>
                      {t('retrievePanel.querySettings.maxEntityTokens')}
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p>{t('retrievePanel.querySettings.maxEntityTokensTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <div className="flex items-center gap-1">
                <Input
                  id="max_entity_tokens"
                  type="number"
                  value={querySettings.max_entity_tokens ?? ''}
                  onChange={(e) => {
                    const value = e.target.value
                    handleChange('max_entity_tokens', value === '' ? '' : parseInt(value) || 0)
                  }}
                  onBlur={(e) => {
                    const value = e.target.value
                    if (value === '' || isNaN(parseInt(value))) {
                      handleChange('max_entity_tokens', 6000)
                    }
                  }}
                  min={1}
                  placeholder={t('retrievePanel.querySettings.maxEntityTokensPlaceholder')}
                  className={numericInputClassName}
                />
                <ResetButton
                  onClick={() => handleReset('max_entity_tokens')}
                  title="Reset to default"
                />
              </div>
            </>

            {/* Max Relation Tokens */}
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label htmlFor="max_relation_tokens" className={fieldLabelClassName}>
                      {t('retrievePanel.querySettings.maxRelationTokens')}
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p>{t('retrievePanel.querySettings.maxRelationTokensTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <div className="flex items-center gap-1">
                <Input
                  id="max_relation_tokens"
                  type="number"
                  value={querySettings.max_relation_tokens ?? ''}
                  onChange={(e) => {
                    const value = e.target.value
                    handleChange('max_relation_tokens', value === '' ? '' : parseInt(value) || 0)
                  }}
                  onBlur={(e) => {
                    const value = e.target.value
                    if (value === '' || isNaN(parseInt(value))) {
                      handleChange('max_relation_tokens', 8000)
                    }
                  }}
                  min={1}
                  placeholder={t('retrievePanel.querySettings.maxRelationTokensPlaceholder')}
                  className={numericInputClassName}
                />
                <ResetButton
                  onClick={() => handleReset('max_relation_tokens')}
                  title="Reset to default"
                />
              </div>
            </>

            {/* Max Total Tokens */}
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label htmlFor="max_total_tokens" className={fieldLabelClassName}>
                      {t('retrievePanel.querySettings.maxTotalTokens')}
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p>{t('retrievePanel.querySettings.maxTotalTokensTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <div className="flex items-center gap-1">
                <Input
                  id="max_total_tokens"
                  type="number"
                  value={querySettings.max_total_tokens ?? ''}
                  onChange={(e) => {
                    const value = e.target.value
                    handleChange('max_total_tokens', value === '' ? '' : parseInt(value) || 0)
                  }}
                  onBlur={(e) => {
                    const value = e.target.value
                    if (value === '' || isNaN(parseInt(value))) {
                      handleChange('max_total_tokens', 30000)
                    }
                  }}
                  min={1}
                  placeholder={t('retrievePanel.querySettings.maxTotalTokensPlaceholder')}
                  className={numericInputClassName}
                />
                <ResetButton
                  onClick={() => handleReset('max_total_tokens')}
                  title="Reset to default"
                />
              </div>
            </>

            {/* Toggle Options */}
            <>
              <div className={toggleRowClassName}>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label htmlFor="enable_rerank" className="flex-1 text-[13px] font-medium text-[#31302e] dark:text-white/85">
                        {t('retrievePanel.querySettings.enableRerank')}
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>{t('retrievePanel.querySettings.enableRerankTooltip')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <Checkbox
                  className="cursor-pointer rounded-[6px] border-black/15 data-[state=checked]:bg-[#097fe8] data-[state=checked]:text-white dark:border-white/20"
                  id="enable_rerank"
                  checked={querySettings.enable_rerank}
                  onCheckedChange={(checked) => handleChange('enable_rerank', checked)}
                />
              </div>

              <div className={toggleRowClassName}>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label htmlFor="only_need_context" className="flex-1 text-[13px] font-medium text-[#31302e] dark:text-white/85">
                        {t('retrievePanel.querySettings.onlyNeedContext')}
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>{t('retrievePanel.querySettings.onlyNeedContextTooltip')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <Checkbox
                  className="cursor-pointer rounded-[6px] border-black/15 data-[state=checked]:bg-[#097fe8] data-[state=checked]:text-white dark:border-white/20"
                  id="only_need_context"
                  checked={querySettings.only_need_context}
                  onCheckedChange={(checked) => {
                    handleChange('only_need_context', checked)
                    if (checked) {
                      handleChange('only_need_prompt', false)
                    }
                  }}
                />
              </div>

              <div className={toggleRowClassName}>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label htmlFor="only_need_prompt" className="flex-1 text-[13px] font-medium text-[#31302e] dark:text-white/85">
                        {t('retrievePanel.querySettings.onlyNeedPrompt')}
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>{t('retrievePanel.querySettings.onlyNeedPromptTooltip')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <Checkbox
                  className="cursor-pointer rounded-[6px] border-black/15 data-[state=checked]:bg-[#097fe8] data-[state=checked]:text-white dark:border-white/20"
                  id="only_need_prompt"
                  checked={querySettings.only_need_prompt}
                  onCheckedChange={(checked) => {
                    handleChange('only_need_prompt', checked)
                    if (checked) {
                      handleChange('only_need_context', false)
                    }
                  }}
                />
              </div>

              <div className={toggleRowClassName}>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label htmlFor="stream" className="flex-1 text-[13px] font-medium text-[#31302e] dark:text-white/85">
                        {t('retrievePanel.querySettings.streamResponse')}
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>{t('retrievePanel.querySettings.streamResponseTooltip')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <Checkbox
                  className="cursor-pointer rounded-[6px] border-black/15 data-[state=checked]:bg-[#097fe8] data-[state=checked]:text-white dark:border-white/20"
                  id="stream"
                  checked={querySettings.stream}
                  onCheckedChange={(checked) => handleChange('stream', checked)}
                />
              </div>
            </>

          </div>
        </div>
      </CardContent>
    </Card>
  )
}
