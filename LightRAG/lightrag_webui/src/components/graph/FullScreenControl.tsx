import { useFullScreen } from '@react-sigma/core'
import { MaximizeIcon, MinimizeIcon } from 'lucide-react'
import { controlButtonVariant } from '@/lib/constants'
import Button from '@/components/ui/Button'
import { useTranslation } from 'react-i18next'

/**
 * Component that toggles full screen mode.
 */
const FullScreenControl = () => {
  const { isFullScreen, toggle } = useFullScreen()
  const { t } = useTranslation()
  const controlButtonClassName =
    'h-10 w-10 rounded-2xl border border-black/10 bg-white/92 text-[#615d59] shadow-none hover:bg-[#f6f5f4] hover:text-[#1f1e1c] dark:border-white/10 dark:bg-white/8 dark:text-white/80 dark:hover:bg-white/12'

  return (
    <>
      {isFullScreen ? (
        <Button
          variant={controlButtonVariant}
          onClick={toggle}
          tooltip={t('graphPanel.sideBar.fullScreenControl.windowed')}
          size="icon"
          className={controlButtonClassName}
        >
          <MinimizeIcon />
        </Button>
      ) : (
        <Button
          variant={controlButtonVariant}
          onClick={toggle}
          tooltip={t('graphPanel.sideBar.fullScreenControl.fullScreen')}
          size="icon"
          className={controlButtonClassName}
        >
          <MaximizeIcon />
        </Button>
      )}
    </>
  )
}

export default FullScreenControl
