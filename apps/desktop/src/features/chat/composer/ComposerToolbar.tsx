import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { TFunction } from "i18next";
import {
  keybindingDisplayParts,
  type Mode,
  type PermissionMode,
  type ShortcutPlatform,
  type SessionThinkingLevel,
} from "@pi-desktop/shared";
import { useAppStore, type AppState } from "../../../stores/app-store";
import { ComposerPermissionPicker } from "./ComposerPermissionPicker";
import { ContextUsageInspector } from "../../../components/ContextUsageInspector";
import { ComposerControlSlots } from "./ComposerControlSlots";
import { TooltipButton } from "../../../components/ui";
import {
  IconArrowUp,
  IconAtSign,
  IconGraduationCap,
  IconNewSession,
  IconPaperclip,
  IconPlug,
  IconPlus,
  IconSparkles,
  IconStop,
  IconUndo2,
  IconUsers,
} from "../../../components/icons";
import { api, type ExpertListItem, type ExpertTeamListItem } from "../../../lib/api";
import type { SessionSummary } from "@pi-desktop/shared";
import { ModeIcon } from "./ComposerModeIcon";
import { LiveVoiceControls } from "../../voice/live/LiveVoiceControls";
import { ComposerModelPicker } from "./ComposerModelPicker";
import {
  MODE_LABEL_KEYS,
  nextMode,
} from "./model";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;
type ContextUsage = Parameters<typeof ContextUsageInspector>[0];

export type ComposerToolbarProps = {
  t: TFunction;
  mode: Mode;
  planningLive: boolean;
  providerId?: string;
  modelId?: string;
  thinkingLevel: SessionThinkingLevel;
  composerPermissionMode: Exclude<PermissionMode, "inherit">;
  permissionOpen: boolean;
  setPermissionOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  pasting: boolean;
  pickAndAttach: () => Promise<void>;
  /** LaboFlow FR-C-34/module 01: attach a conversation transcript as context. */
  onAttachSession: (session: SessionSummary) => void | Promise<void>;
  /** Insert plain text at the caret (plus menu item actions). */
  insertComposerText: (text: string) => void;
  configureActiveSession: AppState["configureActiveSession"];
  showToast: AppState["showToast"];
  modelMenu: ModelMenuController;
  modelLabel: string;
  thinkingLabel: string;
  contextUsage: ContextUsage | null;
  enhancementDraft: string;
  value: string;
  modelReady: boolean;
  sendBlocked: boolean;
  enhancingPrompt: boolean;
  enhancementUndoText: string | null;
  enhancePrompt: () => Promise<void>;
  undoPromptEnhancement: () => void;
  runActive: boolean;
  hasDraftContent: boolean;
  abort: AppState["abort"];
  submit: () => Promise<void>;
  workSessionId?: string;
  workSessionLabel?: string;
};

/** Composer controls: mode, permission, model, enhancement, and send/stop. */
export function ComposerToolbar({
  t,
  mode,
  planningLive,
  providerId,
  modelId,
  thinkingLevel,
  composerPermissionMode,
  permissionOpen,
  setPermissionOpen,
  controlsBlocked,
  pasting,
  pickAndAttach,
  onAttachSession,
  insertComposerText,
  configureActiveSession,
  showToast,
  modelMenu,
  modelLabel,
  thinkingLabel,
  contextUsage,
  enhancementDraft,
  value,
  modelReady,
  sendBlocked,
  enhancingPrompt,
  enhancementUndoText,
  enhancePrompt,
  undoPromptEnhancement,
  runActive,
  hasDraftContent,
  abort,
  submit,
  workSessionId,
  workSessionLabel,
}: ComposerToolbarProps) {
  const sessions = useAppStore((store) => store.sessions);
  const activeSessionId = useAppStore((store) => store.activeSessionId);
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;
  const steeringShortcut = keybindingDisplayParts("Alt+Enter", platform).join("+");

  // LaboFlow plus menu (FR-C-33/module 01): attach files, attach another
  // conversation's transcript, summon an expert/team by mention, or land a
  // $skill token. Sub-modes replace the flat menu; Escape/outside click closes.
  const plusRef = useRef<HTMLDivElement | null>(null);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusContextMode, setPlusContextMode] = useState(false);
  const [plusSkillMode, setPlusSkillMode] = useState(false);
  const [plusExpertMode, setPlusExpertMode] = useState(false);
  const [contextQuery, setContextQuery] = useState("");
  const [plusSkills, setPlusSkills] = useState<
    Array<{ name: string; title?: string; description?: string }> | null
  >(null);
  const [plusExperts, setPlusExperts] = useState<ExpertListItem[] | null>(null);
  const [plusTeams, setPlusTeams] = useState<ExpertTeamListItem[] | null>(null);

  const contextSessions = useMemo(() => {
    const needle = contextQuery.trim().toLowerCase();
    return sessions
      .filter((session) => session.id !== activeSessionId)
      .filter(
        (session) =>
          !needle ||
          (session.title || "").toLowerCase().includes(needle) ||
          session.id.toLowerCase().includes(needle),
      )
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
      .slice(0, 8);
  }, [sessions, activeSessionId, contextQuery]);

  const closePlusMenu = () => {
    setPlusMenuOpen(false);
    setPlusSkillMode(false);
    setPlusExpertMode(false);
    setPlusContextMode(false);
    setContextQuery("");
  };

  useEffect(() => {
    if (!plusMenuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!plusRef.current?.contains(e.target as Node)) closePlusMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePlusMenu();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [plusMenuOpen]);

  useEffect(() => {
    if (!plusMenuOpen || !plusSkillMode || plusSkills) return;
    let cancelled = false;
    api
      .listUserSkills({ level: "global" })
      .then((result) => {
        if (!cancelled) setPlusSkills(result.skills ?? []);
      })
      .catch(() => {
        if (!cancelled) setPlusSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [plusMenuOpen, plusSkillMode, plusSkills]);

  useEffect(() => {
    if (!plusMenuOpen || !plusExpertMode || plusExperts) return;
    let cancelled = false;
    api
      .listExperts()
      .then((result) => {
        if (!cancelled) {
          setPlusExperts((result ?? []).filter((expert) => expert.enabled !== false));
        }
      })
      .catch(() => {
        if (!cancelled) setPlusExperts([]);
      });
    // Teams ride along so the "+" menu mirrors the @ picker's two agent
    // groups; the inserted `@团队名` token dispatches a team run on send.
    api
      .listExpertTeams()
      .then((result) => {
        if (!cancelled) {
          setPlusTeams((result ?? []).filter((team) => team.enabled !== false));
        }
      })
      .catch(() => {
        if (!cancelled) setPlusTeams([]);
      });
    return () => {
      cancelled = true;
    };
  }, [plusMenuOpen, plusExpertMode, plusExperts]);

  return (
    <div className="composer-toolbar">
      <div className="composer-left">
        <div className="composer-plus" ref={plusRef}>
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("chat.addFiles")}
            ariaLabel={t("chat.addFiles")}
            aria-haspopup="menu"
            aria-expanded={plusMenuOpen}
            disabled={controlsBlocked || pasting}
            onClick={() => {
              setPermissionOpen(false);
              modelMenu.setOpen(false);
              setPlusSkillMode(false);
              setPlusExpertMode(false);
              setPlusContextMode(false);
              setContextQuery("");
              setPlusMenuOpen((open) => !open);
            }}
          >
            <IconPlus size={15} aria-hidden="true" />
          </TooltipButton>
          {plusMenuOpen && (
            <div className="composer-plus-menu" role="menu">
              {plusContextMode ? (
                <>
                  {contextSessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      role="menuitem"
                      className="composer-plus-item"
                      title={session.title}
                      onClick={() => {
                        closePlusMenu();
                        void onAttachSession(session);
                      }}
                    >
                      <IconNewSession size={14} />
                      <span>{session.title || t("chat.untitledTask")}</span>
                    </button>
                  ))}
                  {!contextSessions.length ? (
                    <div className="composer-plus-empty">{t("chat.contextEmpty")}</div>
                  ) : null}
                </>
              ) : plusExpertMode ? (
                <>
                  {(plusExperts ?? []).map((expert) => (
                    <button
                      key={expert.id}
                      type="button"
                      role="menuitem"
                      className="composer-plus-item"
                      title={expert.description || undefined}
                      onClick={() => {
                        closePlusMenu();
                        insertComposerText(`@${expert.name} `);
                      }}
                    >
                      <IconGraduationCap size={14} />
                      <span>{expert.name}</span>
                    </button>
                  ))}
                  {plusExperts && !plusExperts.length ? (
                    <div className="composer-plus-empty">{t("chat.noExpertsYet")}</div>
                  ) : null}
                  {plusTeams?.length ? (
                    <div className="composer-model-group-label" role="presentation">
                      {t("chat.teamGroup")}
                    </div>
                  ) : null}
                  {(plusTeams ?? []).map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      role="menuitem"
                      className="composer-plus-item"
                      title={team.description || undefined}
                      onClick={() => {
                        closePlusMenu();
                        insertComposerText(`@${team.name} `);
                      }}
                    >
                      <IconUsers size={14} />
                      <span>{team.name}</span>
                    </button>
                  ))}
                  {!plusExperts ? (
                    <div className="composer-plus-empty">{t("chat.expertsLoading")}</div>
                  ) : null}
                </>
              ) : plusSkillMode ? (
                <>
                  {(plusSkills ?? []).map((skill: { name: string; title?: string; description?: string }) => (
                    <button
                      key={skill.name}
                      type="button"
                      role="menuitem"
                      className="composer-plus-item"
                      title={skill.description || undefined}
                      onClick={() => {
                        closePlusMenu();
                        insertComposerText(`$${skill.name} `);
                      }}
                    >
                      <IconPlug size={14} />
                      <span>{skill.title || skill.name}</span>
                    </button>
                  ))}
                  {plusSkills && !plusSkills.length ? (
                    <div className="composer-plus-empty">{t("chat.noSkillsYet")}</div>
                  ) : null}
                  {!plusSkills ? (
                    <div className="composer-plus-empty">{t("chat.skillsLoading")}</div>
                  ) : null}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-plus-item"
                    disabled={pasting}
                    onClick={() => {
                      closePlusMenu();
                      void pickAndAttach();
                    }}
                  >
                    <IconPaperclip size={14} />
                    <span>{t("chat.addFiles")}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-plus-item"
                    onClick={() => {
                      setPlusContextMode(true);
                    }}
                  >
                    <IconAtSign size={14} />
                    <span>{t("chat.addContext")}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-plus-item"
                    onClick={() => {
                      setPlusExpertMode(true);
                    }}
                  >
                    <IconGraduationCap size={14} />
                    <span>{t("chat.pickExpert")}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-plus-item"
                    onClick={() => {
                      setPlusSkillMode(true);
                    }}
                  >
                    <IconPlug size={14} />
                    <span>{t("chat.pickSkill")}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <LiveVoiceControls t={t} workSessionId={workSessionId} workSessionLabel={workSessionLabel} />
        <TooltipButton
          type="button"
          className="icon-btn mode-chip composer-mode-chip"
          data-mode={mode}
          data-planning={planningLive ? "true" : undefined}
          tooltip={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
          ariaLabel={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
          disabled={controlsBlocked}
          onClick={async () => {
            modelMenu.setOpen(false);
            setPermissionOpen(false);
            const next: Mode = nextMode(mode);
            try {
              await configureActiveSession({
                mode: next,
                providerId,
                modelId,
                thinkingLevel,
              });
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error), {
                variant: "error",
              });
            }
          }}
        >
          <span className="composer-mode-chip-face" key={mode}>
            <ModeIcon mode={mode} />
            <span className="composer-mode-chip-label text-sm">
              {t(MODE_LABEL_KEYS[mode])}
            </span>
          </span>
        </TooltipButton>
        <ComposerPermissionPicker t={t} mode={mode}
          composerPermissionMode={composerPermissionMode}
          permissionOpen={permissionOpen} setPermissionOpen={setPermissionOpen}
          controlsBlocked={controlsBlocked} onCloseOtherMenus={() => modelMenu.setOpen(false)}
          onSelect={async (candidate) => {
                try {
                  await configureActiveSession({
                    mode,
                    providerId,
                    modelId,
                    thinkingLevel,
                    permissionMode: candidate,
                  });
                } catch (error) {
                  showToast(error instanceof Error ? error.message : String(error), {
                    variant: "error",
                  });
                }
          }} />
        <ComposerControlSlots side="left" />
      </div>

      <div className="composer-right">
        <ComposerControlSlots side="right" />
        {contextUsage ? <ContextUsageInspector {...contextUsage} /> : null}
        <ComposerModelPicker
          t={t}
          controller={modelMenu}
          modelLabel={modelLabel}
          thinkingLabel={thinkingLabel}
          thinkingLevel={thinkingLevel}
          selectedProviderId={providerId}
          selectedModelId={modelId}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => setPermissionOpen(false)}
        />
        <TooltipButton
          type="button"
          className={`icon-btn icon-btn-square composer-enhance-btn${enhancingPrompt ? " is-loading" : ""}`}
          tooltip={t("chat.enhancePrompt")}
          ariaLabel={enhancingPrompt ? t("chat.enhancingPrompt") : t("chat.enhancePrompt")}
          aria-busy={enhancingPrompt}
          disabled={
            !enhancementDraft.trim() ||
            enhancementDraft.trim().startsWith("/") ||
            !modelReady ||
            sendBlocked ||
            enhancingPrompt
          }
          onClick={() => void enhancePrompt()}
        >
          {enhancingPrompt ? (
            <>
              <span className="tool-spinner" aria-hidden="true" />
              <span>{t("chat.enhancingPrompt")}</span>
            </>
          ) : (
            <IconSparkles size={15} aria-hidden="true" />
          )}
        </TooltipButton>
        {enhancementUndoText !== null ? (
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square composer-enhance-undo"
            tooltip={t("chat.undoEnhancement")}
            ariaLabel={t("chat.undoEnhancement")}
            disabled={controlsBlocked}
            onClick={undoPromptEnhancement}
          >
            <IconUndo2 size={15} aria-hidden="true" />
          </TooltipButton>
        ) : null}
        {runActive && !hasDraftContent ? (
          <TooltipButton
            type="button"
            className="stop-btn"
            tooltip={t("chat.stopGenerating")}
            ariaLabel={t("chat.stopGenerating")}
            onClick={() => void abort()}
          >
            <IconStop size={14} />
          </TooltipButton>
        ) : (
          <TooltipButton
            type="button"
            className="send-btn"
            ariaLabel={modelReady ? t("chat.send") : t("settings.addProvider")}
            tooltip={
              runActive
                ? t("chat.sendWhileRunning", { shortcut: steeringShortcut })
                : modelReady
                  ? t("chat.send")
                  : t("settings.addProvider")
            }
            disabled={
              !hasDraftContent ||
              sendBlocked ||
              (!modelReady && !value.trim().startsWith("/"))
            }
            onClick={() => void submit()}
          >
            <IconArrowUp size={15} />
          </TooltipButton>
        )}
      </div>
    </div>
  );
}
