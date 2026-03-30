import type { AnnotationType, OverviewLabel, DepthType, Verdict, UserPurpose } from "./types.js";

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

export const RATE_LIMIT_FREE = 5000;
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
  // Terry — Critical (red)
  caveat: "#F5574C",
  counterargument: "#F5574C",
  alternative: "#F5574C",
  fallacy: "#F5574C",
  criteria: "#F5574C",
  perspective: "#F5574C",
  consequence: "#F5574C",
  decision_making: "#F5574C",
  // Terry — Enrichment (green)
  insight: "#578E6C",
  recall: "#578E6C",
  translation: "#578E6C",
  // Jerry — Critical (red)
  juxtaposition: "#F5574C",
  outsider: "#F5574C",
  fixation_breaker: "#F5574C",
  reverse_brainstorm: "#F5574C",
  // Jerry — Enrichment (green)
  incomplete_move: "#578E6C",
  personal_hook: "#578E6C",
  role_assignment: "#578E6C",
  exaggeration: "#578E6C",
  // Sally — Peer review concerns (red)
  unsupported_causal_claim: "#F5574C",
  correlation_as_causation: "#F5574C",
  circular_reasoning: "#F5574C",
  logical_leap: "#F5574C",
  false_dichotomy: "#F5574C",
  unsourced_factual_claim: "#F5574C",
  contested_claim_as_settled: "#F5574C",
  vague_sourcing: "#F5574C",
  overgeneralization: "#F5574C",
  false_precision: "#F5574C",
  overconfidence: "#F5574C",
  underconfidence: "#F5574C",
  missing_trade_offs: "#F5574C",
  missing_counter_argument: "#F5574C",
  scope_creep: "#F5574C",
  question_substitution: "#F5574C",
  incomplete_framework: "#F5574C",
  hallucination_risk: "#F5574C",
  unverified_attribution: "#F5574C",
  fabrication_risk: "#F5574C",
  misused_terminology: "#F5574C",
  // Legacy
  study: "#578E6C",
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
  decision_making: "DECISION MAKING",
  insight: "INSIGHT",
  recall: "RECALL",
  translation: "TRANSLATION",
  juxtaposition: "JUXTAPOSITION",
  outsider: "OUTSIDER",
  fixation_breaker: "FIXATION BREAKER",
  incomplete_move: "INCOMPLETE MOVE",
  personal_hook: "PERSONAL HOOK",
  role_assignment: "ROLE ASSIGNMENT",
  exaggeration: "EXAGGERATION",
  reverse_brainstorm: "REVERSE BRAINSTORM",
  unsupported_causal_claim: "UNSUPPORTED CAUSAL",
  correlation_as_causation: "CORRELATION ≠ CAUSE",
  circular_reasoning: "CIRCULAR REASONING",
  logical_leap: "LOGICAL LEAP",
  false_dichotomy: "FALSE DICHOTOMY",
  unsourced_factual_claim: "UNSOURCED CLAIM",
  contested_claim_as_settled: "CONTESTED AS SETTLED",
  vague_sourcing: "VAGUE SOURCING",
  overgeneralization: "OVERGENERALIZATION",
  false_precision: "FALSE PRECISION",
  overconfidence: "OVERCONFIDENCE",
  underconfidence: "UNDERCONFIDENCE",
  missing_trade_offs: "MISSING TRADE-OFFS",
  missing_counter_argument: "MISSING COUNTER",
  scope_creep: "SCOPE CREEP",
  question_substitution: "QUESTION SUBSTITUTED",
  incomplete_framework: "INCOMPLETE FRAMEWORK",
  hallucination_risk: "HALLUCINATION RISK",
  unverified_attribution: "UNVERIFIED ATTRIBUTION",
  fabrication_risk: "FABRICATION RISK",
  misused_terminology: "MISUSED TERMINOLOGY",
  study: "STUDY",
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
  // Terry — Critical (red)
  caveat: "#F5574C",
  counterargument: "#F5574C",
  alternative: "#F5574C",
  fallacy: "#F5574C",
  criteria: "#F5574C",
  perspective: "#F5574C",
  consequence: "#F5574C",
  decision_making: "#F5574C",
  // Terry — Enrichment (green)
  insight: "#578E6C",
  recall: "#578E6C",
  translation: "#578E6C",
  // Jerry — Critical (red)
  juxtaposition: "#F5574C",
  outsider: "#F5574C",
  fixation_breaker: "#F5574C",
  reverse_brainstorm: "#F5574C",
  // Jerry — Enrichment (green)
  incomplete_move: "#578E6C",
  personal_hook: "#578E6C",
  role_assignment: "#578E6C",
  exaggeration: "#578E6C",
  // Sally — Peer review concerns (red)
  unsupported_causal_claim: "#F5574C",
  correlation_as_causation: "#F5574C",
  circular_reasoning: "#F5574C",
  logical_leap: "#F5574C",
  false_dichotomy: "#F5574C",
  unsourced_factual_claim: "#F5574C",
  contested_claim_as_settled: "#F5574C",
  vague_sourcing: "#F5574C",
  overgeneralization: "#F5574C",
  false_precision: "#F5574C",
  overconfidence: "#F5574C",
  underconfidence: "#F5574C",
  missing_trade_offs: "#F5574C",
  missing_counter_argument: "#F5574C",
  scope_creep: "#F5574C",
  question_substitution: "#F5574C",
  incomplete_framework: "#F5574C",
  hallucination_risk: "#F5574C",
  unverified_attribution: "#F5574C",
  fabrication_risk: "#F5574C",
  misused_terminology: "#F5574C",
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

export const ANNOTATION_LABELS: Record<AnnotationType, string> = {
  ...OVERVIEW_LABELS,
  ...DEPTH_LABELS,
  user_written: "MY NOTE",
};

// ─── Verdict Colors & Labels ───

export const VERDICT_COLORS: Record<Verdict, string> = {
  take: "#578E6C",
  caution: "#A78BFA",
  throw: "#F5574C",
};

export const VERDICT_COLORS_LIGHT: Record<Verdict, string> = {
  take: "#578E6C",
  caution: "#7C3AED",
  throw: "#F5574C",
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  take: "TAKE",
  caution: "CAUTION",
  throw: "THROW",
};

/** Return the correct verdict color for a given theme. */
export function getVerdictColor(verdict: Verdict, theme: "light" | "dark"): string {
  return (theme === "light" ? VERDICT_COLORS_LIGHT : VERDICT_COLORS)[verdict];
}

// ─── User Purpose ───

export const PURPOSE_OPTIONS: { key: UserPurpose; label: string }[] = [
  { key: "info_takeaway", label: "Info-Takeaway" },
  { key: "brainstorm", label: "Brainstorm" },
  { key: "argument_formation", label: "Argument Formation" },
  { key: "decision_making", label: "Decision-making" },
  { key: "learning", label: "Learning" },
];

export const DEFAULT_PURPOSE: UserPurpose = "argument_formation";

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
  "unsupported_causal_claim",
  "correlation_as_causation",
  "circular_reasoning",
  "logical_leap",
  "false_dichotomy",
  "unsourced_factual_claim",
  "contested_claim_as_settled",
  "vague_sourcing",
  "overgeneralization",
  "false_precision",
  "overconfidence",
  "underconfidence",
  "missing_trade_offs",
  "missing_counter_argument",
  "scope_creep",
  "question_substitution",
  "incomplete_framework",
  "hallucination_risk",
  "unverified_attribution",
  "fabrication_risk",
  "misused_terminology",
  "study",
  "vocabulary",
];

export const ALL_ANNOTATION_TYPES: AnnotationType[] = [
  ...ALL_OVERVIEW_TYPES,
  ...ALL_DEPTH_TYPES,
];
