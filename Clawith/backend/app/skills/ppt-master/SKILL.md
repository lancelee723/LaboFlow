# PPT Master

AI-powered professional presentation generator. Outputs self-contained SVG slides for real-time browser rendering.

## When to Use

User asks to create, design, or generate a presentation/PPT/slides deck.

## How It Works

1. **Ask Direction**: Call `ask_direction` tool to present style/color/mood options as direction cards.
2. **Generate Slides**: After user chooses, call `generate_slides` tool with full SVG markup per slide.
3. **Iterate**: User can request changes; regenerate specific slides with updated SVG.
4. **Export**: Call `export_pptx` tool when user requests PPTX download (future capability).

## SVG Requirements

- Each slide is a complete `<svg viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">` element
- All fonts, colors, and layout are self-contained in the SVG
- Use the palette and fonts from user's direction choice
- Text must use `<text>` elements with proper `font-family`, `font-size`, `fill`
- Decorative shapes use `<rect>`, `<circle>`, `<path>`, `<line>`, `<polygon>`
- Images use `<image href="..." />` with placeholder URLs when needed
- Charts are built with native SVG shapes (bars = `<rect>`, lines = `<polyline>`, pie = `<path>` arcs)

## Slide Structure

- Slide 1: Cover — title, subtitle, date/presenter
- Slide 2: Agenda/Table of Contents
- Slides 3..N-1: Content slides (varied layouts)
- Slide N: Closing — thank you / contact / CTA

## Rules

- Always call `ask_direction` first before generating slides
- Always call `generate_slides` with the complete deck — never output raw SVG in chat text
- Maintain consistent palette and typography across all slides
- Ensure text is readable against background (minimum 4.5:1 contrast ratio)
- Each SVG slide must be valid, self-contained XML
