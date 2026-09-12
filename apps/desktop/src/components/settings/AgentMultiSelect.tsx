import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../ui";

export interface MultiSelectOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Dropdown multi-select for editor sheets (module 01 polish): a trigger
 * button opens a checkbox list with local filtering; selection state is
 * fully controlled. Heading stays OUTSIDE a `<label>` wrapper — the label
 * element forwards clicks to the first labelable control, which is what
 * broke the earlier inline checkbox chips.
 */
export function AgentMultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  emptyLabel,
  disabled = false,
}: {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  emptyLabel: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Outside press + Escape dismiss (input-retained; focus stays in the sheet).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? options.filter(
        (option) =>
          option.label.toLowerCase().includes(needle) ||
          option.value.toLowerCase().includes(needle) ||
          (option.description ?? "").toLowerCase().includes(needle),
      )
    : options;

  const toggle = (value: string, on: boolean) => {
    onChange(
      on
        ? [...selected, value]
        : selected.filter((item) => item !== value),
    );
  };

  const selectedLabels = options
    .filter((option) => selected.includes(option.value))
    .map((option) => option.label);

  return (
    <div className="agent-multi" ref={rootRef}>
      <button
        type="button"
        className="agent-multi-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {selected.length ? (
          <span className="agent-multi-summary" title={selectedLabels.join("、")}>
            {selectedLabels.join("、")}
          </span>
        ) : (
          <span className="agent-multi-placeholder">{placeholder}</span>
        )}
        <span className="agent-multi-count">
          {t("expert.skillsSelected", { count: selected.length })}
        </span>
      </button>
      {open ? (
        <div className="agent-multi-pop" role="listbox" aria-multiselectable="true">
          <div className="agent-multi-search">
            <input
              type="text"
              value={query}
              placeholder={t("expert.skillsSearch")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {visible.length ? (
            <div className="agent-multi-list">
              {visible.map((option) => {
                const on = selected.includes(option.value);
                return (
                  <label key={option.value} className={cx("agent-multi-opt", on && "is-on")} title={option.description || undefined}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(event) => toggle(option.value, event.target.checked)}
                    />
                    <code>{option.label}</code>
                    {option.description ? (
                      <span className="agent-multi-desc">{option.description}</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="agent-multi-empty">{emptyLabel}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
