// PPTX export utilities for AIPPT.
// Uses pptxgenjs for client-side generation and supports server-side export as fallback.

import type { StorylineSlide } from '@/utils/ai/prompts/storyline'

export interface ExportOptions {
  title: string
  slides: any[]
  getSlideVisualData: (index: number) => any
  themeStyle?: { color?: string; fontFamily?: string }
  onProgress?: (percent: number) => void
}

// ── Professional PPTX from AI storyline ──────────────────────

export async function exportProfessionalPPTX(
  title: string,
  storyline: StorylineSlide[],
  onProgress?: (percent: number) => void,
): Promise<void> {
  const pptxgen = await loadPptxGen()

  const ppt = new pptxgen()
  ppt.defineLayout({ name: 'WIDE', width: '13.333', height: '7.5' })
  ppt.layout = 'WIDE'
  ppt.author = 'AIPPT'
  ppt.title = title
  ppt.subject = title
  ppt.company = 'LaboFlow'

  const total = storyline.length

  for (let i = 0; i < total; i++) {
    const slide = storyline[i]
    const s = ppt.addSlide()

    switch (slide.type) {
      case 'cover': {
        s.background = { fill: '#0D1B2A' }
        s.addText(slide.data.title || title, {
          x: 0.8, y: 1.8, w: 11.7, h: 2.0,
          fontSize: 36, fontFace: 'Microsoft YaHei', color: 'FFFFFF',
          bold: true, align: 'center',
        })
        if (slide.data.subtitle) {
          s.addText(slide.data.subtitle, {
            x: 0.8, y: 3.8, w: 11.7, h: 0.8,
            fontSize: 16, fontFace: 'Microsoft YaHei', color: '8899AA',
            align: 'center',
          })
        }
        break
      }
      case 'section': {
        s.background = { fill: '#1B3A5C' }
        s.addText(slide.data.title || '', {
          x: 0.8, y: 2.5, w: 11.7, h: 1.5,
          fontSize: 28, fontFace: 'Microsoft YaHei', color: 'FFFFFF',
          bold: true, align: 'center',
        })
        if (slide.data.subtitle) {
          s.addText(slide.data.subtitle, {
            x: 0.8, y: 4.0, w: 11.7, h: 0.8,
            fontSize: 14, fontFace: 'Microsoft YaHei', color: '8899AA',
            align: 'center',
          })
        }
        break
      }
      case 'three_stat': {
        s.addText(slide.data.title || '', {
          x: 0.5, y: 0.3, w: 12.3, h: 0.7,
          fontSize: 22, fontFace: 'Microsoft YaHei', color: '1B3A5C',
          bold: true, align: 'left',
        })
        const items: any[] = slide.data.items || []
        const cols = Math.min(items.length, 3)
        const colW = 12.3 / cols
        items.forEach((item: any, j: number) => {
          s.addShape(ppt.ShapeType.roundRect, {
            x: 0.5 + j * colW + 0.2, y: 2.0, w: colW - 0.4, h: 3.5,
            fill: { color: item.color || '#006BA6' },
            rectRadius: 0.1,
          })
          s.addText(item.value || '', {
            x: 0.5 + j * colW + 0.2, y: 2.5, w: colW - 0.4, h: 1.5,
            fontSize: 32, fontFace: 'Arial', color: 'FFFFFF',
            bold: true, align: 'center',
          })
          s.addText(item.label || '', {
            x: 0.5 + j * colW + 0.2, y: 4.0, w: colW - 0.4, h: 1.0,
            fontSize: 14, fontFace: 'Microsoft YaHei', color: 'FFFFFF',
            align: 'center',
          })
        })
        break
      }
      case 'two_column_text': {
        s.addText(slide.data.title || '', {
          x: 0.5, y: 0.3, w: 12.3, h: 0.7,
          fontSize: 22, fontFace: 'Microsoft YaHei', color: '1B3A5C',
          bold: true, align: 'left',
        })
        s.addText(slide.data.left || '', {
          x: 0.5, y: 1.3, w: 5.8, h: 5.5,
          fontSize: 14, fontFace: 'Microsoft YaHei', color: '333333',
          align: 'left', valign: 'top', lineSpacingMultiple: 1.3,
        })
        s.addText(slide.data.right || '', {
          x: 7.0, y: 1.3, w: 5.8, h: 5.5,
          fontSize: 14, fontFace: 'Microsoft YaHei', color: '333333',
          align: 'left', valign: 'top', lineSpacingMultiple: 1.3,
        })
        // Divider line
        s.addShape(ppt.ShapeType.line, {
          x: 6.6, y: 1.3, w: 0, h: 5.5,
          line: { color: 'CCCCCC', width: 0.75 },
        })
        break
      }
      case 'bullets': {
        s.addText(slide.data.title || '', {
          x: 0.5, y: 0.3, w: 12.3, h: 0.7,
          fontSize: 22, fontFace: 'Microsoft YaHei', color: '1B3A5C',
          bold: true, align: 'left',
        })
        const bullets: string[] = slide.data.items || []
        const bulletText = bullets.map((b: string, j: number) => ({
          text: b,
          options: {
            fontSize: 16, fontFace: 'Microsoft YaHei', color: '333333',
            bullet: { code: '2022' }, lineSpacingMultiple: 1.4, breakType: 'after' as const,
          },
        }))
        s.addText(bulletText, {
          x: 0.8, y: 1.3, w: 11.7, h: 5.5,
          valign: 'top',
        })
        break
      }
      case 'closing': {
        s.background = { fill: '#0D1B2A' }
        s.addText(slide.data.title || '谢谢', {
          x: 0.8, y: 2.5, w: 11.7, h: 1.5,
          fontSize: 40, fontFace: 'Microsoft YaHei', color: 'FFFFFF',
          bold: true, align: 'center',
        })
        if (slide.data.message) {
          s.addText(slide.data.message, {
            x: 0.8, y: 4.2, w: 11.7, h: 0.8,
            fontSize: 14, fontFace: 'Microsoft YaHei', color: '8899AA',
            align: 'center',
          })
        }
        break
      }
      default: {
        s.addText(slide.data.title || slide.type, {
          x: 0.5, y: 0.3, w: 12.3, h: 0.7,
          fontSize: 22, fontFace: 'Microsoft YaHei', color: '1B3A5C',
          bold: true, align: 'left',
        })
      }
    }

    if (onProgress) onProgress(Math.round(((i + 1) / total) * 100))
  }

  await ppt.writeFile({ fileName: `${title}.pptx` })
}

// ── Server-side export ──────────────────────────────────────

export async function exportToPPTXViaServer(options: ExportOptions): Promise<void> {
  const resp = await fetch('/ppt/api/export/pptx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: options.title,
      slides: options.slides.map((s, i) => ({
        ...s,
        visualData: options.getSlideVisualData(i),
      })),
      themeStyle: options.themeStyle,
    }),
  })
  if (!resp.ok) {
    throw new Error(`Server export failed: ${resp.status} ${resp.statusText}`)
  }
  const blob = await resp.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${options.title}.pptx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Client-side export (fallback) ───────────────────────────

export async function exportToPPTX(options: ExportOptions): Promise<void> {
  const storyline: StorylineSlide[] = options.slides.map((slide, i) => {
    const vd = options.getSlideVisualData(i)
    const titleEl = vd.texts?.find((t: any) => (t.fontSize || 0) >= 20)
    const title = titleEl?.content || titleEl?.text || `Slide ${i + 1}`
    const bodyEls = vd.texts?.filter((t: any) => (t.fontSize || 0) < 20) || []
    const bodyText = bodyEls.map((t: any) => t.content || t.text || '').filter(Boolean).join('\n')

    if (i === 0) return { type: 'cover', data: { title, subtitle: bodyText } }
    if (i === options.slides.length - 1) return { type: 'closing', data: { title: '谢谢', message: title } }
    if (bodyText.split('\n').length <= 4) {
      return { type: 'bullets', data: { title, items: bodyText.split('\n').filter(Boolean) } }
    }
    return {
      type: 'two_column_text',
      data: {
        title,
        left: bodyText.split('\n').slice(0, Math.ceil(bodyText.split('\n').length / 2)).join('\n'),
        right: bodyText.split('\n').slice(Math.ceil(bodyText.split('\n').length / 2)).join('\n'),
      },
    }
  })

  await exportProfessionalPPTX(options.title, storyline, options.onProgress)
}

// ── Dynamic import of pptxgenjs ──────────────────────────────

let _pptxgen: any = null

async function loadPptxGen(): Promise<any> {
  if (_pptxgen) return _pptxgen
  const mod = await import('pptxgenjs')
  _pptxgen = mod.default || mod
  return _pptxgen
}
