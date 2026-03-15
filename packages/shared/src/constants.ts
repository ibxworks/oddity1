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
  core_claim: "#FFDD69",
  evidence: "#FFDD69",
  outcome: "#FFDD69",
  background: "#FFDD69",
  transition: "#FFDD69",
};

export const OVERVIEW_LABELS: Record<OverviewLabel, string> = {
  core_claim: "CORE CLAIM",
  evidence: "EVIDENCE",
  outcome: "OUTCOME",
  background: "BACKGROUND",
  transition: "TRANSITION",
};

// ─── Depth Annotation Colors & Labels ───

export const DEPTH_COLORS: Record<DepthType, string> = {
  // Critical — red
  caveat: "#F5574C",
  counterargument: "#F5574C",
  alternative: "#F5574C",
  fallacy: "#F5574C",
  criteria: "#F5574C",
  perspective: "#F5574C",
  consequence: "#F5574C",
  // Enrichment — green
  insight: "#578E6C",
  recall: "#578E6C",
  study: "#578E6C",
  translation: "#578E6C",
  vocabulary: "#578E6C",
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
  user_written: "#748DBF",
};

// ─── Light-mode overrides ───

export const ANNOTATION_COLORS_LIGHT: Record<AnnotationType, string> = {
  // Overview — yellow
  core_claim: "#FFDD69",
  evidence: "#FFDD69",
  outcome: "#FFDD69",
  background: "#FFDD69",
  transition: "#FFDD69",
  // Critical — red
  caveat: "#F5574C",
  counterargument: "#F5574C",
  alternative: "#F5574C",
  fallacy: "#F5574C",
  criteria: "#F5574C",
  perspective: "#F5574C",
  consequence: "#F5574C",
  // Enrichment — green
  insight: "#578E6C",
  recall: "#578E6C",
  study: "#578E6C",
  translation: "#578E6C",
  vocabulary: "#578E6C",
  // User-written — blue
  user_written: "#748DBF",
};

/** Return the correct annotation color for a given theme. */
export function getAnnotationColor(
  type: AnnotationType,
  theme: "light" | "dark",
): string {
  return (theme === "light" ? ANNOTATION_COLORS_LIGHT : ANNOTATION_COLORS)[type] ?? "#888";
}

export const ANNOTATION_LABELS: Record<AnnotationType, string> = {
  ...OVERVIEW_LABELS,
  ...DEPTH_LABELS,
  user_written: "MY NOTE",
};

// ─── All annotation types by mode ───

export const ALL_OVERVIEW_TYPES: OverviewLabel[] = [
  "core_claim",
  "evidence",
  "outcome",
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
