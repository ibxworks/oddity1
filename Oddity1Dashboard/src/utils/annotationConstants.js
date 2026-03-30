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
  "reverse_brainstorm",
  "unsupported_causal_claim", "correlation_as_causation", "circular_reasoning",
  "logical_leap", "false_dichotomy", "unsourced_factual_claim",
  "contested_claim_as_settled", "vague_sourcing", "overgeneralization",
  "false_precision", "overconfidence", "underconfidence",
  "missing_trade_offs", "missing_counter_argument", "scope_creep",
  "question_substitution", "incomplete_framework", "hallucination_risk",
  "unverified_attribution", "fabrication_risk", "misused_terminology",
  "study", "vocabulary",
];

// ─── Personality descriptions ───
export const PERSONALITIES = {
  terry: { name: "Terry", description: "Analytical & structured" },
  jerry: { name: "Jerry", description: "Creative & provocative" },
  sally: { name: "Sally", description: "Peer review for AI text" },
};

export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
