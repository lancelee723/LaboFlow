/**
 * Workbench-v3: the ppt-master integrated module's renderer entry.
 *
 * Registers a composerTrigger on "/" (coexisting with the builtin slash menu)
 * that surfaces the ppt-master skill as a completion chip, so the capsule's
 * prefill renders as a skill chip instead of raw text.
 */

const SKILL = {
  label: "ppt-master",
  send: "/laboflow.ppt-master/ppt-master",
  summary: "PPT-Master 管线：脚本稿 → 咨询级原生可编辑 PPTX",
};

export function activate({ slots }) {
  return slots.register({
    slot: "composerTrigger",
    trigger: "/",
    items: ({ query }) => {
      const q = String(query ?? "").toLowerCase();
      if (q && !SKILL.label.includes(q)) return [];
      return [{ label: SKILL.label, summary: SKILL.summary, send: SKILL.send }];
    },
  });
}
