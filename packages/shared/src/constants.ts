import type {
  AnnotationType,
  DepthType,
  LlmProvider,
  LlmReasoningEffort,
  OverviewLabel,
  UserTier,
} from "./types.js";

// ─── Blocked Domains ───

export const BLOCKED_DOMAINS = ["app.oddity1.com"];

export function isBlockedDomain(domain: string): boolean {
  return BLOCKED_DOMAINS.includes(domain);
}

// ─── Default Enabled Sites ───

export const DEFAULT_ENABLED_SITES: string[] = [
  "chatgpt.com",
  "claude.ai",
  "gemini.google.com",
  "wikipedia.org",
  "substack.com",
  "medium.com",
  "bbc.com",
  "cnn.com",
  "nytimes.com",
  "washingtonpost.com",
  "theatlantic.com",
  "docs.google.com",
];

// ─── Backend URL ───

export const BACKEND_URL =
  process.env.ODDITY_BACKEND_URL ?? "https://oddity1-backend.vercel.app";

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
    sallyPersonality: false,
    customPdfSubtitle: false,
    pdfAnnotation: false,
    sketchPad: false,
    publicFigurePersonas: false,
    googleDocs: false,
  },
  standard: {
    sallyPersonality: true,
    customPdfSubtitle: true,
    pdfAnnotation: true,
    sketchPad: true,
    publicFigurePersonas: true,
    googleDocs: true,
  },
} as const satisfies Record<UserTier, Record<string, boolean>>;

export function canUseFeature(
  tier: UserTier,
  feature: PlanFeatureKey,
): boolean {
  return PLAN_FEATURES[tier]?.[feature] ?? false;
}

// ─── LLM Providers (BYOK) ───

export const LLM_PROVIDERS: LlmProvider[] = [
  "oddity-free",
  "openrouter",
  "openai",
  "anthropic",
  "gemini",
  "muse",
];

export const LLM_EFFORT_OPTIONS: LlmReasoningEffort[] = [
  "default",
  "none",
  "low",
  "medium",
  "high",
];

export type LlmProviderMeta = {
  label: string;
  needsKey: boolean;
  keyUrl: string | null;
  modelPlaceholder: string;
  note: string;
  /** Whether the transport honors the reasoning-effort setting. */
  effortSupported: boolean;
};

export const LLM_PROVIDER_META: Record<LlmProvider, LlmProviderMeta> = {
  "oddity-free": {
    label: "Oddity Free",
    needsKey: false,
    keyUrl: null,
    modelPlaceholder: "",
    note: "Free and unlimited, served from shared capacity. May be slow or unstable at peak times.",
    effortSupported: true,
  },
  openrouter: {
    label: "OpenRouter",
    needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
    modelPlaceholder: "meta/muse-spark-1.3-contributor",
    note: "Any OpenRouter model ID, including :free models.",
    effortSupported: true,
  },
  openai: {
    label: "OpenAI",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    modelPlaceholder: "gpt-5-mini",
    note: "Native model ID, e.g. gpt-5-mini or gpt-5.",
    effortSupported: true,
  },
  anthropic: {
    label: "Anthropic",
    needsKey: true,
    keyUrl: "https://console.anthropic.com/",
    modelPlaceholder: "claude-sonnet-4-5",
    note: "Native model ID, e.g. claude-sonnet-4-5.",
    effortSupported: true,
  },
  gemini: {
    label: "Gemini",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/",
    modelPlaceholder: "gemini-2.5-flash",
    note: "Native model ID, e.g. gemini-2.5-flash.",
    effortSupported: false,
  },
  muse: {
    label: "Meta Muse",
    needsKey: true,
    keyUrl: "https://dev.meta.ai/",
    modelPlaceholder: "muse-spark-1.3",
    note: "Meta Model API key (MODEL_API_KEY).",
    effortSupported: false,
  },
};

/**
 * Whether an OpenAI model accepts the reasoning-effort parameter.
 * Single source of truth shared by the transport (which omits the parameter
 * otherwise) and the settings UIs (which disable the control otherwise).
 */
export function isOpenAiReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model.trim());
}

/**
 * Whether the reasoning-effort setting has any effect for a provider+model
 * pair. `model` is the effective model: the form value, or the provider's
 * placeholder when the field is empty and the backend falls back to it.
 */
export function modelSupportsEffort(
  provider: LlmProvider,
  model: string,
): boolean {
  if (!LLM_PROVIDER_META[provider].effortSupported) return false;
  if (provider === "openai") return isOpenAiReasoningModel(model);
  return true;
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
  // Terry/Sally — Critical (red)
  caveat: "#F5574C",
  counterargument: "#F5574C",
  alternative: "#F5574C",
  fallacy: "#F5574C",
  criteria: "#F5574C",
  perspective: "#F5574C",
  consequence: "#F5574C",
  decision_making: "#F5574C",
  // Terry/Sally — Enrichment (green)
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
  // Terry/Sally — Critical (red)
  caveat: "#F5574C",
  counterargument: "#F5574C",
  alternative: "#F5574C",
  fallacy: "#F5574C",
  criteria: "#F5574C",
  perspective: "#F5574C",
  consequence: "#F5574C",
  decision_making: "#F5574C",
  // Terry/Sally — Enrichment (green)
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
  return (
    (theme === "light" ? ANNOTATION_COLORS_LIGHT : ANNOTATION_COLORS)[type] ??
    "#888"
  );
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
