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

export const RATE_LIMIT_FREE = 50;
export const RATE_LIMIT_PRO = 500;

// ─── Request Limits ───

export const MAX_TEXT_LENGTH = 100_000; // ~100KB

// ─── Cache ───

export const CACHE_TTL_DAYS = 30;

// ─── Overview Annotation Colors & Labels ───

export const OVERVIEW_COLORS: Record<OverviewLabel, string> = {
  core_claim: "#E8C547",
  evidence: "#E8C547",
  consequence: "#E8C547",
  background: "#E8C547",
  transition: "#E8C547",
};

export const OVERVIEW_LABELS: Record<OverviewLabel, string> = {
  core_claim: "CORE CLAIM",
  evidence: "EVIDENCE",
  consequence: "CONSEQUENCE",
  background: "BACKGROUND",
  transition: "TRANSITION",
};

// ─── Depth Annotation Colors & Labels ───

export const DEPTH_COLORS: Record<DepthType, string> = {
  // CRITICAL
  caveat: "#E05252",
  counterargument: "#E05252",
  alternative: "#E05252",
  fallacy: "#E05252",
  criteria: "#E05252",
  perspective: "#E05252",
  consequence: "#E05252",
  // ENRICHMENT
  insight: "#52B86E",
  recall: "#52B86E",
  study: "#52B86E",
  translation: "#52B86E",
  vocabulary: "#52B86E",
};

export const DEPTH_LABELS: Record<DepthType, string> = {
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
  "consequence",
  "background",
  "transition",
];

export const ALL_DEPTH_TYPES: DepthType[] = [
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
