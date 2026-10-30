import { useEffect, useRef, useState } from "react";
import { IconChat, IconPresentation } from "./icons";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { useTranslation } from "react-i18next";

/**
 * Workbench-mode entry capsule (WorkBuddy-style segmented control), rendered
 * under the rotating home placeholder: 通用对话 / PPT 工作台.
 *
 * Picking PPT 工作台 does NOT send anything to the agent — it pre-fills the
 * composer with the ppt-master skill invocation and swaps the placeholder,
 * leaving the session in a wait-for-prompt state: the user types their real
 * request and attaches files, then sends (the skill path expands host-side).
 * 通用对话 clears the prefill again.
 */
const WORKBENCH_SKILL_PREFIX = `/laboflow.ppt-master/ppt-master`;

export function WorkbenchEntryCapsule() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"chat" | "ppt">("chat");
  const setWorkbenchHomePrefill = useAppStore((s) => s.setWorkbenchHomePrefill);
  const clearComposerPrefill = useAppStore((s) => s.clearComposerPrefill);
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
    if (next === "ppt") {
      // Skill invocation sits in the draft as prompt text — nothing is sent
      // until the user completes their request and submits.
      setWorkbenchHomePrefill({ text: WORKBENCH_SKILL_PREFIX });
    } else {
      clearComposerPrefill();
    }
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
        <IconChat className="wb-entry-ico" size={14} />
        {t("workbench.tabChat", { defaultValue: "通用对话" })}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "ppt"}
        className={mode === "ppt" ? "on" : ""}
        onClick={() => pick("ppt")}
      >
        <IconPresentation className="wb-entry-ico" size={14} />
        {t("workbench.tabPpt", { defaultValue: "PPT 工作台" })}
      </button>
    </div>
  );
}
