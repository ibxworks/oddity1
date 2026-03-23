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
  terry: { name: "Terry", description: "Analytical & structured" },
  jerry: { name: "Jerry", description: "Creative & provocative" },
  sally: { name: "Sally", description: "Practical & thorough" },
};

export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
