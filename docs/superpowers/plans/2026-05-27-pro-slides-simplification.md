# Pro Slides Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Pro Slides daemon, connect the frontend directly to Clawith Agent Runtime via WebSocket, and replace iframe HTML rendering with direct SVG rendering.

**Architecture:** Pro Slides frontend (Next.js SPA) opens a WebSocket to Clawith backend's `/ws/chat/{ppt_agent_id}` endpoint. The PPT Agent (a hidden Clawith agent with `access_mode=private`) handles all LLM interaction and tool calls. The frontend renders SVG slides in a 1280×720 canvas instead of sandboxed iframes.

**Tech Stack:** Next.js 16, React 18, TypeScript, WebSocket (native), SVG (native browser), TailwindCSS 4

---

## File Structure

### New files to create
| File | Responsibility |
|------|----------------|
| `Pro Slides/apps/web/src/providers/clawith-ws.ts` | Clawith WebSocket provider — connection, auth, message format adaptation, reconnection |
| `Pro Slides/apps/web/src/providers/message-adapter.ts` | Maps Clawith WS events → existing frontend `AgentEvent` types |
| `Pro Slides/apps/web/src/components/SvgDeckViewer.tsx` | SVG deck renderer — canvas container, slide navigation, thumbnails, palette swap |
| `Pro Slides/apps/web/src/state/ppt-agent.ts` | PPT Agent state — agent ID resolution, session management |
| `Clawith/backend/app/services/agent_tools_ppt.py` | PPT-specific tools: `generate_slides`, `ask_direction`, `export_pptx` |
| `Clawith/backend/app/skills/ppt-master/` | PPT Agent skill files (soul.md, skill.json, prompt.md) |

### Files to modify
| File | Change |
|------|--------|
| `Pro Slides/apps/web/src/App.tsx` | Replace `daemon.ts` provider wiring with `ClawithWSProvider` |
| `Pro Slides/apps/web/src/components/ChatPane.tsx` | Adapt to consume Clawith WS events instead of daemon SSE events |
| `Pro Slides/apps/web/src/components/AssistantMessage.tsx` | Handle `tool_call` events for `generate_slides`, `ask_direction` |
| `Pro Slides/apps/web/src/components/FileViewer.tsx` | Replace iframe rendering with `SvgDeckViewer` |
| `Pro Slides/docker-compose.yml` | Remove daemon service, add `PPT_AGENT_ID` env var to pro-slides service |
| `Clawith/backend/app/services/agent_tools.py` | Register PPT tools when agent has `ppt` capability |
| `Clawith/backend/app/api/websocket.py` | Add `ask_direction` tool support (pause loop, wait for user answer) |
| `Clawith/backend/app/services/llm/caller.py` | Add `ask_direction` to the tool-calling loop's pause-and-wait mechanism |

### Files to delete
| File | Reason |
|------|--------|
| `Pro Slides/apps/daemon/` (entire directory) | Replaced by Clawith Agent Runtime |
| `Pro Slides/apps/web/src/providers/daemon.ts` | Replaced by `clawith-ws.ts` |
| `Pro Slides/apps/web/src/providers/sse.ts` | No longer using SSE |
| `Pro Slides/apps/web/src/providers/api-proxy.ts` | BYOK proxy no longer needed |
| `Pro Slides/apps/web/src/providers/anthropic.ts` | Direct SDK calls no longer needed |
| `Pro Slides/apps/web/src/providers/connection-test.ts` | Daemon connection test no longer needed |
| `Pro Slides/apps/web/src/runtime/srcdoc.ts` | Replaced by SVG rendering |

---

## Task 1: Add `ask_direction` Tool to Clawith Backend

The PPT Agent needs a way to pause mid-generation and ask the user to choose a direction (style/color). Clawith currently has no AskUserQuestion-style tool. We add one by leveraging the existing approval/wait mechanism.

**Files:**
- Create: `Clawith/backend/app/services/agent_tools_ppt.py`
- Modify: `Clawith/backend/app/services/agent_tools.py:1-50` (tool registration)
- Modify: `Clawith/backend/app/api/websocket.py:631-721` (tool_call flow)
- Modify: `Clawith/backend/app/services/llm/caller.py:277-385` (pause-and-wait)

- [ ] **Step 1: Write the `ask_direction` tool definition**

Create `Clawith/backend/app/services/agent_tools_ppt.py`:

```python
"""PPT-specific agent tools."""

import json
from typing import Any

# Tool definition for LLM function calling
ASK_DIRECTION_TOOL = {
    "type": "function",
    "function": {
        "name": "ask_direction",
        "description": (
            "Ask the user to choose a presentation direction. "
            "Present style/color/mood options as direction cards. "
            "The agent will pause until the user responds."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The question to ask the user.",
                },
                "cards": {
                    "type": "array",
                    "description": "Direction card options for the user to choose from.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "description": "Unique identifier for this card.",
                            },
                            "label": {
                                "type": "string",
                                "description": "Short label shown on the card.",
                            },
                            "mood": {
                                "type": "string",
                                "description": "Mood descriptor (e.g. 'Warm & Professional').",
                            },
                            "palette": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Color swatches as hex codes (3-5 colors).",
                            },
                            "display_font": {
                                "type": "string",
                                "description": "Display font name for preview.",
                            },
                            "body_font": {
                                "type": "string",
                                "description": "Body font name for preview.",
                            },
                            "references": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Optional reference URLs or names.",
                            },
                        },
                        "required": ["id", "label", "mood", "palette"],
                    },
                },
            },
            "required": ["question", "cards"],
        },
    },
}

GENERATE_SLIDES_TOOL = {
    "type": "function",
    "function": {
        "name": "generate_slides",
        "description": (
            "Output a complete slide deck as SVG. Each slide is a self-contained "
            "SVG element with viewBox='0 0 1280 720'. Call this tool when the "
            "full deck content is ready."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Deck title.",
                },
                "palette": {
                    "type": "object",
                    "description": "Color palette for the deck.",
                    "properties": {
                        "primary": {"type": "string"},
                        "secondary": {"type": "string"},
                        "accent": {"type": "string"},
                        "background": {"type": "string"},
                        "text": {"type": "string"},
                        "text_secondary": {"type": "string"},
                    },
                    "required": ["primary", "secondary", "accent", "background", "text", "text_secondary"],
                },
                "display_font": {
                    "type": "string",
                    "description": "Display/title font name.",
                },
                "body_font": {
                    "type": "string",
                    "description": "Body text font name.",
                },
                "slides": {
                    "type": "array",
                    "description": "Array of slide objects.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "svg": {
                                "type": "string",
                                "description": "Complete SVG markup for this slide.",
                            },
                            "note": {
                                "type": "string",
                                "description": "Speaker note for this slide.",
                            },
                        },
                        "required": ["id", "svg"],
                    },
                },
            },
            "required": ["title", "palette", "display_font", "body_font", "slides"],
        },
    },
}

EXPORT_PPTX_TOOL = {
    "type": "function",
    "function": {
        "name": "export_pptx",
        "description": "Export the current slide deck as a PPTX file.",
        "parameters": {
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "Output filename (without extension).",
                },
            },
            "required": ["filename"],
        },
    },
}

PPT_TOOLS = [ASK_DIRECTION_TOOL, GENERATE_SLIDES_TOOL, EXPORT_PPTX_TOOL]


async def execute_ask_direction(args: dict[str, Any], db, agent_id: str, user_id: str) -> str:
    """Execute ask_direction tool — returns the card data for the frontend.

    The actual waiting happens in the caller loop (see caller.py),
    which detects this tool and pauses for user input.
    """
    return json.dumps({
        "tool": "ask_direction",
        "question": args["question"],
        "cards": args["cards"],
    })


async def execute_generate_slides(args: dict[str, Any], db, agent_id: str, user_id: str) -> str:
    """Execute generate_slides tool — returns a confirmation."""
    # The SVG data is already in the args, we just confirm receipt.
    slide_count = len(args.get("slides", []))
    return json.dumps({
        "tool": "generate_slides",
        "slide_count": slide_count,
        "status": "received",
    })


async def execute_export_pptx(args: dict[str, Any], db, agent_id: str, user_id: str) -> str:
    """Execute export_pptx tool — placeholder for future PPTX generation."""
    return json.dumps({
        "tool": "export_pptx",
        "filename": args.get("filename", "presentation"),
        "status": "pending",
    })
```

- [ ] **Step 2: Register PPT tools in agent_tools.py**

Modify `Clawith/backend/app/services/agent_tools.py` — find the `execute_tool` function and add PPT tool dispatch. Find the `get_tools_for_llm` function and add PPT tools to the returned list when the agent has PPT capability.

Add at the top of `agent_tools.py`:
```python
from app.services.agent_tools_ppt import (
    PPT_TOOLS,
    execute_ask_direction,
    execute_generate_slides,
    execute_export_pptx,
)
```

In `execute_tool()`, add to the dispatch table:
```python
    elif tool_name == "ask_direction":
        return await execute_ask_direction(args, db, agent_id, user_id)
    elif tool_name == "generate_slides":
        return await execute_generate_slides(args, db, agent_id, user_id)
    elif tool_name == "export_pptx":
        return await execute_export_pptx(args, db, agent_id, user_id)
```

In `get_tools_for_llm()`, after loading agent tools from DB, append:
```python
    # Always include PPT tools for PPT agents (detected by agent name or skill)
    if agent and any(s.name == "ppt-master" for s in agent.skills):
        tools.extend(PPT_TOOLS)
```

- [ ] **Step 3: Add ask_direction pause-and-wait to the LLM caller loop**

Modify `Clawith/backend/app/services/llm/caller.py` in the `_process_tool_call` function. After calling `execute_tool`, check if the tool was `ask_direction`. If so, instead of appending the tool result to the conversation and continuing, pause the loop and wait for user input via WebSocket.

Find the section in `_process_tool_call` (around line 320-360) where tool results are collected. After `result = await execute_tool(...)`, add:

```python
        # --- Ask-direction pause mechanism ---
        if tool_name == "ask_direction":
            # Send the ask_direction result to the client as a tool_call event
            await on_tool_call({
                "name": "ask_direction",
                "call_id": tc.get("id", ""),
                "args": args,
                "status": "done",
                "result": result,
                "reasoning_content": full_reasoning_content,
            })
            # Signal to the outer loop that we need user input
            # The caller should raise a special exception that the
            # websocket handler catches, then waits for user message
            raise AskDirectionNeeded(result)
```

Add the exception class at the top of `caller.py`:
```python
class AskDirectionNeeded(Exception):
    """Raised when the agent asks the user for direction and needs to pause."""
    def __init__(self, direction_data: str):
        self.direction_data = direction_data
        super().__init__("Agent needs user direction input")
```

- [ ] **Step 4: Handle AskDirectionNeeded in the WebSocket handler**

Modify `Clawith/backend/app/api/websocket.py` in the main chat loop. Wrap the `call_llm_with_failover()` call in a try/except for `AskDirectionNeeded`. When caught, send the direction cards to the client, then wait for the user's next message (which will be their direction choice). On the next user message, resume the LLM call with the direction answer appended as a tool result.

Find the section where `call_llm_with_failover` is called (around line 400-500 in websocket.py). Wrap it:

```python
from app.services.llm.caller import AskDirectionNeeded

# In the main message loop:
try:
    result = await call_llm_with_failover(
        agent=agent,
        user_message=content,
        conversation=conversation,
        db=db,
        on_chunk=stream_to_ws,
        on_thinking=thinking_to_ws,
        on_tool_call=tool_call_to_ws,
        on_tool_delta=tool_delta_to_ws,
    )
except AskDirectionNeeded as e:
    # The tool_call event for ask_direction has already been sent
    # via on_tool_call callback. Now we just go back to waiting
    # for the next user message. The user's choice will arrive
    # as a normal text message. We'll treat it as a tool_result
    # continuation.
    # Store the pending direction state on the session:
    session_pending_direction = {
        "call_id": last_ask_direction_call_id,
        "direction_data": e.direction_data,
    }
    # Don't send a "done" event — the turn is NOT complete.
    # The client should show the direction cards and wait.
    continue  # Back to the top of the message loop
```

When the user sends their next message (choosing a direction), detect `session_pending_direction` and feed the user's choice as a `tool_result` back into the LLM loop:

```python
# At the top of the message loop, after receiving user message:
if session_pending_direction:
    # User chose a direction — feed it as a tool result
    conversation.append({
        "role": "assistant",
        "tool_calls": [{
            "id": session_pending_direction["call_id"],
            "type": "function",
            "function": {"name": "ask_direction", "arguments": json.dumps(last_ask_direction_args)},
        }],
    })
    conversation.append({
        "role": "tool",
        "tool_call_id": session_pending_direction["call_id"],
        "content": user_message_content,  # The user's direction choice
    })
    session_pending_direction = None
    # Now call LLM again to continue generation
    # (the loop will continue naturally)
```

- [ ] **Step 5: Commit**

```bash
git add Clawith/backend/app/services/agent_tools_ppt.py Clawith/backend/app/services/agent_tools.py Clawith/backend/app/services/llm/caller.py Clawith/backend/app/api/websocket.py
git commit -m "feat(clawith): add PPT tools — ask_direction, generate_slides, export_pptx"
```

---

## Task 2: Create PPT Agent Skill Files

Create the skill files that define the PPT Agent's behavior in Clawith's workspace directory.

**Files:**
- Create: `Clawith/backend/app/skills/ppt-master/skill.json`
- Create: `Clawith/backend/app/skills/ppt-master/SKILL.md`
- Create: `Clawith/backend/app/skills/ppt-master/prompt.md`

- [ ] **Step 1: Create skill.json**

Create `Clawith/backend/app/skills/ppt-master/skill.json`:

```json
{
  "name": "ppt-master",
  "version": "1.0.0",
  "description": "AI-powered professional presentation generator. Outputs SVG slides with real-time rendering.",
  "inputs": [
    { "name": "topic", "type": "string", "required": true, "description": "Presentation topic" },
    { "name": "slides_count", "type": "number", "default": 10, "description": "Target number of slides" },
    { "name": "style", "type": "string", "enum": ["corporate", "minimal", "creative", "editorial"], "default": "corporate" },
    { "name": "language", "type": "string", "enum": ["zh-CN", "en-US"], "default": "zh-CN" }
  ],
  "outputs": [
    { "kind": "svg-deck", "renderer": "svg-deck" }
  ]
}
```

- [ ] **Step 2: Create SKILL.md**

Create `Clawith/backend/app/skills/ppt-master/SKILL.md`:

```markdown
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
```

- [ ] **Step 3: Create prompt.md**

Create `Clawith/backend/app/skills/ppt-master/prompt.md`:

```markdown
You are a professional presentation designer. You create beautiful, production-quality slide decks.

## Workflow

When a user asks for a presentation:

1. **Understand the topic**: Clarify the purpose, audience, and key points if not obvious.
2. **Ask direction**: Call the `ask_direction` tool to present 3-4 style options with different palettes, fonts, and moods. Wait for the user to choose.
3. **Plan slides**: Outline the slide structure (cover → agenda → content → closing). Decide layout variety.
4. **Generate slides**: Call the `generate_slides` tool with complete SVG for each slide.
5. **Iterate**: If the user requests changes, regenerate specific slides or the full deck.

## SVG Design Principles

- **ViewBox**: Always `0 0 1280 720` (16:9 aspect ratio)
- **Typography**: Use 1 display font (titles) + 1 body font. Hierarchy: title 48-56px, subtitle 28-32px, body 18-22px, caption 14-16px
- **Color**: Use the palette from the user's direction choice. Apply palette.primary for accents/CTAs, palette.background for slide backgrounds, palette.text for body copy
- **Whitespace**: Leave generous margins (80px minimum on all sides). Don't cram.
- **Alignment**: Use consistent alignment. Left-align body text. Center-align cover titles.
- **Visual variety**: Alternate between text-heavy slides, data/chart slides, and visual/hero slides. No two consecutive slides should feel identical.
- **Decorations**: Use geometric shapes (circles, lines, angled dividers) as accent elements. Keep them subtle.
- **Charts**: Build with native SVG — bar charts with `<rect>`, line charts with `<polyline>`, pie charts with arc `<path>`s. Include axis labels and legends.

## Common Slide Layouts (not exhaustive — you decide what fits)

- **Cover**: Large title centered, subtitle below, decorative accent shape
- **Section divider**: One big title, horizontal rule, optional subtitle
- **Bullets**: Title top, 3-5 bullet points with icons or markers
- **Two-column**: Title top, two columns of content side by side
- **Big stat**: One large number + label, supporting text below
- **Quote**: Large italicized quote, attribution below
- **Chart + text**: Chart on one side, key insight on the other
- **Image hero**: Full-bleed image placeholder, title overlay
- **Timeline**: Horizontal line with milestone nodes
- **Comparison**: Two columns with opposing points
- **Closing**: "Thank you" or CTA, contact info

Remember: you are NOT limited to these layouts. Use any SVG composition that serves the content well.

## Quality Checks

Before calling `generate_slides`:
- Every `<text>` element has explicit `font-family`, `font-size`, `fill`
- No overlapping text (verify with 1280×720 viewBox)
- Palette colors are used consistently
- Each slide has visual interest — no plain white slides
- Speaker notes are provided for each slide

When done, call `finish` with a brief summary of the deck.
```

- [ ] **Step 4: Commit**

```bash
git add Clawith/backend/app/skills/ppt-master/
git commit -m "feat(clawith): add ppt-master skill with SVG generation prompt"
```

---

## Task 3: Create `ClawithWSProvider` in Pro Slides Frontend

Replace the daemon.ts provider with a WebSocket-based provider that talks to Clawith.

**Files:**
- Create: `Pro Slides/apps/web/src/providers/clawith-ws.ts`
- Create: `Pro Slides/apps/web/src/providers/message-adapter.ts`

- [ ] **Step 1: Create message-adapter.ts**

This module maps Clawith WebSocket events to the existing `PersistedAgentEvent` types that the frontend components already consume.

Create `Pro Slides/apps/web/src/providers/message-adapter.ts`:

```typescript
import type { PersistedAgentEvent } from "@open-design/contracts";

/**
 * Clawith WebSocket server-to-client message types.
 * See Clawith/backend/app/api/websocket.py for authoritative definitions.
 */
export type ClawithWsMessage =
  | { type: "connected"; session_id: string }
  | { type: "error"; content: string }
  | { type: "chunk"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; call_id: string; args: Record<string, unknown>; status: "running" | "done"; result?: string; reasoning_content?: string | null; live_preview?: unknown; workspace_activity?: unknown }
  | { type: "workspace_draft"; id: string; index: number; name: string; arguments: string }
  | { type: "agentbay_live"; env: string; output: string; stream: string }
  | { type: "done"; role: "assistant"; content: string }
  | { type: "info"; content: string }
  | { type: "onboarded"; agent_id: string };

/**
 * Adapt a Clawith WS message into the PersistedAgentEvent format
 * that the Pro Slides frontend already uses.
 */
export function adaptClawithEvent(msg: ClawithWsMessage): PersistedAgentEvent | null {
  switch (msg.type) {
    case "chunk":
      return { kind: "text", text: msg.content };

    case "thinking":
      return { kind: "thinking", text: msg.content };

    case "tool_call":
      if (msg.status === "done" && msg.result) {
        // Parse tool results for PPT-specific tools
        try {
          const result = JSON.parse(msg.result);
          if (result.tool === "ask_direction") {
            return {
              kind: "tool_use",
              id: msg.call_id,
              name: "ask_direction",
              input: { question: result.question, cards: result.cards },
            };
          }
          if (result.tool === "generate_slides") {
            return {
              kind: "live_artifact",
              action: "updated",
              projectId: "",
              artifactId: `slides-${Date.now()}`,
              title: "Presentation",
              refreshStatus: undefined,
            };
          }
        } catch {
          // Not JSON or not a PPT tool — fall through
        }
        return {
          kind: "tool_result",
          toolUseId: msg.call_id,
          content: msg.result,
          isError: false,
        };
      }
      // Running status
      return {
        kind: "tool_use",
        id: msg.call_id,
        name: msg.name,
        input: msg.args,
      };

    case "done":
      return { kind: "text", text: msg.content };

    case "info":
      return { kind: "status", label: msg.content };

    case "error":
      return { kind: "text", text: `Error: ${msg.content}` };

    default:
      return null;
  }
}

/**
 * Extract SVG slide data from a generate_slides tool_call message.
 * Returns null if the message is not a completed generate_slides call.
 */
export function extractSlidesFromToolCall(msg: ClawithWsMessage): SlideDeck | null {
  if (msg.type !== "tool_call" || msg.name !== "generate_slides" || msg.status !== "done" || !msg.result) {
    return null;
  }
  try {
    const result = JSON.parse(msg.result);
    if (result.tool === "generate_slides") {
      // The actual slide data is in the args, not the result.
      // We need to look at msg.args which contains the full generate_slides input.
      return null; // Will be extracted from args instead
    }
  } catch {
    // ignore
  }
  return null;
}

export interface SlideDeck {
  title: string;
  palette: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    text_secondary: string;
  };
  displayFont: string;
  bodyFont: string;
  slides: Array<{
    id: string;
    svg: string;
    note?: string;
  }>;
}

/**
 * Extract a SlideDeck from the args of a generate_slides tool_call.
 */
export function extractSlidesFromArgs(args: Record<string, unknown>): SlideDeck | null {
  if (!args || !args.slides || !Array.isArray(args.slides)) return null;
  return {
    title: (args.title as string) || "Untitled",
    palette: args.palette as SlideDeck["palette"],
    displayFont: (args.display_font as string) || "Inter",
    bodyFont: (args.body_font as string) || "Inter",
    slides: (args.slides as Array<{ id: string; svg: string; note?: string }>),
  };
}

/**
 * Extract direction cards from an ask_direction tool_call.
 */
export interface DirectionCard {
  id: string;
  label: string;
  mood: string;
  palette: string[];
  display_font?: string;
  body_font?: string;
  references?: string[];
}

export interface AskDirectionData {
  question: string;
  cards: DirectionCard[];
}

export function extractDirectionCards(msg: ClawithWsMessage): AskDirectionData | null {
  if (msg.type !== "tool_call" || msg.name !== "ask_direction" || msg.status !== "done" || !msg.result) {
    return null;
  }
  try {
    const result = JSON.parse(msg.result);
    if (result.tool === "ask_direction") {
      return {
        question: result.question,
        cards: result.cards,
      };
    }
  } catch {
    // ignore
  }
  return null;
}
```

- [ ] **Step 2: Create clawith-ws.ts**

Create `Pro Slides/apps/web/src/providers/clawith-ws.ts`:

```typescript
import { adaptClawithEvent, type ClawithWsMessage, extractSlidesFromArgs, extractDirectionCards, type SlideDeck, type AskDirectionData } from "./message-adapter";

const RECONNECT_DELAY_MS = 3000;

export interface ClawithWSHandlers {
  onEvent: (event: unknown) => void;
  onSlidesGenerated: (deck: SlideDeck) => void;
  onDirectionCards: (data: AskDirectionData) => void;
  onDone: (content: string) => void;
  onError: (error: string) => void;
  onConnected: (sessionId: string) => void;
}

export interface ClawithWSOptions {
  agentId: string;
  token: string;
  handlers: ClawithWSHandlers;
  sessionId?: string;
  lang?: string;
}

/**
 * ClawithWSProvider manages a WebSocket connection to the Clawith Agent Runtime.
 *
 * Key considerations:
 * - Connects to /ws/chat/{agent_id} on the SAME origin (host:3008)
 * - Uses the /ws path which is proxied by Nginx with WebSocket upgrade support
 * - Does NOT use /ppt/ws or /ppt/api/ws (those paths lack WS upgrade support in Nginx)
 * - Carries JWT token as query parameter for authentication
 */
export class ClawithWSProvider {
  private ws: WebSocket | null = null;
  private agentId: string;
  private token: string;
  private handlers: ClawithWSHandlers;
  private sessionId?: string;
  private lang?: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private _currentDeck: SlideDeck | null = null;

  constructor(private options: ClawithWSOptions) {
    this.agentId = options.agentId;
    this.token = options.token;
    this.handlers = options.handlers;
    this.sessionId = options.sessionId;
    this.lang = options.lang;
  }

  get currentDeck(): SlideDeck | null {
    return this._currentDeck;
  }

  /**
   * Build the WebSocket URL.
   *
   * CRITICAL: We use the /ws path (not /ppt/ws) because:
   * - Nginx proxies /ws → clawith-backend:8000 with WS upgrade headers
   * - /ppt/api/ does NOT have WS upgrade support in Nginx config
   * - The browser connects to the same origin (host:3008) regardless of the frontend path
   */
  private buildWsUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const params = new URLSearchParams({ token: this.token });
    if (this.sessionId) params.set("session_id", this.sessionId);
    if (this.lang) params.set("lang", this.lang);
    return `${protocol}//${host}/ws/chat/${this.agentId}?${params.toString()}`;
  }

  connect(): void {
    if (this.disposed) return;
    const url = this.buildWsUrl();
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      // Connection established — will receive "connected" message from server
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ClawithWsMessage = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (err) {
        console.error("[ClawithWS] Failed to parse message:", err);
      }
    };

    this.ws.onclose = () => {
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error("[ClawithWS] WebSocket error:", err);
      this.handlers.onError("WebSocket connection error");
    };
  }

  private handleMessage(msg: ClawithWsMessage): void {
    switch (msg.type) {
      case "connected":
        this.sessionId = msg.session_id;
        this.handlers.onConnected(msg.session_id);
        break;

      case "chunk":
      case "thinking":
      case "info":
      case "error":
      case "done": {
        const adapted = adaptClawithEvent(msg);
        if (adapted) {
          this.handlers.onEvent(adapted);
        }
        if (msg.type === "done") {
          this.handlers.onDone(msg.content);
        }
        if (msg.type === "error") {
          this.handlers.onError(msg.content);
        }
        break;
      }

      case "tool_call": {
        // Check for PPT-specific tools
        const directionData = extractDirectionCards(msg);
        if (directionData) {
          this.handlers.onDirectionCards(directionData);
        }

        // Check for generate_slides — extract deck from args
        if (msg.name === "generate_slides" && msg.status === "done" && msg.args) {
          const deck = extractSlidesFromArgs(msg.args);
          if (deck) {
            this._currentDeck = deck;
            this.handlers.onSlidesGenerated(deck);
          }
        }

        // Also emit as generic event for the chat UI
        const adapted = adaptClawithEvent(msg);
        if (adapted) {
          this.handlers.onEvent(adapted);
        }
        break;
      }

      default:
        // Unknown message type — ignore
        break;
    }
  }

  sendMessage(content: string, fileName?: string, modelId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.handlers.onError("WebSocket not connected");
      return;
    }
    const msg: Record<string, unknown> = { content };
    if (fileName) msg.file_name = fileName;
    if (modelId) msg.model_id = modelId;
    this.ws.send(JSON.stringify(msg));
  }

  sendDirectionChoice(cardId: string, label: string): void {
    // When user picks a direction card, send it as a normal chat message
    // The Clawith WS handler will feed it as a tool_result for the pending ask_direction
    this.sendMessage(`我选择「${label}」方向 (id: ${cardId})`);
  }

  abort(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "abort" }));
    }
  }

  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, RECONNECT_DELAY_MS);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add "Pro Slides/apps/web/src/providers/clawith-ws.ts" "Pro Slides/apps/web/src/providers/message-adapter.ts"
git commit -m "feat(pro-slides): add ClawithWSProvider and message adapter"
```

---

## Task 4: Create `SvgDeckViewer` Component

Replace the iframe-based FileViewer with a component that renders SVG slides in a 1280×720 canvas.

**Files:**
- Create: `Pro Slides/apps/web/src/components/SvgDeckViewer.tsx`

- [ ] **Step 1: Create SvgDeckViewer.tsx**

Create `Pro Slides/apps/web/src/components/SvgDeckViewer.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SlideDeck } from "../providers/message-adapter";

interface SvgDeckViewerProps {
  deck: SlideDeck;
  currentSlideIndex: number;
  onSlideChange: (index: number) => void;
  className?: string;
}

/**
 * Renders a SlideDeck as inline SVG with navigation and thumbnails.
 *
 * - Main canvas: 1280×720 viewBox, CSS-scaled to fit container
 * - Thumbnails: rendered off-screen, captured as data URLs
 * - Palette swap: replaces palette colors in SVG strings on the fly
 */
export function SvgDeckViewer({
  deck,
  currentSlideIndex,
  onSlideChange,
  className,
}: SvgDeckViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map());
  const thumbnailCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const currentSlide = deck.slides[currentSlideIndex];
  const totalSlides = deck.slides.length;

  // Generate thumbnails by rendering SVG to a hidden canvas
  useEffect(() => {
    const generateThumbnails = async () => {
      const newThumbnails = new Map<number, string>();
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      for (let i = 0; i < deck.slides.length; i++) {
        const slide = deck.slides[i];
        const blob = new Blob([slide.svg], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.crossOrigin = "anonymous";

        await new Promise<void>((resolve) => {
          img.onload = () => {
            ctx.clearRect(0, 0, 320, 180);
            ctx.drawImage(img, 0, 0, 320, 180);
            newThumbnails.set(i, canvas.toDataURL("image/png"));
            URL.revokeObjectURL(url);
            resolve();
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          img.src = url;
        });
      }

      setThumbnails(newThumbnails);
    };

    generateThumbnails();
  }, [deck]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        onSlideChange(Math.min(currentSlideIndex + 1, totalSlides - 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onSlideChange(Math.max(currentSlideIndex - 1, 0));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentSlideIndex, totalSlides, onSlideChange]);

  const handlePrev = useCallback(() => {
    onSlideChange(Math.max(currentSlideIndex - 1, 0));
  }, [currentSlideIndex, onSlideChange]);

  const handleNext = useCallback(() => {
    onSlideChange(Math.min(currentSlideIndex + 1, totalSlides - 1));
  }, [currentSlideIndex, totalSlides, onSlideChange]);

  return (
    <div className={`flex h-full ${className ?? ""}`}>
      {/* Main slide canvas */}
      <div ref={containerRef} className="flex-1 flex items-center justify-center bg-gray-100 dark:bg-gray-900 p-4">
        {currentSlide ? (
          <div
            className="relative w-full max-w-[1280px] aspect-[16/9] shadow-2xl"
            dangerouslySetInnerHTML={{ __html: currentSlide.svg }}
          />
        ) : (
          <div className="text-gray-400 text-lg">No slides yet</div>
        )}
      </div>

      {/* Sidebar with navigation and thumbnails */}
      <div className="w-48 border-l border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-gray-800">
        {/* Slide counter */}
        <div className="p-3 text-sm text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
          {currentSlideIndex + 1} / {totalSlides}
        </div>

        {/* Prev/Next buttons */}
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={handlePrev}
            disabled={currentSlideIndex === 0}
            className="flex-1 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ← Prev
          </button>
          <button
            onClick={handleNext}
            disabled={currentSlideIndex === totalSlides - 1}
            className="flex-1 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next →
          </button>
        </div>

        {/* Thumbnail list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {deck.slides.map((slide, idx) => (
            <button
              key={slide.id}
              onClick={() => onSlideChange(idx)}
              className={`w-full rounded border-2 transition-colors ${
                idx === currentSlideIndex
                  ? "border-blue-500 ring-1 ring-blue-500"
                  : "border-transparent hover:border-gray-300 dark:hover:border-gray-600"
              }`}
            >
              {thumbnails.has(idx) ? (
                <img
                  src={thumbnails.get(idx)}
                  alt={`Slide ${idx + 1}`}
                  className="w-full aspect-[16/9] object-cover rounded"
                />
              ) : (
                <div className="w-full aspect-[16/9] bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "Pro Slides/apps/web/src/components/SvgDeckViewer.tsx"
git commit -m "feat(pro-slides): add SvgDeckViewer component for SVG slide rendering"
```

---

## Task 5: Wire `ClawithWSProvider` into `App.tsx`

Replace the daemon provider wiring in the root App component.

**Files:**
- Modify: `Pro Slides/apps/web/src/App.tsx` (provider wiring section, around line 100-200)

- [ ] **Step 1: Read the current App.tsx to find exact daemon wiring code**

Read `Pro Slides/apps/web/src/App.tsx` and locate where `daemon.ts` functions are imported and used. Key areas:
- Import statements for daemon functions
- Bootstrap effect that calls daemon health check
- Chat send handler that calls `streamViaDaemon`
- How `ChatMessage` events are managed

This step requires reading the file to find the exact code. The engineer should:
```bash
# Search for daemon imports
grep -n "from.*daemon" "Pro Slides/apps/web/src/App.tsx"
grep -n "streamViaDaemon" "Pro Slides/apps/web/src/App.tsx"
grep -n "fetchDaemon" "Pro Slides/apps/web/src/App.tsx"
```

- [ ] **Step 2: Replace daemon imports with ClawithWSProvider**

Find and replace the daemon import block. It will look something like:
```typescript
import { streamViaDaemon, submitChatRunToolResult, ... } from "./providers/daemon";
```

Replace with:
```typescript
import { ClawithWSProvider, type ClawithWSHandlers } from "./providers/clawith-ws";
import type { SlideDeck, AskDirectionData } from "./providers/message-adapter";
```

- [ ] **Step 3: Replace daemon state with ClawithWSProvider state**

In the App component, replace daemon-related state:
```typescript
// Remove:
// const [daemonLive, setDaemonLive] = useState(false);
// const [daemonConfig, setDaemonConfig] = useState<DaemonConfig | null>(null);

// Add:
const wsRef = useRef<ClawithWSProvider | null>(null);
const[wsConnected, setWsConnected] = useState(false);
const [currentDeck, setCurrentDeck] = useState<SlideDeck | null>(null);
const [directionData, setDirectionData] = useState<AskDirectionData | null>(null);
const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
```

- [ ] **Step 4: Replace daemon bootstrap with WS connection**

Find the bootstrap `useEffect` and replace:
```typescript
// Remove the daemon health check + fan-out fetch logic
// Replace with:

useEffect(() => {
  const token = getSSOSession()?.token;
  if (!token || !pptAgentId) return;

  const handlers: ClawithWSHandlers = {
    onEvent: (event) => {
      // Append to current assistant message events
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant" && last.events) {
          last.events = [...last.events, event];
        }
        return updated;
      });
    },
    onSlidesGenerated: (deck) => {
      setCurrentDeck(deck);
      setCurrentSlideIndex(0);
    },
    onDirectionCards: (data) => {
      setDirectionData(data);
    },
    onDone: (content) => {
      setStreaming(false);
    },
    onError: (error) => {
      setError(error);
      setStreaming(false);
    },
    onConnected: (sessionId) => {
      setWsConnected(true);
    },
  };

  const ws = new ClawithWSProvider({
    agentId: pptAgentId,
    token,
    handlers,
  });
  ws.connect();
  wsRef.current = ws;

  return () => {
    ws.disconnect();
  };
}, [pptAgentId]);
```

- [ ] **Step 5: Replace chat send handler**

Find the `onSend` handler and replace the `streamViaDaemon` call with:
```typescript
const handleSend = useCallback((content: string, attachments?: string[], commentAttachments?: unknown[], meta?: unknown) => {
  if (!wsRef.current) return;
  setStreaming(true);
  setError(null);
  setDirectionData(null);

  // Add user message to chat
  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content,
    createdAt: Date.now(),
  };
  setMessages((prev) => [...prev, userMsg]);

  // Create placeholder assistant message
  const assistantMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    events: [],
    createdAt: Date.now(),
  };
  setMessages((prev) => [...prev, assistantMsg]);

  wsRef.current.sendMessage(content);
}, []);
```

- [ ] **Step 6: Add direction choice handler**

```typescript
const handleDirectionChoice = useCallback((cardId: string, label: string) => {
  if (!wsRef.current) return;
  setDirectionData(null);
  wsRef.current.sendDirectionChoice(cardId, label);
}, []);
```

- [ ] **Step 7: Commit**

```bash
git add "Pro Slides/apps/web/src/App.tsx"
git commit -m "feat(pro-slides): wire ClawithWSProvider into App.tsx, replacing daemon"
```

---

## Task 6: Update ChatPane and AssistantMessage for Clawith Events

Adapt the chat UI components to handle Clawith WebSocket events and render direction cards.

**Files:**
- Modify: `Pro Slides/apps/web/src/components/ChatPane.tsx`
- Modify: `Pro Slides/apps/web/src/components/AssistantMessage.tsx`

- [ ] **Step 1: Read ChatPane.tsx to understand the current onSend flow**

```bash
grep -n "onSend\|onSubmitForm\|onStop\|streaming" "Pro Slides/apps/web/src/components/ChatPane.tsx" | head -30
```

- [ ] **Step 2: Pass direction card handler through ChatPane**

In ChatPane's Props interface, add:
```typescript
onDirectionChoice?: (cardId: string, label: string) => void;
directionData?: AskDirectionData | null;
```

And pass these through to AssistantMessage where direction cards are rendered.

- [ ] **Step 3: Render direction cards in AssistantMessage**

In AssistantMessage, when processing tool_use events, check if the tool is `ask_direction`. If so, render the existing `QuestionFormView` component with the direction cards data, using the `direction-cards` question type format:

```tsx
// Inside the Block rendering logic, when encountering an ask_direction tool_use:
if (block.kind === "tool-use" && block.name === "ask_direction") {
  return (
    <QuestionFormView
      form={{
        type: "direction-cards",
        question: directionData?.question ?? "",
        cards: directionData?.cards ?? [],
      }}
      interactive={!block.submitted}
      onSubmit={(text, answers) => {
        onDirectionChoice?.(
          Object.values(answers)[0] as string,
          block.label ?? ""
        );
      }}
    />
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add "Pro Slides/apps/web/src/components/ChatPane.tsx" "Pro Slides/apps/web/src/components/AssistantMessage.tsx"
git commit -m "feat(pro-slides): adapt ChatPane/AssistantMessage for Clawith events and direction cards"
```

---

## Task 7: Replace FileViewer iframe rendering with SvgDeckViewer

Switch the main file preview from iframe srcdoc to the SVG canvas.

**Files:**
- Modify: `Pro Slides/apps/web/src/components/FileViewer.tsx`

- [ ] **Step 1: Read FileViewer.tsx to find iframe rendering code**

```bash
grep -n "iframe\|srcdoc\|buildSrcdoc\|buildLazySrcdocTransport\|renderArtifacts" "Pro Slides/apps/web/src/components/FileViewer.tsx" | head -30
```

- [ ] **Step 2: Add SvgDeckViewer as a rendering path**

In FileViewer, add a conditional: when the current file/artifact is a slide deck (detected by the presence of `currentDeck` from App state), render `SvgDeckViewer` instead of the iframe:

```tsx
import { SvgDeckViewer } from "./SvgDeckViewer";
// ...
// In the render logic, before the iframe:
if (currentDeck && viewMode === "deck") {
  return (
    <SvgDeckViewer
      deck={currentDeck}
      currentSlideIndex={currentSlideIndex}
      onSlideChange={setCurrentSlideIndex}
      className="h-full"
    />
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add "Pro Slides/apps/web/src/components/FileViewer.tsx"
git commit -m "feat(pro-slides): render slide decks with SvgDeckViewer instead of iframe"
```

---

## Task 8: Update Docker Compose and Nginx Config

Remove the daemon service from docker-compose, add `PPT_AGENT_ID` env var, and keep Nginx config unchanged (we confirmed `/ws` path already has WS support).

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Read docker-compose.yml to find pro-slides service definition**

```bash
grep -n "pro-slides\|PPT_AGENT_ID" docker-compose.yml
```

- [ ] **Step 2: Modify pro-slides service in docker-compose.yml**

The current pro-slides service builds from `"./Pro Slides"` and runs `node apps/daemon/dist/cli.js --no-open`. After removing the daemon:

```yaml
  pro-slides:
    build:
      context: "./Pro Slides"
      dockerfile: apps/web/Dockerfile
    ports:
      - "7456"
    environment:
      - JWT_SECRET_KEY=${JWT_SECRET_KEY}
      - PPT_AGENT_ID=${PPT_AGENT_ID}
      - NEXT_PUBLIC_PPT_AGENT_ID=${PPT_AGENT_ID}
    labels:
      - "traefik.enable=false"
```

Note: We need a simple static file server for the Next.js export. Options:
- Use a lightweight nginx in the pro-slides container
- Or use the existing top-level nginx to serve the static files directly

The simplest approach: keep the pro-slides Dockerfile but change it to serve the static export with a tiny HTTP server (e.g., `serve` package or a 10-line node script).

- [ ] **Step 3: Create a minimal static server**

Create `Pro Slides/apps/web/serve.js`:

```javascript
const { createServer } = require("http");
const { readFile } = require("fs/promises");
const { join, extname } = require("path");

const PORT = parseInt(process.env.PORT || "7456", 10);
const DIR = join(__dirname, "out");

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

createServer(async (req, res) => {
  let path = join(DIR, req.url.split("?")[0]);
  if (path.endsWith("/")) path += "index.html";
  try {
    const data = await readFile(path);
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(PORT, () => console.log(`Serving ${DIR} on :${PORT}`));
```

- [ ] **Step 4: Update pro-slides Dockerfile**

Modify `Pro Slides/Dockerfile` to build the Next.js static export and run the minimal server instead of the daemon. The key change: replace the daemon entry point with the static server.

Find the existing Dockerfile and modify the final stage:
```dockerfile
# ... build stage stays the same ...

# Production stage
FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/apps/web/out ./out
COPY apps/web/serve.js ./
ENV PORT=7456
EXPOSE 7456
CMD ["node", "serve.js"]
```

- [ ] **Step 5: Remove daemon-related env vars from docker-compose**

Remove `OD_PORT`, `PRO_SLIDES_HOME`, `LABOFLOW_LLM_PROXY` from the pro-slides service — these were for the daemon.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml "Pro Slides/Dockerfile" "Pro Slides/apps/web/serve.js"
git commit -m "feat(infra): replace pro-slides daemon with static server, add PPT_AGENT_ID env var"
```

---

## Task 9: Clean Up Removed Files

Delete the daemon directory and unused provider files.

**Files:**
- Delete: `Pro Slides/apps/daemon/` (entire directory)
- Delete: `Pro Slides/apps/web/src/providers/daemon.ts`
- Delete: `Pro Slides/apps/web/src/providers/sse.ts`
- Delete: `Pro Slides/apps/web/src/providers/api-proxy.ts`
- Delete: `Pro Slides/apps/web/src/providers/anthropic.ts`
- Delete: `Pro Slides/apps/web/src/providers/connection-test.ts`
- Delete: `Pro Slides/apps/web/src/runtime/srcdoc.ts`

- [ ] **Step 1: Delete files**

```bash
rm -rf "Pro Slides/apps/daemon"
rm "Pro Slides/apps/web/src/providers/daemon.ts"
rm "Pro Slides/apps/web/src/providers/sse.ts"
rm "Pro Slides/apps/web/src/providers/api-proxy.ts"
rm "Pro Slides/apps/web/src/providers/anthropic.ts"
rm "Pro Slides/apps/web/src/providers/connection-test.ts"
rm "Pro Slides/apps/web/src/runtime/srcdoc.ts"
```

- [ ] **Step 2: Remove broken imports**

Search for imports referencing deleted files and remove or replace them:
```bash
grep -rn "from.*daemon\|from.*sse\|from.*api-proxy\|from.*anthropic\|from.*connection-test\|from.*srcdoc" "Pro Slides/apps/web/src/" --include="*.ts" --include="*.tsx"
```

For each file found, remove the import and any code that depends on it. This may involve:
- Removing `streamViaDaemon` calls (already replaced in Task 5)
- Removing `buildSrcdoc` calls (already replaced in Task 7)
- Removing `parseSseFrame` calls (only used by daemon.ts)
- Removing BYOK-related settings UI code
- Removing connection test UI code

- [ ] **Step 3: Commit**

```bash
git add -A "Pro Slides/"
git commit -m "chore(pro-slides): remove daemon, SSE, BYOK proxy, and srcdoc files"
```

---

## Task 10: End-to-End Integration Test

Manually verify the full flow works.

**Files:** None (manual testing)

- [ ] **Step 1: Create PPT Agent in Clawith**

1. Start Clawith backend: `docker compose up clawith-backend clawith-postgres clawith-redis`
2. Log in to Clawith frontend at `localhost:3008`
3. Create a new Agent:
   - Name: "PPT Slides"
   - access_mode: "private"
   - is_system: True (may need API call or admin panel)
   - Upload the ppt-master skill files
   - Assign a primary model (e.g., claude-sonnet-4-6)
4. Copy the Agent's UUID — this is the `PPT_AGENT_ID`

- [ ] **Step 2: Set PPT_AGENT_ID env var**

```bash
# In .env or docker-compose.yml
PPT_AGENT_ID=<uuid from step 1>
```

- [ ] **Step 3: Build and start Pro Slides**

```bash
docker compose up pro-slides
```

- [ ] **Step 4: Test the SSO flow**

1. From Clawith frontend, click "Pro Slides" entry point
2. Verify redirect to `/ppt/sso?token=...`
3. Verify SSO session created
4. Verify WebSocket connection to `/ws/chat/{ppt_agent_id}` succeeds

- [ ] **Step 5: Test PPT generation**

1. Type "帮我做一个5页的产品介绍PPT"
2. Verify direction cards appear in the chat
3. Click a direction card
4. Verify SVG slides render in the deck viewer
5. Verify slide navigation works
6. Verify thumbnails are generated

- [ ] **Step 6: Test iteration**

1. Type "把第三页改成数据图表"
2. Verify only the third slide gets updated
3. Verify the deck viewer reflects the change

- [ ] **Step 7: Commit test results (if any fixes were needed)**

```bash
git add -A
git commit -m "fix(pro-slides): integration test fixes"
```