import React from 'react'
import { useTranslation } from 'react-i18next'
import { useGraphStore } from '@/stores/graph'
import { Card } from '@/components/ui/Card'
import { ScrollArea } from '@/components/ui/ScrollArea'

interface LegendProps {
  className?: string
}

const Legend: React.FC<LegendProps> = ({ className }) => {
  const { t } = useTranslation()
  const typeColorMap = useGraphStore.use.typeColorMap()

  if (!typeColorMap || typeColorMap.size === 0) {
    return null
  }

  return (
    <Card className={`max-w-xs rounded-[22px] border-black/10 p-3 shadow-[0_4px_18px_rgba(0,0,0,0.04),0_2.025px_7.84688px_rgba(0,0,0,0.027),0_0.8px_2.925px_rgba(0,0,0,0.02),0_0.175px_1.04062px_rgba(0,0,0,0.01)] ${className}`}>
      <h3 className="mb-3 text-[13px] font-semibold tracking-[0.12em] text-[#8a847e] uppercase dark:text-white/55">{t('graphPanel.legend')}</h3>
      <ScrollArea className="max-h-80">
        <div className="flex flex-col gap-2">
          {Array.from(typeColorMap.entries()).map(([type, color]) => (
            <div key={type} className="flex items-center gap-3 rounded-xl border border-black/6 bg-[#faf8f5] px-3 py-2 dark:border-white/8 dark:bg-white/4">
              <div
                className="h-4 w-4 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="truncate text-xs text-[#31302e] dark:text-white/85" title={type}>
                {t(`graphPanel.nodeTypes.${type.toLowerCase().replace(/\s+/g, '')}`, type)}
              </span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </Card>
  )
}

export default Legend
