// Annotation types, colors, and labels — synced with packages/shared/src/constants.ts

// ─── Overview ───
export const OVERVIEW_LABELS = {
  core_claim: "CORE CLAIM",
  evidence: "EVIDENCE",
  outcome: "OUTCOME",
  background: "BACKGROUND",
  transition: "TRANSITION",
};

export const OVERVIEW_COLORS = {
  core_claim: "#FFDD69",
  evidence: "#FFDD69",
  outcome: "#FFDD69",
  background: "#FFDD69",
  transition: "#FFDD69",
};

// ─── Depth ───
export const DEPTH_LABELS = {
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
  study: "STUDY",
  vocabulary: "VOCABULARY",
};

export const DEPTH_COLORS = {
  caveat: "#F5574C",
  counterargument: "#F5574C",
  alternative: "#F5574C",
  fallacy: "#F5574C",
  criteria: "#F5574C",
  perspective: "#F5574C",
  consequence: "#F5574C",
  decision_making: "#F5574C",
  insight: "#578E6C",
  recall: "#578E6C",
  translation: "#578E6C",
  juxtaposition: "#F5574C",
  outsider: "#F5574C",
  fixation_breaker: "#F5574C",
  reverse_brainstorm: "#F5574C",
  incomplete_move: "#578E6C",
  personal_hook: "#578E6C",
  role_assignment: "#578E6C",
  exaggeration: "#578E6C",
  study: "#578E6C",
  vocabulary: "#578E6C",
};

// ─── Unified ───
export const ANNOTATION_COLORS = {
  ...OVERVIEW_COLORS,
  ...DEPTH_COLORS,
  user_written: "#748DBF",
};

export const ANNOTATION_LABELS = {
  ...OVERVIEW_LABELS,
  ...DEPTH_LABELS,
  user_written: "MY NOTE",
};

export const ALL_OVERVIEW_TYPES = [
  "core_claim", "evidence", "outcome", "background", "transition",
];

export const ALL_DEPTH_TYPES = [
  "caveat", "counterargument", "alternative", "fallacy", "criteria",
  "perspective", "consequence", "decision_making", "insight", "recall",
  "translation", "juxtaposition", "outsider", "fixation_breaker",
  "incomplete_move", "personal_hook", "role_assignment", "exaggeration",
  "reverse_brainstorm", "study", "vocabulary",
];

// ─── Personality descriptions ───
export const PERSONALITIES = {
  terry: { name: "Terry", description: "Sharp & critical" },
  jerry: { name: "Jerry", description: "Creative & curious" },
  sally: { name: "Sally", description: "Engaging & guiding" },
};

export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL || "https://oddity1-backend.vercel.app";

// ─── LLM Providers (BYOK) — mirrors packages/shared ───

export const LLM_PROVIDERS = [
  "oddity-free",
  "openrouter",
  "openai",
  "anthropic",
  "gemini",
  "muse",
];

export const LLM_EFFORT_OPTIONS = [
  "default",
  "none",
  "low",
  "medium",
  "high",
];

export const LLM_PROVIDER_META = {
  "oddity-free": {
    label: "Oddity Free",
    short: "Free",
    needsKey: false,
    keyUrl: null,
    modelPlaceholder: "",
    note: "Free and unlimited, served from shared capacity. May be slow or unstable at peak times.",
  },
  openrouter: {
    label: "OpenRouter",
    short: "OpenRouter",
    needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
    modelPlaceholder: "meta/muse-spark-1.3-contributor",
    note: "Any OpenRouter model ID, including :free models.",
  },
  openai: {
    label: "OpenAI",
    short: "OpenAI",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    modelPlaceholder: "gpt-5-mini",
    note: "Native model ID, e.g. gpt-5-mini or gpt-5.",
  },
  anthropic: {
    label: "Anthropic",
    short: "Anthropic",
    needsKey: true,
    keyUrl: "https://console.anthropic.com/",
    modelPlaceholder: "claude-sonnet-4.5",
    note: "Native model ID, e.g. claude-sonnet-4.5.",
  },
  gemini: {
    label: "Gemini",
    short: "Gemini",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/",
    modelPlaceholder: "gemini-2.5-flash",
    note: "Native model ID, e.g. gemini-2.5-flash.",
  },
  muse: {
    label: "Meta Muse",
    short: "Muse",
    needsKey: true,
    keyUrl: "https://dev.meta.ai/",
    modelPlaceholder: "muse-spark-1.3",
    note: "Meta Model API key (MODEL_API_KEY).",
  },
};
