import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerCommand } from "@pi-desktop/shared";
import type {
  CompletionController,
  CompletionItem,
} from "../features/chat/composer/hooks/useComposerCompletions";
import {
  IconBookOpen,
  IconFileText,
  IconFolder,
  IconGraduationCap,
  IconNewSession,
  IconPlug,
  IconSlash,
  IconSparkles,
  IconUsers,
} from "./icons";
import { AnchoredMenu } from "./settings/AnchoredMenu";

/**
 * Composer autocomplete panel (D123–D125, spec 08 §11.8): full composer
 * width above the input, focus stays in the textarea — rows accept on
 * mousedown so the caret never leaves the draft.
 */

function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges: Array<[number, number]>;
}) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(<span key={`t${at}`}>{text.slice(at, start)}</span>);
    parts.push(
      <span key={`h${start}`} className="composer-ac-hl">
        {text.slice(start, end)}
      </span>,
    );
    at = end;
  }
  if (at < text.length) parts.push(<span key={`t${at}`}>{text.slice(at)}</span>);
  return <>{parts}</>;
}

const GROUP_KEYS: Record<ComposerCommand["kind"], string> = {
  template: "chat.slashGroupTemplates",
  builtin: "chat.slashGroupApp",
  plugin: "chat.slashGroupPlugins",
  extension: "chat.slashGroupExtensions",
  skill: "chat.slashGroupSkills",
};

function CommandIcon({ kind }: { kind: ComposerCommand["kind"] }) {
  if (kind === "template") return <IconSlash size={14} />;
  if (kind === "skill") return <IconBookOpen size={14} />;
  if (kind === "plugin" || kind === "extension") return <IconPlug size={14} />;
  return <IconSparkles size={14} />;
}

export function ComposerAutocomplete({
  anchorRef,
  ac,
  onAccept,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  ac: CompletionController;
  onAccept: (index: number) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ac.open) return;
    listRef.current
      ?.querySelector(`[data-ac-index="${ac.highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [ac.open, ac.highlight]);

  if (!ac.open) return null;

  const renderRow = (item: CompletionItem, index: number) => {
    const active = index === ac.highlight;
    const rowClass = `composer-plus-item composer-ac-item ${active ? "kb-active" : ""}`;
    const commonProps = {
      key:
        item.kind === "command"
          ? `c:${item.command.kind}:${item.command.name}`
          : item.kind === "expert"
            ? `e:${item.expert.id}`
            : item.kind === "team"
              ? `t:${item.team.id}`
              : item.kind === "context"
                ? `x:${item.session.id}`
                : item.kind === "plugin"
                  ? `pl:${item.pluginId}:${index}`
                  : `p:${item.entry.path}`,
      type: "button" as const,
      role: "option" as const,
      "aria-selected": active,
      "data-ac-index": index,
      className: rowClass,
      // Mousedown keeps focus in the textarea (input-retained overlay).
      onMouseDown: (e: React.MouseEvent) => {
        e.preventDefault();
        onAccept(index);
      },
      onMouseMove: () => ac.setHighlight(index),
    };
    if (item.kind === "command") {
      return (
        <button {...commonProps}>
          <span className="composer-ac-icon">
            <CommandIcon kind={item.command.kind} />
          </span>
          <span className="composer-ac-name">
            /<Highlighted text={item.command.name} ranges={item.match.ranges} />
          </span>
          {item.command.kind === "skill" && item.command.title !== item.command.name ? (
            <span className="composer-ac-hint">{item.command.title}</span>
          ) : null}
          {item.command.argumentHint ? (
            <span className="composer-ac-hint">{item.command.argumentHint}</span>
          ) : null}
          {item.command.description ? (
            <span className="composer-ac-desc">{item.command.description}</span>
          ) : null}
        </button>
      );
    }
    if (item.kind === "expert" || item.kind === "team") {
      const isTeam = item.kind === "team";
      const name = isTeam ? item.team.name : item.expert.name;
      const description = isTeam ? item.team.description : item.expert.description;
      return (
        <button {...commonProps} title={description || undefined}>
          <span className="composer-ac-icon">
            {isTeam ? <IconUsers size={14} /> : <IconGraduationCap size={14} />}
          </span>
          <span className="composer-ac-name">
            <Highlighted text={name} ranges={item.match.ranges} />
          </span>
          {description ? (
            <span className="composer-ac-desc">{description}</span>
          ) : null}
        </button>
      );
    }
    if (item.kind === "context") {
      const title = item.session.title || t("chat.untitledTask");
      return (
        <button {...commonProps} title={title}>
          <span className="composer-ac-icon">
            <IconNewSession size={14} />
          </span>
          <span className="composer-ac-name">{title}</span>
          <span className="composer-ac-hint">{t("chat.contextGroup")}</span>
        </button>
      );
    }
    if (item.kind === "plugin") {
      return (
        <button {...commonProps} title={item.row.detail}>
          <span className="composer-ac-icon">
            <IconPlug size={14} />
          </span>
          <span className="composer-ac-name">{item.row.label}</span>
          {item.row.detail ? <span className="composer-ac-desc">{item.row.detail}</span> : null}
        </button>
      );
    }
    const isDir = item.entry.kind === "dir";
    const name = item.entry.path.split("/").pop() ?? item.entry.path;
    const displayName = `${name}${isDir ? "/" : ""}`;
    return (
      <button
        {...commonProps}
        aria-label={`${displayName} — ${item.entry.path}`}
        title={item.entry.path}
      >
        <span className="composer-ac-icon">
          {isDir ? <IconFolder size={14} /> : <IconFileText size={14} />}
        </span>
        <span className="composer-ac-name">{displayName}</span>
      </button>
    );
  };

  const rows: React.ReactNode[] = [];
  let lastGroup: string | null = null;
  ac.items.forEach((item, index) => {
    if (item.kind === "command") {
      const group = item.command.kind;
      if (group !== lastGroup) {
        lastGroup = group;
        rows.push(
          <div key={`g:${group}`} className="composer-model-group-label">
            {t(GROUP_KEYS[group])}
          </div>,
        );
      }
    } else if (item.kind === "plugin" && lastGroup !== `plugin:${item.pluginId}`) {
      // A plugin's rows sit under its own name, after the host's.
      lastGroup = `plugin:${item.pluginId}`;
      rows.push(
        <div key={`g:${lastGroup}`} className="composer-model-group-label">
          {item.pluginName}
        </div>,
      );
    } else if (item.kind === "expert" && lastGroup !== "expert") {
      lastGroup = "expert";
      rows.push(
        <div key="g:expert" className="composer-model-group-label">
          {t("chat.expertGroup")}
        </div>,
      );
    } else if (item.kind === "team" && lastGroup !== "team") {
      lastGroup = "team";
      rows.push(
        <div key="g:team" className="composer-model-group-label">
          {t("chat.teamGroup")}
        </div>,
      );
    } else if (item.kind === "context" && lastGroup !== "context") {
      lastGroup = "context";
      rows.push(
        <div key="g:context" className="composer-model-group-label">
          {t("chat.contextGroup")}
        </div>,
      );
    } else if (item.kind === "path" && lastGroup !== "path") {
      lastGroup = "path";
      // Files keep the long-standing unlabeled list unless any named group
      // (agents or contexts) is shown above them; the label then separates
      // the reference kinds.
      const hasContexts = ac.items.some(
        (candidate) =>
          candidate.kind === "context" ||
          candidate.kind === "expert" ||
          candidate.kind === "team",
      );
      if (hasContexts) {
        rows.push(
          <div key="g:path" className="composer-model-group-label">
            {t("chat.fileGroup")}
          </div>,
        );
      }
    }
    rows.push(renderRow(item, index));
  });

  const emptyKey =
    ac.mode === "file"
      ? ac.noWorkspace
        ? "chat.fileNoWorkspace"
        : "chat.fileEmpty"
      : "chat.slashEmpty";

  return (
    <AnchoredMenu
      className="composer-autocomplete-anchor"
      open={ac.open}
      onClose={ac.close}
      anchorRef={anchorRef}
      menuClassName="composer-autocomplete"
      label={t(
        ac.mode === "file"
          ? "chat.fileMenu"
          : ac.mode === "plugin"
            ? "chat.pluginTriggerMenu"
            : "chat.slashMenu",
      )}
      role="listbox"
      side="top"
      matchAnchorWidth
      initialFocus="none"
      trigger={() => null}
    >
      <div className="composer-ac-list" ref={listRef}>
        {rows.length > 0 ? (
          rows
        ) : (
          <div className="composer-model-empty">{t(emptyKey)}</div>
        )}
      </div>
      <div className="composer-ac-footer">
        <span>{t("chat.acHint")}</span>
        {ac.truncated ? (
          <span className="composer-ac-truncated">{t("chat.fileTruncated")}</span>
        ) : null}
      </div>
    </AnchoredMenu>
  );
}
