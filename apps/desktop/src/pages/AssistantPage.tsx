import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

/**
 * T53.5 助理模式总控台 (FR-MC-01/02): channel status chips on top, the
 * unified assistant-session transcript in the middle (server-persisted, so it
 * survives restarts), and a direct input box that dispatches through the
 * same headless driver the channels use. Completion lands via
 * IPC.event.assistantTurnDone.
 */

type Turn = { role: "user" | "assistant"; content: string; pending?: boolean };

export function AssistantPage() {
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [channels, setChannels] = useState<
    Array<{ id: string; provider: string; name: string; state: string }>
  >([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (id: string) => {
    const messages = (await api.assistantHistory({ sessionId: id })) as Array<{
      role?: string;
      content?: string;
    }>;
    setTurns(
      messages
        .filter((message) => message.content?.trim())
        .map((message) => ({
          role: message.role === "user" ? ("user" as const) : ("assistant" as const),
          content: message.content ?? "",
        })),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await api.assistantSessionGet();
        if (cancelled) return;
        setSessionId(session.sessionId);
        await load(session.sessionId);
      } catch {
        if (!cancelled) setTurns([]);
      }
    })();
    const offDone = api.onAssistantTurnDone((payload) => {
      if (cancelled || payload.sessionId !== sessionId) return;
      setSending(false);
      setTurns((current) => {
        const withoutPending = current.filter((turn) => !turn.pending);
        return payload.status === "error"
          ? [...withoutPending, { role: "assistant", content: `${t("assistant.error")}: ${payload.error ?? ""}` }]
          : [...withoutPending, { role: "assistant", content: payload.finalText ?? "" }];
      });
    });
    api
      .channelsList()
      .then((rows) => {
        if (!cancelled) setChannels(rows ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      offDone();
    };
  }, [sessionId, load, t]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !sessionId || sending) return;
    setSending(true);
    setDraft("");
    setTurns((current) => [...current, { role: "user", content: text }, { role: "assistant", content: "…", pending: true }]);
    try {
      await api.assistantSend({ sessionId, text });
    } catch (error) {
      setSending(false);
      setTurns((current) => [
        ...current.filter((turn) => !turn.pending),
        { role: "assistant", content: error instanceof Error ? error.message : String(error) },
      ]);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4" data-testid="assistant-page">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t("assistant.title")}</span>
        {channels.map((channel) => (
          <span
            key={channel.id}
            className="rounded-full px-2 py-0.5 text-3xs"
            style={{ background: "var(--ds-bg-subtle)" }}
          >
            {channel.name || channel.provider}·
            {channel.state === "connected" ? "●" : channel.state === "error" ? "▲" : "○"}
          </span>
        ))}
        {!channels.length ? (
          <span className="text-xs opacity-60">{t("assistant.noChannels")}</span>
        ) : null}
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto rounded-lg border p-3"
        style={{ borderColor: "var(--ds-border)" }}
        data-testid="assistant-history"
      >
        {!turns.length ? (
          <p className="text-center text-xs opacity-50">{t("assistant.empty")}</p>
        ) : null}
        {turns.map((turn, index) => (
          <div
            key={index}
            className={`mb-2 max-w-[80%] rounded-lg px-3 py-2 text-sm ${
              turn.role === "user"
                ? "ml-auto bg-black/5"
                : `mr-auto ${turn.pending ? "animate-pulse opacity-60" : "border"}`
            }`}
            style={turn.role === "assistant" && !turn.pending ? { borderColor: "var(--ds-border)" } : undefined}
          >
            <div className="whitespace-pre-wrap break-words">{turn.content}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: "var(--ds-border)" }}
          placeholder={t("assistant.inputPlaceholder")}
          value={draft}
          disabled={!sessionId || sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="rounded-md border px-4 py-2 text-sm"
          style={{ borderColor: "var(--ds-border)" }}
          disabled={!sessionId || sending || !draft.trim()}
          onClick={() => void send()}
        >
          {t("assistant.send")}
        </button>
      </div>
    </div>
  );
}
