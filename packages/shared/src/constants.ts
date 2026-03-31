import type { AnnotationType, OverviewLabel, DepthType, UserTier, Verdict } from "./types.js";

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

// ─── Plan Features ───

export type PlanFeatureKey = keyof typeof PLAN_FEATURES.free;

export const PLAN_FEATURES = {
  free: {
    customPdfSubtitle: false,
    pdfAnnotation: false,
    sketchPad: false,
  },
  standard: {
    customPdfSubtitle: true,
    pdfAnnotation: true,
    sketchPad: true,
  },
} as const satisfies Record<UserTier, Record<string, boolean>>;

export function canUseFeature(tier: UserTier, feature: PlanFeatureKey): boolean {
  return PLAN_FEATURES[tier]?.[feature] ?? false;
}

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
  // Writing/Reading — Critical (red)
  caveat: "#F5574C",
  counterargument: "#F5574C",
  alternative: "#F5574C",
  fallacy: "#F5574C",
  criteria: "#F5574C",
  perspective: "#F5574C",
  consequence: "#F5574C",
  decision_making: "#F5574C",
  // Writing/Reading — Enrichment (green)
  insight: "#578E6C",
  recall: "#578E6C",
  translation: "#578E6C",
  // Brainstorming — Critical (red)
  juxtaposition: "#F5574C",
  outsider: "#F5574C",
  fixation_breaker: "#F5574C",
  reverse_brainstorm: "#F5574C",
  // Brainstorming — Enrichment (green)
  incomplete_move: "#578E6C",
  personal_hook: "#578E6C",
  role_assignment: "#578E6C",
  exaggeration: "#578E6C",
  // Legacy
  study: "#578E6C",
  vocabulary: "#578E6C",
};

// All depth annotations use LLM-generated labels now.
// This map provides a generic fallback for cached annotations that predate the label field.
export const DEPTH_LABELS: Record<DepthType, string> = {
  insight: "DEPTH",
  caveat: "DEPTH",
  counterargument: "DEPTH",
  alternative: "DEPTH",
  fallacy: "DEPTH",
  criteria: "DEPTH",
  perspective: "DEPTH",
  consequence: "DEPTH",
  decision_making: "DEPTH",
  recall: "DEPTH",
  translation: "DEPTH",
  juxtaposition: "DEPTH",
  outsider: "DEPTH",
  fixation_breaker: "DEPTH",
  incomplete_move: "DEPTH",
  personal_hook: "DEPTH",
  role_assignment: "DEPTH",
  exaggeration: "DEPTH",
  reverse_brainstorm: "DEPTH",
  study: "DEPTH",
  vocabulary: "DEPTH",
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
  // Writing/Reading — Critical (red)
  caveat: "#F5574C",
  counterargument: "#F5574C",
  alternative: "#F5574C",
  fallacy: "#F5574C",
  criteria: "#F5574C",
  perspective: "#F5574C",
  consequence: "#F5574C",
  decision_making: "#F5574C",
  // Writing/Reading — Enrichment (green)
  insight: "#578E6C",
  recall: "#578E6C",
  translation: "#578E6C",
  // Brainstorming — Critical (red)
  juxtaposition: "#F5574C",
  outsider: "#F5574C",
  fixation_breaker: "#F5574C",
  reverse_brainstorm: "#F5574C",
  // Brainstorming — Enrichment (green)
  incomplete_move: "#578E6C",
  personal_hook: "#578E6C",
  role_assignment: "#578E6C",
  exaggeration: "#578E6C",
  // Legacy
  study: "#578E6C",
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

// ─── Verdict Colors ───

export const VERDICT_COLORS: Record<Verdict, string> = {
  TAKE: "#578E6C",
  CAUTION: "#A78BFA",
  THROW: "#F5574C",
};

/** Return the color for a verdict. Falls back to getAnnotationColor when verdict is absent. */
export function getVerdictColor(verdict: Verdict): string {
  return VERDICT_COLORS[verdict];
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
  "decision_making",
  "insight",
  "recall",
  "translation",
  "juxtaposition",
  "outsider",
  "fixation_breaker",
  "incomplete_move",
  "personal_hook",
  "role_assignment",
  "exaggeration",
  "reverse_brainstorm",
  "study",
  "vocabulary",
];

export const ALL_ANNOTATION_TYPES: AnnotationType[] = [
  ...ALL_OVERVIEW_TYPES,
  ...ALL_DEPTH_TYPES,
];
