import type { AnnotationType } from "./types.js";

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

// ─── Annotation Colors ───

export const ANNOTATION_COLORS: Record<AnnotationType, string> = {
  // Red — critical/challenging
  provocation: "#F5574C",
  caveat: "#F5574C",
  "hedge-check": "#F5574C",
  perspective: "#F5574C",
  alternative: "#F5574C",
  specificity: "#F5574C",
  // Green — enriching
  insight: "#BFF3D3",
  free: "#BFF3D3",
  // Blue — navigating/orienting
  structural: "#243C61",
  recall: "#243C61",
  labeling: "#243C61",
  goal: "#243C61",
  givens: "#243C61",
  // Yellow — clarifying
  vocab: "#FFDD69",
  translation: "#FFDD69",
};

export const ANNOTATION_LABELS: Record<AnnotationType, string> = {
  provocation: "PROVOCATION",
  caveat: "CAVEAT",
  "hedge-check": "HEDGE-CHECK",
  perspective: "PERSPECTIVE",
  alternative: "ALTERNATIVE",
  specificity: "SPECIFICITY",
  insight: "INSIGHT",
  free: "FREE",
  structural: "STRUCTURAL",
  recall: "RECALL",
  labeling: "LABELING",
  goal: "GOAL",
  givens: "GIVENS",
  vocab: "VOCAB",
  translation: "TRANSLATION",
};

// ─── All annotation types ───

export const ALL_ANNOTATION_TYPES: AnnotationType[] = [
  "provocation",
  "caveat",
  "hedge-check",
  "perspective",
  "alternative",
  "specificity",
  "insight",
  "free",
  "structural",
  "recall",
  "labeling",
  "goal",
  "givens",
  "vocab",
  "translation",
];
