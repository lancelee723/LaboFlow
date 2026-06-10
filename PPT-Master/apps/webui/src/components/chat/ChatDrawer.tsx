import { type RefObject, useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRight, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface ChatMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  agent?: string
}

interface ChatDrawerProps {
  messages: ChatMessage[]
  thinking: string
  chatInput: string
  setChatInput: (v: string) => void
  onSend: () => void
  scrollRef: RefObject<HTMLDivElement>
  sessionId: string | null
  onClose: () => void
}

export function ChatDrawer({
  messages,
  thinking,
  chatInput,
  setChatInput,
  onSend,
  scrollRef,
  sessionId,
  onClose,
}: ChatDrawerProps) {
  const { t } = useTranslation("editor")
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setOpen(true)
  }, [])

  const handleClose = () => {
    setOpen(false)
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-30 bg-black/25"
        onClick={handleClose}
        aria-hidden
      />

      {/* Drawer */}
      <div
        className="fixed bottom-0 right-0 top-0 z-[31] flex w-[380px] flex-col border-l bg-background shadow-xl transition-transform duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{ transform: open ? "translateX(0)" : "translateX(100%)" }}
        onTransitionEnd={() => { if (!open) onClose() }}
      >
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <span className="text-sm font-semibold">{t("chat")}</span>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-lg"
            onClick={handleClose}
            aria-label={t("closeChat")}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Message list */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("chatHistoryHint")}
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className="space-y-2">
              <div
                className={`rounded-lg p-3 text-sm ${
                  msg.role === "user"
                    ? "ml-8 bg-primary text-primary-foreground"
                    : msg.role === "system"
                      ? "mx-4 bg-muted/50 text-xs text-muted-foreground italic"
                      : "mr-8 bg-muted"
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>
            </div>
          ))}

          {thinking && (
            <div className="mr-8 rounded-lg bg-muted p-3 text-sm">
              <div className="whitespace-pre-wrap opacity-70">{thinking}</div>
              <span className="inline-block h-3 w-1 animate-pulse bg-primary" />
            </div>
          )}
        </div>

        {/* Input footer */}
        <div className="shrink-0 border-t p-4">
          <div className="flex gap-2">
            <Input
              placeholder={sessionId ? t("replyPlaceholder") : t("typeMessagePlaceholder")}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onSend()}
              disabled={!sessionId}
            />
            <Button
              size="icon"
              onClick={onSend}
              disabled={!sessionId || !chatInput.trim()}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
