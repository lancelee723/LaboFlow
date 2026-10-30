import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/app-store";
import { useTranslation } from "react-i18next";

/**
 * Workbench-mode entry capsule (WorkBuddy-style segmented control), rendered
 * under the rotating home placeholder: 通用对话 / PPT 工作台.
 *
 * Picking PPT 工作台 starts a workbench-mode session immediately: sendPrompt
 * creates the session with the ppt-master skill instruction as the first
 * user turn (the composer then behaves like any session — the user appends
 * their real request, attachments, model/thinking as usual). Switching back
 * to 通用对话 simply returns; nothing is sent until the user sends.
 */
const WORKBENCH_SKILL_PREFIX = `/laboflow.ppt-master/ppt-master`;

export function WorkbenchEntryCapsule() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"chat" | "ppt">("chat");
  const firedRef = useRef(false);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const segRef = useRef<HTMLDivElement | null>(null);

  // Slide the thumb under the active tab (measured — pure CSS cannot know
  // the label widths).
  useEffect(() => {
    const seg = segRef.current;
    const active = seg?.querySelector<HTMLButtonElement>("button.on");
    const thumb = thumbRef.current;
    if (!seg || !active || !thumb) return;
    const segRect = seg.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    thumb.style.left = `${rect.left - segRect.left}px`;
    thumb.style.width = `${rect.width}px`;
  }, [mode]);

  const pick = (next: "chat" | "ppt") => {
    setMode(next);
    if (next !== "ppt" || firedRef.current) return;
    firedRef.current = true;
    void sendPrompt(
      `${WORKBENCH_SKILL_PREFIX}\n${t("workbench.entryPrompt", {
        defaultValue:
          "进入 PPT 工作台模式。请加载 ppt-master 技能并按其规程与我逐步协作完成一份演示文稿；先向我确认本次的素材与受众，再开始。",
      })}`,
    ).catch(() => undefined);
  };

  return (
    <div className="wb-entry-seg" ref={segRef} role="tablist" aria-label={t("workbench.entryAria", { defaultValue: "工作台模式" })}>
      <div className="wb-entry-thumb" ref={thumbRef} />
      <button
        type="button"
        role="tab"
        aria-selected={mode === "chat"}
        className={mode === "chat" ? "on" : ""}
        onClick={() => pick("chat")}
      >
        <span className="wb-entry-ico" aria-hidden>💬</span>
        {t("workbench.tabChat", { defaultValue: "通用对话" })}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "ppt"}
        className={mode === "ppt" ? "on" : ""}
        onClick={() => pick("ppt")}
      >
        <span className="wb-entry-ico" aria-hidden>🖼</span>
        {t("workbench.tabPpt", { defaultValue: "PPT 工作台" })}
      </button>
    </div>
  );
}
