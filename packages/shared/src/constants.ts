import type { AnnotationType, OverviewLabel, DepthType } from "./types.js";

// ─── Blocked Domains ───

export const BLOCKED_DOMAINS = ['app.oddity1.com'];

export function isBlockedDomain(domain: string): boolean {
  return BLOCKED_DOMAINS.includes(domain);
}

// ─── Default Enabled Sites ───

export const DEFAULT_ENABLED_SITES: string[] = [
  'chatgpt.com', 'claude.ai', 'gemini.google.com',
  'wikipedia.org', 'substack.com', 'medium.com',
  'bbc.com', 'cnn.com', 'nytimes.com',
  'washingtonpost.com', 'theatlantic.com',
];

// ─── Backend URL ───

export const BACKEND_URL =
  process.env.ODDITY_BACKEND_URL ?? "http://localhost:3001";

// ─── Timing ───

export const STABILITY_DEBOUNCE_MS = 500;
export const POPOVER_SHOW_DELAY_MS = 200;
export const POPOVER_HIDE_DELAY_MS = 300;
export const ADAPTER_REFRESH_INTERVAL_MINUTES = 360; // 6 hours
export const SCROLL_LOADER_ROOT_MARGIN = "500px";
export const EAGER_WORD_LIMIT = 6000;

// ─── Rate Limits ───

export const RATE_LIMIT_FREE = 50000;
export const RATE_LIMIT_PRO = 500;

// ─── Request Limits ───

export const MAX_TEXT_LENGTH = 100_000; // ~100KB

// ─── Cache ───

export const CACHE_TTL_DAYS = 30;

// ─── Overview Annotation Colors & Labels ───

export const OVERVIEW_COLORS: Record<OverviewLabel, string> = {
  core_claim: "#4A90D9",
  evidence: "#7B61FF",
  assumption: "#E8913A",
  consequence: "#50B87A",
  background: "#8E8E93",
  transition: "#A1927B",
  caveat: "#F5574C",
  open_question: "#E06B9E",
};

export const OVERVIEW_LABELS: Record<OverviewLabel, string> = {
  core_claim: "CORE CLAIM",
  evidence: "EVIDENCE",
  assumption: "ASSUMPTION",
  consequence: "CONSEQUENCE",
  background: "BACKGROUND",
  transition: "TRANSITION",
  caveat: "CAVEAT",
  open_question: "OPEN QUESTION",
};

// ─── Depth Annotation Colors & Labels ───

export const DEPTH_COLORS: Record<DepthType, string> = {
  assumption: "#E8913A",
  caveat: "#F5574C",
  counterargument: "#D94A4A",
  alternative: "#9B59B6",
  fallacy: "#E74C3C",
  criteria: "#F39C12",
  perspective: "#3498DB",
  consequence: "#50B87A",
  insight: "#2ECC71",
  recall: "#243C61",
  study: "#1ABC9C",
  translation: "#8E44AD",
  vocabulary: "#243C61",
};

export const DEPTH_LABELS: Record<DepthType, string> = {
  assumption: "ASSUMPTION",
  caveat: "CAVEAT",
  counterargument: "COUNTERARGUMENT",
  alternative: "ALTERNATIVE",
  fallacy: "FALLACY",
  criteria: "CRITERIA",
  perspective: "PERSPECTIVE",
  consequence: "CONSEQUENCE",
  insight: "INSIGHT",
  recall: "RECALL",
  study: "STUDY",
  translation: "TRANSLATION",
  vocabulary: "VOCABULARY",
};

// ─── Unified Annotation Colors & Labels (used by rendering pipeline) ───

export const ANNOTATION_COLORS: Record<AnnotationType, string> = {
  ...OVERVIEW_COLORS,
  ...DEPTH_COLORS,
  user_written: "#A1927B",
};

export const ANNOTATION_LABELS: Record<AnnotationType, string> = {
  ...OVERVIEW_LABELS,
  ...DEPTH_LABELS,
  user_written: "MY NOTE",
};

// ─── All annotation types by mode ───

export const ALL_OVERVIEW_TYPES: OverviewLabel[] = [
  "core_claim",
  "evidence",
  "assumption",
  "consequence",
  "background",
  "transition",
  "caveat",
  "open_question",
];

export const ALL_DEPTH_TYPES: DepthType[] = [
  "assumption",
  "caveat",
  "counterargument",
  "alternative",
  "fallacy",
  "criteria",
  "perspective",
  "consequence",
  "insight",
  "recall",
  "study",
  "translation",
  "vocabulary",
];
