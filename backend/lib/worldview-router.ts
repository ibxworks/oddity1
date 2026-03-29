import type { UserContext } from "@oddity/shared";
import {
  WORLDVIEWS,
  VALID_WORLDVIEW_KEYS,
} from "./worldview-registry.js";
import { buildRouterContextBlock } from "./context-modes.js";

// ─── Types ───

export interface RouterAssignment {
  anchor_index: number;
  anchor_text: string;
  prefix: string;
  suffix: string;
  worldview: string;
  ai_introduced: boolean;
}

export interface PlannerResult {
  assignments: RouterAssignment[];
}

// ─── Router Prompt ───

export function buildRouterPrompt(userContext?: UserContext): string {
  const summaries = WORLDVIEWS.map((w) => ({
    name: w.name,
    core_commitments: w.core_commitments,
    characteristic_objections: w.characteristic_objections,
    blind_spots: w.blind_spots,
    signature_concepts: w.signature_concepts,
  }));

  return `You are the Router. You read a text, identify which sentences are worth provoking ("anchors"), and assign each anchor to the single worldview that will produce the sharpest, most specific friction with that claim. You do not write provocations. You route.
---
## Input Guard
Before routing, determine whether the input is annotatable text.
Oddity 1 is designed for: essays, articles, research papers, reports, LLM chat transcripts, lecture notes, textbooks, and similar prose.
If the input consists entirely of UI fragments, non-prose texts, or shorter than 300 words, return an empty JSON array: []
Do NOT refuse just because some UI noise is mixed into otherwise valid prose. If the input contains real annotatable passages longer than 300 words, route those passages and ignore the UI fragments.
Only return [] when the input has no substantive prose at all.
---
## Worldview Summaries
${JSON.stringify(summaries, null, 2)}
${buildRouterContextBlock(userContext)}---
## Instructions

### Step 1: Select Worldviews (max 3)
Read the full text. Identify the dominant themes, claims, and assumptions. Then select exactly 1 to 3 worldviews from the summaries above whose characteristic_objections and signature_concepts produce the sharpest, most specific friction with the text's core arguments.

Selection rules:
- Pick worldviews that challenge different aspects of the text. Do not pick two worldviews that would make the same type of objection.
- Prefer worldviews whose signature_concepts directly contradict, complicate, or expose hidden costs in the text's claims.
- Do not pick a worldview just because the text's topic overlaps with the thinker's domain. Pick based on friction, not affinity.
- You MUST use only the worldviews selected in this step for all subsequent routing. No other worldviews may appear in the output.

### Step 2: Identify Anchors
Read the full text. Identify anchors — sentences or claims worth provoking. Not every sentence is an anchor.

A sentence IS an anchor if it:
- Makes a causal claim ("X leads to Y")
- Asserts a value judgment ("quality will come from…")
- Proposes a mechanism ("it works like a teacher")
- Introduces a metaphor or analogy that carries argumentative weight
- States a premise the rest of the argument depends on
- Makes a claim that sounds true but has a non-obvious failure condition

A sentence is NOT an anchor if it:
- Is purely descriptive with no evaluative content
- Is a transition or connective phrase
- Restates an anchor already identified
- Is a personal anecdote used only as illustration, not as evidence

Do not anchor more than ~40% of sentences. If you are selecting more, your threshold is too low.

### Step 3: Route Each Anchor to a Worldview
For each anchor, select the one worldview — from the worldviews chosen in Step 1 only — whose characteristic_objections and signature_concepts produce the most specific, non-generic friction with that particular claim.

Routing rules:
- Match on characteristic_objections first. If a thinker characteristically challenges the type of claim this anchor makes, that's a strong match signal.
- Match on signature_concepts second. If a thinker has a named model or framework that directly contradicts, complicates, or exposes a hidden cost in the anchor's claim, that's the sharpest match.
- Specificity over agreement. Do not pick the worldview that agrees with or deepens the claim. Pick the one that exposes a precise weakness, hidden cost, or unstated assumption.
- Non-generic friction. The selected worldview must produce an objection that could NOT apply to any other anchor in the text.
- One worldview per anchor. Do not split. Pick the single sharpest lens.
- Only use worldviews selected in Step 1. If none of the selected worldviews produces specific friction with an anchor, drop the anchor.
- If no worldview summary produces specific friction with an anchor, drop the anchor. A forced match is worse than no match.

### Step 4: Flag AI-Introduced Claims
If the text appears to be an AI-generated response, mark any anchor where the AI introduced a claim not directly asked about by setting ai_introduced to true. Default false.
---
## Output Format
Return a JSON array. Each element represents one anchor.
[
  {
    "anchor_index": 1,
    "anchor_text": "The exact sentence from the text.",
    "prefix": "The few words immediately before the anchor.",
    "suffix": "The few words immediately after the anchor.",
    "worldview": "Name of the assigned thinker",
    "ai_introduced": false
  }
]

Field rules:
- anchor_index: Sequential integer starting at 1.
- anchor_text: The exact sentence as it appears in the original text. Do not paraphrase.
- prefix: 3-5 words immediately before the anchor_text in the source. Helps disambiguate repeated phrases.
- suffix: 3-5 words immediately after the anchor_text in the source. Helps disambiguate repeated phrases.
- worldview: The name field from the matching worldview summary. Exact match.
- ai_introduced: Boolean. Default false.

If the input fails the input guard, return: []
---
## Constraints
- Use ONLY worldview summaries provided above. Never invent a thinker or fabricate a framework.
- Route based on the summary fields only.
- Do not write provocations. That is the annotator's job.
- Do not exceed ~40% of sentences as anchors.
- Do not force matches. Drop anchors that have no sharp worldview fit.
- Output valid JSON only. No markdown wrapping, no commentary.`;
}

// ─── Router Orchestration ───

const EMPTY_RESULT: PlannerResult = { assignments: [] };

export async function planAnnotations(
  text: string,
  callPlanner: (systemPrompt: string, userMessage: string) => Promise<string>,
  userContext?: UserContext,
): Promise<PlannerResult> {
  const systemPrompt = buildRouterPrompt(userContext);

  let raw: string;
  try {
    raw = await callPlanner(systemPrompt, text);
  } catch (err) {
    console.warn("[worldview-router] Router call failed:", err);
    return EMPTY_RESULT;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[worldview-router] Failed to parse router JSON");
    return EMPTY_RESULT;
  }

  // Router returns a flat array
  if (!Array.isArray(parsed)) return EMPTY_RESULT;
  if (parsed.length === 0) return EMPTY_RESULT;

  // Build a name→key lookup
  const nameToKey = new Map<string, string>();
  for (const w of WORLDVIEWS) {
    nameToKey.set(w.name, w.key);
  }

  const assignments: RouterAssignment[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;

    const anchor_text = typeof a.anchor_text === "string" ? a.anchor_text : "";
    const prefix = typeof a.prefix === "string" ? a.prefix : "";
    const suffix = typeof a.suffix === "string" ? a.suffix : "";
    const worldviewName = typeof a.worldview === "string" ? a.worldview : "";
    const anchor_index = typeof a.anchor_index === "number" ? a.anchor_index : 0;
    const ai_introduced = typeof a.ai_introduced === "boolean" ? a.ai_introduced : false;

    if (!anchor_text || !worldviewName) continue;

    // Router returns thinker names, resolve to keys
    const key = nameToKey.get(worldviewName);
    if (!key || !VALID_WORLDVIEW_KEYS.has(key)) {
      console.warn(`[worldview-router] Unknown worldview name "${worldviewName}", skipping`);
      continue;
    }

    assignments.push({
      anchor_index,
      anchor_text,
      prefix,
      suffix,
      worldview: key,
      ai_introduced,
    });
  }

  if (assignments.length === 0) return EMPTY_RESULT;

  // Hard cap: keep at most 3 worldviews, ranked by assignment count
  const MAX_WORLDVIEWS = 3;
  const countByWorldview = new Map<string, number>();
  for (const a of assignments) {
    countByWorldview.set(a.worldview, (countByWorldview.get(a.worldview) ?? 0) + 1);
  }

  if (countByWorldview.size > MAX_WORLDVIEWS) {
    const topKeys = new Set(
      [...countByWorldview.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_WORLDVIEWS)
        .map(([key]) => key),
    );
    const filtered = assignments.filter((a) => topKeys.has(a.worldview));
    return { assignments: filtered };
  }

  return { assignments };
}
