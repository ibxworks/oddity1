import {
  WORLDVIEWS,
  VALID_WORLDVIEW_KEYS,
} from "./worldview-registry.js";

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

export function buildRouterPrompt(): string {
  const summaries = WORLDVIEWS.map((w) => ({
    name: w.name,
    core_commitments: w.core_commitments,
    characteristic_objections: w.characteristic_objections,
    blind_spots: w.blind_spots,
    signature_concepts: w.signature_concepts,
  }));

  return `You are the Router. Identify sentences worth provoking ("anchors") and assign each to the worldview that produces the sharpest friction. You route, not annotate.
---
## Input Guard
If input is entirely non-prose (UI fragments, code, etc.) or shorter than 300 words, return: []
If prose is mixed with non-prose, route the prose and ignore the rest.
---
## Worldview Summaries
${JSON.stringify(summaries, null, 2)}
---
## Instructions

### Step 1: Select Worldviews (max 3)
Select 1-3 worldviews whose characteristic_objections and signature_concepts produce the sharpest friction with the text's core arguments.
- Each worldview must challenge a different aspect. No redundant objections.
- Pick based on friction, not topic affinity.

### Step 2: Identify Anchors
Anchor sentences that make causal claims, value judgments, propose mechanisms, carry argumentative metaphors, state load-bearing premises, or sound true but have non-obvious failure conditions.
Skip purely descriptive, transitional, redundant, or merely illustrative sentences.
Max ~40% of sentences.

### Step 3: Route Each Anchor
Assign each anchor to the one worldview (from Step 1 only) with the most specific friction.
- Match characteristic_objections first, signature_concepts second.
- Friction must be specific to THIS anchor, not generic.
- Drop anchors with no sharp fit. A forced match is worse than no match.

### Step 4: Flag AI-Introduced Claims
If the text is AI-generated, set ai_introduced: true for claims the AI introduced unprompted. Default false.
---
## Output Format
Return a JSON array only. No markdown, no commentary.
[
  {
    "anchor_index": 1,
    "anchor_text": "Exact sentence from the text.",
    "prefix": "3-5 words before anchor.",
    "suffix": "3-5 words after anchor.",
    "worldview": "Exact name from summaries.",
    "ai_introduced": false
  }
]
If input fails the guard, return: []`;
}

// ─── Router Orchestration ───

const EMPTY_RESULT: PlannerResult = { assignments: [] };

export async function planAnnotations(
  text: string,
  callPlanner: (systemPrompt: string, userMessage: string) => Promise<string>,
): Promise<PlannerResult> {
  const systemPrompt = buildRouterPrompt();

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

/**
 * Parse a single raw JSON object from the router stream into a RouterAssignment.
 * Returns undefined if the object is invalid.
 */
function parseRouterItem(
  raw: string,
  nameToKey: Map<string, string>,
): RouterAssignment | undefined {
  let item: unknown;
  try {
    item = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!item || typeof item !== "object") return undefined;
  const a = item as Record<string, unknown>;

  const anchor_text = typeof a.anchor_text === "string" ? a.anchor_text : "";
  const prefix = typeof a.prefix === "string" ? a.prefix : "";
  const suffix = typeof a.suffix === "string" ? a.suffix : "";
  const worldviewName = typeof a.worldview === "string" ? a.worldview : "";
  const anchor_index = typeof a.anchor_index === "number" ? a.anchor_index : 0;
  const ai_introduced = typeof a.ai_introduced === "boolean" ? a.ai_introduced : false;

  if (!anchor_text || !worldviewName) return undefined;

  const key = nameToKey.get(worldviewName);
  if (!key || !VALID_WORLDVIEW_KEYS.has(key)) {
    console.warn(`[worldview-router] Unknown worldview name "${worldviewName}", skipping`);
    return undefined;
  }

  return { anchor_index, anchor_text, prefix, suffix, worldview: key, ai_introduced };
}

/**
 * Streaming router: yields individual RouterAssignment objects as the LLM
 * streams them. The caller should collect all yielded assignments and apply
 * the worldview cap (max 3) after the generator completes.
 */
export async function* planAnnotationsStream(
  text: string,
  callPlannerStream: (systemPrompt: string, userMessage: string) => AsyncGenerator<string, void, unknown>,
): AsyncGenerator<RouterAssignment, RouterAssignment[], unknown> {
  const systemPrompt = buildRouterPrompt();

  const nameToKey = new Map<string, string>();
  for (const w of WORLDVIEWS) {
    nameToKey.set(w.name, w.key);
  }

  const allAssignments: RouterAssignment[] = [];

  try {
    for await (const objStr of callPlannerStream(systemPrompt, text)) {
      const assignment = parseRouterItem(objStr, nameToKey);
      if (assignment) {
        allAssignments.push(assignment);
        yield assignment;
      }
    }
  } catch (err) {
    console.warn("[worldview-router] Streaming router call failed:", err);
  }

  return allAssignments;
}
