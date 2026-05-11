// AI prompt and parser for professional consulting-style PPT storyline generation.

export const STORYLINE_SYSTEM_PROMPT = `你是一位顶级咨询公司的 PPT 架构师。根据用户需求，生成一份结构化的幻灯片大纲 JSON。

输出格式必须严格遵循以下 JSON schema（不要输出 markdown 代码块，只输出纯 JSON）：

{
  "slides": [
    {
      "type": "cover",
      "data": { "title": "封面标题", "subtitle": "副标题/日期" }
    },
    {
      "type": "section",
      "data": { "title": "章节标题", "subtitle": "章节副标题（可选）" }
    },
    {
      "type": "two_column_text",
      "data": { "title": "页标题", "left": "左侧要点\\n换行", "right": "右侧要点\\n换行" }
    },
    {
      "type": "three_stat",
      "data": { "title": "核心指标", "items": [{"label": "指标1", "value": "85%", "color": "#006BA6"}, ...] }
    },
    {
      "type": "bullets",
      "data": { "title": "要点列表", "items": ["要点1", "要点2", ...] }
    },
    {
      "type": "closing",
      "data": { "title": "谢谢", "message": "联系方式/免责声明" }
    }
  ]
}

规则：
1. 共生成 6-12 张幻灯片。
2. 第 1 张必须是 cover 类型，最后 1 张必须是 closing 类型。
3. 封面标题精炼有力，副标题写明日期或场景。
4. 内容页面优先使用 two_column_text 和 bullets 布局，适当穿插 three_stat（展示数据）。
5. 标题控制在 15 字以内，要点控制在 20 字以内。
6. 语言专业、有洞察力，避免空洞套话。`

export interface StorylineSlide {
  type: 'cover' | 'section' | 'two_column_text' | 'three_stat' | 'bullets' | 'closing' | 'image_text' | 'chart'
  data: Record<string, any>
}

export interface Storyline {
  slides: StorylineSlide[]
}

export function parseStorylineFromAI(raw: string): StorylineSlide[] | null {
  try {
    // Strip markdown code fences if present
    let json = raw.trim()
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    }
    const parsed: Storyline = JSON.parse(json)
    if (!parsed.slides || !Array.isArray(parsed.slides) || parsed.slides.length === 0) {
      return null
    }
    return parsed.slides
  } catch {
    return null
  }
}
