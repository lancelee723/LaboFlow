/** Shared public types grouped by the owning application domain. */
export type FsEntry = {
  name: string;
  kind: "dir" | "file";
  size: number;
};

/** Document formats the Files tab renders in-app (pdf/docx/pptx/xlsx). */
export type FsDocumentKind = "pdf" | "docx" | "pptx" | "xlsx";

export type FsReadResult = {
  kind: "text" | "image" | "document" | "binary" | "tooLarge";
  /** UTF-8 file content when kind is "text". */
  content?: string;
  /** Base64 data URL when kind is "image" or "document". */
  dataUrl?: string;
  /** Which in-app document renderer to use, when kind is "document". */
  documentKind?: FsDocumentKind;
  size: number;
};

/** Bounded in-chat image read. Non-images never include file bytes. */
export type FsImageDataUrlResult = {
  kind: "image" | "missing" | "notImage" | "tooLarge";
  dataUrl?: string;
  size?: number;
  errorCode?: string;
};

export type AgentInstructionFile = {
  scope: "global" | "project";
  path: string;
  content: string;
  exists: boolean;
};

export type ProjectMemory = {
  content: string;
  entries?: ProjectMemoryEntry[];
  updatedAt?: number;
};

export type ProjectMemoryEntry = {
  id: string;
  title: string;
  content: string;
};

/** Workspace-relative entry of the `fs/index` snapshot for the "@" menu (D124). */
export type FsIndexEntry = {
  path: string;
  kind: "dir" | "file";
};

export type FsIndexResult = {
  entries: FsIndexEntry[];
  /** True when the index hit its entry cap and results were dropped. */
  truncated: boolean;
};

export type TokenUsageBucket = "day" | "week" | "month";

export type TokenUsageHistoryItem = {
  date: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  turnCount: number;
};

export type TokenUsageHistoryResult = {
  bucket: TokenUsageBucket;
  rangeStart: number;
  rangeEnd: number;
  items: TokenUsageHistoryItem[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    turnCount: number;
  };
};

/**
 * One folder of the project a chat reference may resolve into. A project can be
 * a logical group of several folders (ADR 0249), and only the primary one is
 * the workspace that relative paths are expressed against.
 */
export type FsChatRefProjectRoot = {
  path: string;
  name: string;
  primary: boolean;
};

/**
 * A file referenced from chat text, resolved to a real file (D320 follow-up).
 *
 * `root` names which store answered, because the caller routes on it: a project
 * file is expressed to the work panel as a path relative to the project's
 * **primary** folder, while any other project folder — and every scratch or
 * attachment file — can only be addressed by its absolute path.
 */
export type FsChatRefRoot = "workspace" | "scratch" | "attachments";

/** Which rule produced the match; the shallow tiers are informational. */
export type FsChatRefMatchKind =
  | "exact-relative"
  | "exact-absolute"
  | "path-suffix"
  | "basename";

export type FsChatRefMatch = {
  root: FsChatRefRoot;
  /** The match belongs to this session's scratch, not the wider read-only store. */
  sessionScratch?: boolean;
  /** POSIX path relative to the matched root. */
  relativePath: string;
  /** Native absolute path of the matched regular file. */
  absolutePath: string;
  matchedBy: FsChatRefMatchKind;
  /**
   * Which folder of the project answered, for `root: "workspace"`. The caller
   * needs it to decide how to address the file: relative for the primary
   * folder, absolute for any other.
   */
  projectRoot?: FsChatRefProjectRoot;
};

export type FsChatRefResolveResult = {
  match: FsChatRefMatch | null;
  /** The supplied absolute path is not inside a project, scratch, or attachment root. */
  reason?: "outside-allowed-roots";
};

export type TokenInsightsFactsResult = {
  available: boolean;
  generatedAt?: number;
  columns?: string[];
  days?: string[];
  models?: string[];
  /** Tool source ids aligned with the row's source cell. Producers ship either
   * bare ids ("pi-desktop") or {id, label} objects (Token Insights' shape). */
  sources?: Array<string | { id: string; label?: string }>;
  buckets?: number[][];
};

export type TokenUsageModelSeries = {
  modelId: string;
  items: TokenUsageHistoryItem[];
};

/**
 * The Token Insights plugin's published fact cube (usageFacts in its plugin
 * settings), exposed read-only so the usage stats page can render the same
 * live aggregation the plugin panel shows. Buckets are numeric rows aligned
 * with `columns`; `days`/`models` index into the row's day/model cells.
 */
