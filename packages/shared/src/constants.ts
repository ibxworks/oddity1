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
  highlight: "#FFDD69",
  recall: "#243C61",
  provoking_question: "#F5574C",
  insight: "#BFF3D3",
  caveat: "#F5574C",
  vocabulary: "#243C61",
};

export const ANNOTATION_LABELS: Record<AnnotationType, string> = {
  highlight: "KEY PHRASE",
  recall: "RECALL",
  provoking_question: "PROVOCATION",
  insight: "INSIGHT",
  caveat: "CAVEAT",
  vocabulary: "VOCABULARY",
};

// ─── All annotation types ───

export const ALL_ANNOTATION_TYPES: AnnotationType[] = [
  "highlight",
  "recall",
  "provoking_question",
  "insight",
  "caveat",
  "vocabulary",
];
