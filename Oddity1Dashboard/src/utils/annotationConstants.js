// Annotation types, colors, and labels — duplicated from packages/shared/src/constants.ts
// for use in the webapp without importing from the extension monorepo.

export const ANNOTATION_COLORS = {
  highlight: "#FFDD69",
  recall: "#50B87A",
  provoking_question: "#F5574C",
  insight: "#50B87A",
  caveat: "#F5574C",
  vocabulary: "#50B87A",
};

export const ANNOTATION_LABELS = {
  highlight: "KEY PHRASE",
  recall: "RECALL",
  provoking_question: "PROVOCATION",
  insight: "INSIGHT",
  caveat: "CAVEAT",
  vocabulary: "VOCABULARY",
};

export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
