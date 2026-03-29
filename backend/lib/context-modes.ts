import type { UserContextMode, UserContext } from "@oddity/shared";

export interface ContextModeInstructions {
  routerSection: string;
  annotatorSection: string;
}

export const CONTEXT_MODE_INSTRUCTIONS: Record<UserContextMode, ContextModeInstructions> = {
  "info-takeaway": {
    routerSection: `USER INTENT: Extract reliable facts. The user wants to know what's real vs. what just sounds convincing.
Anchor claims that present themselves as facts, data, or evidence — especially ones that sound authoritative but lack sourcing. Ignore opinion and rhetoric.
Pick worldviews that expose unsupported confidence and missing evidence.`,

    annotatorSection: `USER INTENT: Extract reliable facts. Every annotation must help the user separate grounded claims from confident-sounding nonsense.
Write provocations that pressure-test factual claims: Is there a source? Is this correlation dressed as causation? Would this survive scrutiny?
TAKE = grounded, build on it. CAUTION = sounds factual but rests on an unstated assumption. THROW = packaged as reliable but structurally isn't.`,
  },

  "brainstorm": {
    routerSection: `USER INTENT: Find creative seeds. The user wants raw material for their own ideas — even flawed or half-formed claims are valuable.
Anchor metaphors, novel framings, provocative assertions, and unexpected connections. Include interesting-but-wrong claims. Skip dry factual claims.
Pick worldviews that surface what's generative, not just what's wrong.`,

    annotatorSection: `USER INTENT: Find creative seeds. Every annotation must hand the user something they can riff on, remix, or develop into their own idea.
Write provocations that name what's interesting AND what breaks — so the user can steal the good part and rebuild the rest. Tone: "this is flawed but there's something here."
TAKE = strong seed, use it directly. CAUTION = interesting but needs your own thinking to become usable. THROW = too broken to salvage, but the topic might be worth exploring from scratch.`,
  },

  "argument-formation": {
    routerSection: `USER INTENT: Build a position. The user needs to see the structural skeleton so they can agree, disagree, or refine.
Anchor load-bearing claims: premises, logical dependencies, value judgments — the sentences where if they fall, the argument collapses. Skip examples and rhetorical flourish.
Pick worldviews that expose logical structure and surface counter-arguments.`,

    annotatorSection: `USER INTENT: Build a position. Every annotation must force the user to take a stance — agree with specificity, disagree with precision, or refine with a better version.
Write provocations that expose the claim's logical skeleton: What must you believe for this to hold? What's the strongest counter-argument? After reading, neutrality on this claim should feel impossible.
TAKE = load-bearing and it holds. CAUTION = doing structural work but has a crack your argument must address. THROW = this structural claim fails — your position should exploit the hole.`,
  },

  "decision": {
    routerSection: `USER INTENT: Decide whether to act. The user needs to know what could go wrong if they follow this advice.
Anchor recommendations, prescriptions, "you should" statements, and promised outcomes — especially where following the advice has high-cost or irreversible consequences. Skip theory.
Pick worldviews that expose implementation risks, hidden costs, and conditions where advice backfires.`,

    annotatorSection: `USER INTENT: Decide whether to act. Every annotation must answer: "If I follow this, what could go wrong that the text doesn't warn me about?"
Write provocations that are protective — look out for the user's interests against persuasive but incomplete advice. Surface hidden costs, survivorship bias, and conditions where the recommendation breaks.
TAKE = safe to act on, risks are low or acknowledged. CAUTION = could work but has a hidden cost the text doesn't mention. THROW = dangerous to follow as stated — the downside is hidden or the advice doesn't survive reality.`,
  },

  "learning": {
    routerSection: `USER INTENT: Learn a new topic. The user is a newcomer who needs help catching what they might misunderstand.
Anchor oversimplifications presented as complete explanations, loose jargon, missing context, and misleading analogies. Focus on foundational claims that, if misunderstood now, compound into larger confusion later. Skip expert-level nuance.
Pick worldviews that calibrate understanding — exposing what's simpler or more complex than the text makes it seem.`,

    annotatorSection: `USER INTENT: Learn a new topic. Every annotation must calibrate the user's confidence — prevent them from thinking they understand more (or less) than they actually do.
Write provocations that say "this is simpler than it sounds" or "this is more complex than the text admits." Name what the text leaves out that a deeper treatment would include — not to overwhelm, but to prevent false confidence.
TAKE = reliable foundation, build on it. CAUTION = useful simplification but will need revision as you learn more. THROW = will actively mislead you if taken at face value.`,
  },
};

/**
 * Build a prompt section for user context (router).
 * Returns empty string when no mode is set (default behavior).
 */
export function buildRouterContextBlock(userContext?: UserContext): string {
  if (!userContext?.mode) return "";
  const instructions = CONTEXT_MODE_INSTRUCTIONS[userContext.mode];
  let block = `\n---\n## User Context\n${instructions.routerSection}`;
  if (userContext.note) {
    block += `\n\nUser's stated purpose: "${userContext.note}" — weight routing decisions toward this intent.`;
  }
  return block;
}

/**
 * Build an annotator prompt section for user context.
 * Returns empty string when no mode is set (default behavior).
 */
export function buildAnnotatorContextBlock(userContext?: UserContext): string {
  if (!userContext?.mode) return "";
  const instructions = CONTEXT_MODE_INSTRUCTIONS[userContext.mode];
  let block = `\n---\n## User Context\nCRITICAL: The user's reading intent MUST shape every annotation. Do not write generic provocations — tailor tone, focus, and verdict to this intent.\n\n${instructions.annotatorSection}`;
  if (userContext.note) {
    block += `\n\nUser's stated purpose: "${userContext.note}" — every provocation must serve this specific goal.`;
  }
  return block;
}
