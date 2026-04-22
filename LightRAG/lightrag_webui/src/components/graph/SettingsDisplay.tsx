import { useSettingsStore } from '@/stores/settings'
import { useTranslation } from 'react-i18next'

/**
 * Component that displays current values of important graph settings
 * Positioned to the right of the toolbar at the bottom-left corner
 */
const SettingsDisplay = () => {
  const { t } = useTranslation()
  const graphQueryMaxDepth = useSettingsStore.use.graphQueryMaxDepth()
  const graphMaxNodes = useSettingsStore.use.graphMaxNodes()

  return (
    <div className="absolute bottom-4 left-[calc(1rem+4.25rem)] flex items-center gap-2 rounded-full border border-black/10 bg-white/82 px-3 py-1.5 text-xs font-medium text-[#766f69] shadow-[0_4px_18px_rgba(0,0,0,0.04),0_2.025px_7.84688px_rgba(0,0,0,0.027),0_0.8px_2.925px_rgba(0,0,0,0.02),0_0.175px_1.04062px_rgba(0,0,0,0.01)] backdrop-blur-xl dark:border-white/10 dark:bg-[#1f1c1a]/84 dark:text-white/70">
      <div>{t('graphPanel.sideBar.settings.depth')}: {graphQueryMaxDepth}</div>
      <div>{t('graphPanel.sideBar.settings.max')}: {graphMaxNodes}</div>
    </div>
  )
}

export default SettingsDisplay
