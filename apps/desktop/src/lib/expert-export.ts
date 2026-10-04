/**
 * FR-E-08/22 专家包分享导出: a personal expert serializes to a portable
 * Markdown definition (frontmatter + persona body + binding declarations) a
 * colleague can import via the definition-file channel. Pure builder.
 */

export type ExpertExportInput = {
  name: string;
  description?: string;
  industry?: string;
  tags?: string[];
  examples?: string[];
  skills?: string[];
  mcpServers?: string[];
  model?: string;
  thinkingLevel?: string;
  body: string;
};

export function expertToMarkdown(expert: ExpertExportInput): string {
  const list = (value?: string[]) =>
    value && value.length ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]` : "[]";
  const frontmatter = [
    "---",
    `name: ${JSON.stringify(expert.name)}`,
    ...(expert.description ? [`description: ${JSON.stringify(expert.description)}`] : []),
    ...(expert.industry ? [`industry: ${JSON.stringify(expert.industry)}`] : []),
    `tags: ${list(expert.tags)}`,
    `examples: ${list(expert.examples)}`,
    `skills: ${list(expert.skills)}`,
    `mcpServers: ${list(expert.mcpServers)}`,
    ...(expert.model ? [`model: ${JSON.stringify(expert.model)}`] : []),
    ...(expert.thinkingLevel ? [`thinkingLevel: ${JSON.stringify(expert.thinkingLevel)}`] : []),
    "source: shared",
    "---",
  ].join("\n");
  return `${frontmatter}\n\n${expert.body.trim()}\n`;
}

/** Browser download helper (renderer-only; stubbed in tests). */
export function downloadExpertMarkdown(
  expert: ExpertExportInput,
  save: (name: string, content: string) => void,
): void {
  const safeName = expert.name.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "expert";
  save(`${safeName}.md`, expertToMarkdown(expert));
}
