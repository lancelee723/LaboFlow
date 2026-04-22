import { useState, useCallback, useEffect} from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover'
import Checkbox from '@/components/ui/Checkbox'
import Button from '@/components/ui/Button'
import Separator from '@/components/ui/Separator'
import Input from '@/components/ui/Input'

import { controlButtonVariant } from '@/lib/constants'
import { useSettingsStore } from '@/stores/settings'
import { useGraphStore } from '@/stores/graph'
import useRandomGraph from '@/hooks/useRandomGraph'

import { SettingsIcon, Undo2, Shuffle } from 'lucide-react'
import { useTranslation } from 'react-i18next';

/**
 * Component that displays a checkbox with a label.
 */
const LabeledCheckBox = ({
  checked,
  onCheckedChange,
  label
}: {
  checked: boolean
  onCheckedChange: () => void
  label: string
}) => {
  // Create unique ID using the label text converted to lowercase with spaces removed
  const id = `checkbox-${label.toLowerCase().replace(/\s+/g, '-')}`;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-black/6 bg-[#faf8f5] px-3 py-2 dark:border-white/8 dark:bg-white/4">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="rounded-[6px] border-black/15 data-[state=checked]:bg-[#097fe8] data-[state=checked]:text-white dark:border-white/20"
      />
      <label
        htmlFor={id}
        className="text-[13px] leading-5 font-medium text-[#31302e] peer-disabled:cursor-not-allowed peer-disabled:opacity-70 dark:text-white/85"
      >
        {label}
      </label>
    </div>
  )
}

/**
 * Component that displays a number input with a label.
 */
const LabeledNumberInput = ({
  value,
  onEditFinished,
  label,
  min,
  max,
  defaultValue
}: {
  value: number
  onEditFinished: (value: number) => void
  label: string
  min: number
  max?: number
  defaultValue?: number
}) => {
  const { t } = useTranslation();
  const [currentValue, setCurrentValue] = useState<number | null>(value)
  // Create unique ID using the label text converted to lowercase with spaces removed
  const id = `input-${label.toLowerCase().replace(/\s+/g, '-')}`;

  useEffect(() => {
    setCurrentValue(value)
  }, [value])

  const onValueChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value.trim()
      if (text.length === 0) {
        setCurrentValue(null)
        return
      }
      const newValue = Number.parseInt(text)
      if (!isNaN(newValue) && newValue !== currentValue) {
        if (min !== undefined && newValue < min) {
          return
        }
        if (max !== undefined && newValue > max) {
          return
        }
        setCurrentValue(newValue)
      }
    },
    [currentValue, min, max]
  )

  const onBlur = useCallback(() => {
    if (currentValue !== null && value !== currentValue) {
      onEditFinished(currentValue)
    }
  }, [value, currentValue, onEditFinished])

  const handleReset = useCallback(() => {
    if (defaultValue !== undefined && value !== defaultValue) {
      setCurrentValue(defaultValue)
      onEditFinished(defaultValue)
    }
  }, [defaultValue, value, onEditFinished])

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={id}
        className="text-[13px] leading-5 font-medium text-[#31302e] peer-disabled:cursor-not-allowed peer-disabled:opacity-70 dark:text-white/85"
      >
        {label}
      </label>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          type="number"
          value={currentValue === null ? '' : currentValue}
          onChange={onValueChange}
          className="h-9 w-full min-w-0 rounded-xl border-black/10 bg-white pr-1 shadow-none dark:border-white/10 dark:bg-white/8"
          min={min}
          max={max}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onBlur()
            }
          }}
        />
        {defaultValue !== undefined && (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 flex-shrink-0 rounded-xl border border-black/10 bg-white text-[#766f69] hover:bg-[#f6f5f4] hover:text-[#1f1e1c] dark:border-white/10 dark:bg-white/8 dark:text-white/65 dark:hover:bg-white/12 dark:hover:text-white"
            onClick={handleReset}
            type="button"
            title={t('graphPanel.sideBar.settings.resetToDefault')}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Component that displays a popover with settings options.
 */
export default function Settings() {
  const [opened, setOpened] = useState<boolean>(false)
  const controlButtonClassName =
    'h-10 w-10 rounded-2xl border border-black/10 bg-white/92 text-[#615d59] shadow-none hover:bg-[#f6f5f4] hover:text-[#1f1e1c] dark:border-white/10 dark:bg-white/8 dark:text-white/80 dark:hover:bg-white/12'

  const showPropertyPanel = useSettingsStore.use.showPropertyPanel()
  const showNodeSearchBar = useSettingsStore.use.showNodeSearchBar()
  const showNodeLabel = useSettingsStore.use.showNodeLabel()
  const enableEdgeEvents = useSettingsStore.use.enableEdgeEvents()
  const enableNodeDrag = useSettingsStore.use.enableNodeDrag()
  const enableHideUnselectedEdges = useSettingsStore.use.enableHideUnselectedEdges()
  const showEdgeLabel = useSettingsStore.use.showEdgeLabel()
  const minEdgeSize = useSettingsStore.use.minEdgeSize()
  const maxEdgeSize = useSettingsStore.use.maxEdgeSize()
  const graphQueryMaxDepth = useSettingsStore.use.graphQueryMaxDepth()
  const graphMaxNodes = useSettingsStore.use.graphMaxNodes()
  const backendMaxGraphNodes = useSettingsStore.use.backendMaxGraphNodes()
  const graphLayoutMaxIterations = useSettingsStore.use.graphLayoutMaxIterations()

  const enableHealthCheck = useSettingsStore.use.enableHealthCheck()

  // Random graph functionality for development/testing
  const { randomGraph } = useRandomGraph()

  const setEnableNodeDrag = useCallback(
    () => useSettingsStore.setState((pre) => ({ enableNodeDrag: !pre.enableNodeDrag })),
    []
  )
  const setEnableEdgeEvents = useCallback(
    () => useSettingsStore.setState((pre) => ({ enableEdgeEvents: !pre.enableEdgeEvents })),
    []
  )
  const setEnableHideUnselectedEdges = useCallback(
    () =>
      useSettingsStore.setState((pre) => ({
        enableHideUnselectedEdges: !pre.enableHideUnselectedEdges
      })),
    []
  )
  const setShowEdgeLabel = useCallback(
    () =>
      useSettingsStore.setState((pre) => ({
        showEdgeLabel: !pre.showEdgeLabel
      })),
    []
  )

  //
  const setShowPropertyPanel = useCallback(
    () => useSettingsStore.setState((pre) => ({ showPropertyPanel: !pre.showPropertyPanel })),
    []
  )

  const setShowNodeSearchBar = useCallback(
    () => useSettingsStore.setState((pre) => ({ showNodeSearchBar: !pre.showNodeSearchBar })),
    []
  )

  const setShowNodeLabel = useCallback(
    () => useSettingsStore.setState((pre) => ({ showNodeLabel: !pre.showNodeLabel })),
    []
  )

  const setEnableHealthCheck = useCallback(
    () => useSettingsStore.setState((pre) => ({ enableHealthCheck: !pre.enableHealthCheck })),
    []
  )

  const setGraphQueryMaxDepth = useCallback((depth: number) => {
    if (depth < 1) return
    useSettingsStore.setState({ graphQueryMaxDepth: depth })
    const currentLabel = useSettingsStore.getState().queryLabel
    useSettingsStore.getState().setQueryLabel('')
    setTimeout(() => {
      useSettingsStore.getState().setQueryLabel(currentLabel)
    }, 300)
  }, [])

  const setGraphMaxNodes = useCallback((nodes: number) => {
    const maxLimit = backendMaxGraphNodes || 1000
    if (nodes < 1 || nodes > maxLimit) return
    useSettingsStore.getState().setGraphMaxNodes(nodes, true)
  }, [backendMaxGraphNodes])

  const setGraphLayoutMaxIterations = useCallback((iterations: number) => {
    if (iterations < 1) return
    useSettingsStore.setState({ graphLayoutMaxIterations: iterations })
  }, [])

  const handleGenerateRandomGraph = useCallback(() => {
    const graph = randomGraph()
    useGraphStore.getState().setSigmaGraph(graph)
  }, [randomGraph])

  const { t } = useTranslation();

  const saveSettings = () => setOpened(false);

  return (
    <>
      <Popover open={opened} onOpenChange={setOpened}>
        <PopoverTrigger asChild>
          <Button
            variant={controlButtonVariant}
            tooltip={t('graphPanel.sideBar.settings.settings')}
            size="icon"
            className={controlButtonClassName}
          >
            <SettingsIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="end"
          sideOffset={8}
          collisionPadding={5}
          className="w-[300px] rounded-[22px] border-black/10 bg-[#fffdfb] p-3 shadow-[0_14px_28px_rgba(0,0,0,0.04),0_7px_15px_rgba(0,0,0,0.02),0_3px_7px_rgba(0,0,0,0.02),0_1px_3px_rgba(0,0,0,0.01)] dark:border-white/10 dark:bg-[#201d1a]"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex flex-col gap-3">
            <LabeledCheckBox
              checked={enableHealthCheck}
              onCheckedChange={setEnableHealthCheck}
              label={t('graphPanel.sideBar.settings.healthCheck')}
            />

            <Separator className="bg-black/8 dark:bg-white/8" />

            <LabeledCheckBox
              checked={showPropertyPanel}
              onCheckedChange={setShowPropertyPanel}
              label={t('graphPanel.sideBar.settings.showPropertyPanel')}
            />
            <LabeledCheckBox
              checked={showNodeSearchBar}
              onCheckedChange={setShowNodeSearchBar}
              label={t('graphPanel.sideBar.settings.showSearchBar')}
            />

            <Separator className="bg-black/8 dark:bg-white/8" />

            <LabeledCheckBox
              checked={showNodeLabel}
              onCheckedChange={setShowNodeLabel}
              label={t('graphPanel.sideBar.settings.showNodeLabel')}
            />
            <LabeledCheckBox
              checked={enableNodeDrag}
              onCheckedChange={setEnableNodeDrag}
              label={t('graphPanel.sideBar.settings.nodeDraggable')}
            />

            <Separator className="bg-black/8 dark:bg-white/8" />

            <LabeledCheckBox
              checked={showEdgeLabel}
              onCheckedChange={setShowEdgeLabel}
              label={t('graphPanel.sideBar.settings.showEdgeLabel')}
            />
            <LabeledCheckBox
              checked={enableHideUnselectedEdges}
              onCheckedChange={setEnableHideUnselectedEdges}
              label={t('graphPanel.sideBar.settings.hideUnselectedEdges')}
            />
            <LabeledCheckBox
              checked={enableEdgeEvents}
              onCheckedChange={setEnableEdgeEvents}
              label={t('graphPanel.sideBar.settings.edgeEvents')}
            />

            <div className="flex flex-col gap-2 rounded-xl border border-black/6 bg-[#faf8f5] p-3 dark:border-white/8 dark:bg-white/4">
              <label htmlFor="edge-size-min" className="text-[13px] leading-5 font-medium text-[#31302e] peer-disabled:cursor-not-allowed peer-disabled:opacity-70 dark:text-white/85">
                {t('graphPanel.sideBar.settings.edgeSizeRange')}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id="edge-size-min"
                  type="number"
                  value={minEdgeSize}
                  onChange={(e) => {
                    const newValue = Number(e.target.value);
                    if (!isNaN(newValue) && newValue >= 1 && newValue <= maxEdgeSize) {
                      useSettingsStore.setState({ minEdgeSize: newValue });
                    }
                  }}
                  className="h-9 w-16 min-w-0 rounded-xl border-black/10 bg-white pr-1 shadow-none dark:border-white/10 dark:bg-white/8"
                  min={1}
                  max={Math.min(maxEdgeSize, 10)}
                />
                <span>-</span>
                <div className="flex items-center gap-1">
                  <Input
                    id="edge-size-max"
                    type="number"
                    value={maxEdgeSize}
                    onChange={(e) => {
                      const newValue = Number(e.target.value);
                      if (!isNaN(newValue) && newValue >= minEdgeSize && newValue >= 1 && newValue <= 10) {
                        useSettingsStore.setState({ maxEdgeSize: newValue });
                      }
                    }}
                    className="h-9 w-16 min-w-0 rounded-xl border-black/10 bg-white pr-1 shadow-none dark:border-white/10 dark:bg-white/8"
                    min={minEdgeSize}
                    max={10}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 flex-shrink-0 rounded-xl border border-black/10 bg-white text-[#766f69] hover:bg-[#f6f5f4] hover:text-[#1f1e1c] dark:border-white/10 dark:bg-white/8 dark:text-white/65 dark:hover:bg-white/12 dark:hover:text-white"
                    onClick={() => useSettingsStore.setState({ minEdgeSize: 1, maxEdgeSize: 5 })}
                    type="button"
                    title={t('graphPanel.sideBar.settings.resetToDefault')}
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>

            <Separator className="bg-black/8 dark:bg-white/8" />
            <LabeledNumberInput
              label={t('graphPanel.sideBar.settings.maxQueryDepth')}
              min={1}
              value={graphQueryMaxDepth}
              defaultValue={3}
              onEditFinished={setGraphQueryMaxDepth}
            />
            <LabeledNumberInput
              label={`${t('graphPanel.sideBar.settings.maxNodes')} (≤ ${backendMaxGraphNodes || 1000})`}
              min={1}
              max={backendMaxGraphNodes || 1000}
              value={graphMaxNodes}
              defaultValue={backendMaxGraphNodes || 1000}
              onEditFinished={setGraphMaxNodes}
            />
            <LabeledNumberInput
              label={t('graphPanel.sideBar.settings.maxLayoutIterations')}
              min={1}
              max={30}
              value={graphLayoutMaxIterations}
              defaultValue={15}
              onEditFinished={setGraphLayoutMaxIterations}
            />
            {/* Development/Testing Section - Only visible in development mode */}
            {import.meta.env.DEV && (
              <>
                <Separator className="bg-black/8 dark:bg-white/8" />

                <div className="flex flex-col gap-2">
                  <label className="text-[13px] leading-5 font-medium text-[#8a847e] uppercase tracking-[0.08em] dark:text-white/55">
                    Dev Options
                  </label>
                  <Button
                    onClick={handleGenerateRandomGraph}
                    variant="outline"
                    size="sm"
                    className="flex items-center gap-2 border-black/10 bg-white hover:bg-[#f6f5f4] dark:border-white/10 dark:bg-white/8 dark:hover:bg-white/12"
                  >
                    <Shuffle className="h-3.5 w-3.5" />
                    Gen Random Graph
                  </Button>
                </div>

                <Separator className="bg-black/8 dark:bg-white/8" />
              </>
            )}
            <Button
              onClick={saveSettings}
              variant="outline"
              size="sm"
              className="ml-auto border-black/10 bg-white px-4 hover:bg-[#f6f5f4] dark:border-white/10 dark:bg-white/8 dark:hover:bg-white/12"
            >
              {t('graphPanel.sideBar.settings.save')}
            </Button>

          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}
