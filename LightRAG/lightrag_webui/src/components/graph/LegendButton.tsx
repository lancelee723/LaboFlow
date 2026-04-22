import { useCallback } from 'react'
import { BookOpenIcon } from 'lucide-react'
import Button from '@/components/ui/Button'
import { controlButtonVariant } from '@/lib/constants'
import { useSettingsStore } from '@/stores/settings'
import { useTranslation } from 'react-i18next'

/**
 * Component that toggles legend visibility.
 */
const LegendButton = () => {
  const { t } = useTranslation()
  const showLegend = useSettingsStore.use.showLegend()
  const setShowLegend = useSettingsStore.use.setShowLegend()
  const controlButtonClassName =
    'h-10 w-10 rounded-2xl border border-black/10 bg-white/92 text-[#615d59] shadow-none hover:bg-[#f6f5f4] hover:text-[#1f1e1c] dark:border-white/10 dark:bg-white/8 dark:text-white/80 dark:hover:bg-white/12'

  const toggleLegend = useCallback(() => {
    setShowLegend(!showLegend)
  }, [showLegend, setShowLegend])

  return (
    <Button
      variant={controlButtonVariant}
      onClick={toggleLegend}
      tooltip={t('graphPanel.sideBar.legendControl.toggleLegend')}
      size="icon"
      className={controlButtonClassName}
    >
      <BookOpenIcon />
    </Button>
  )
}

export default LegendButton
