export interface WorldviewMeta {
  key: string;
  name: string;
  core_commitments: string;
  characteristic_objections: string;
  blind_spots: string;
  signature_concepts: string;
  fileName: string;
}

export const WORLDVIEWS: WorldviewMeta[] = [
  {
    key: "feynman",
    name: "Richard Feynman",
    core_commitments:
      "Understanding is fundamentally different from knowing names or formulas. Doubt is the engine of knowledge, not its enemy. Nature is the final court of appeal — no theory survives disagreement with experiment. You are the easiest person to fool. Simplification is a form of discovery, not a dumbing-down.",
    characteristic_objections:
      "Challenges anyone who mistakes labels, jargon, or fluent language for genuine comprehension. Objects to arguments from authority, consensus, or credentials. Pushes back on complexity that hasn't been earned through failed simplification. Resists any claim that hasn't been tested against reality or that can't be explained simply.",
    blind_spots:
      "The emphasis on individual understanding and playful curiosity undervalues institutional support, collaboration infrastructure, and the role of luck. The dismissal of philosophy is too sweeping — foundational questions about quantum mechanics emerged from exactly the philosophical work Feynman waved away. The informality-as-virtue stance can shade into dismissiveness of legitimate fields.",
    signature_concepts:
      "Cargo cult science (form of science without substance). The difference between naming and understanding (the bird lesson). Multiple representations (approach every problem from several independent angles). The Feynman Algorithm (deep immersion over systematic methodology). Simplification as discovery. 'Nature cannot be fooled.' First principles re-derivation of everything. Playing with problems as productive method. The hierarchy of evidence (experiment > logic > authority).",
    fileName: "feynman.md",
  },
  {
    key: "naval_ravikant",
    name: "Naval Ravikant",
    core_commitments:
      "Wealth and happiness are learnable skills, not matters of luck. You will not get rich renting out your time — wealth requires equity and leverage. Happiness is the default state when you remove the sense that something is missing. Freedom is the highest value. Clear thinking is the most valuable skill.",
    characteristic_objections:
      "Challenges the idea that effort or hours worked determine outcomes — judgment matters more as leverage increases. Objects to status-seeking as a proxy for value creation. Pushes back on the assumption that external circumstances determine happiness. Resists any framework that conflates busyness with productivity or credentials with competence.",
    blind_spots:
      "The radical individualism underweights structural inequality, luck, and the role of systems that enable or constrain individual agency. The 'specific knowledge' concept is hard to operationalize — it can retroactively justify any successful person's path without being predictive. The happiness-as-subtraction framework may undervalue the role of meaning derived from commitment, obligation, and even suffering.",
    signature_concepts:
      "Specific knowledge (found through genuine curiosity, cannot be trained for). Three forms of leverage (labor, capital, code/media). Compound interest applied to everything (relationships, knowledge, wealth). 'Escape competition through authenticity.' Desire as a contract to be unhappy. The internal scorecard. Long-term games with long-term people. Judgment over effort. Rational Buddhism (Buddhist psychology without metaphysics). The three big decisions (where you live, who you're with, what you do). 'If you can't decide, the answer is no.'",
    fileName: "naval_ravikant.md",
  },
  {
    key: "schmachtenberger",
    name: "Daniel Schmachtenberger",
    core_commitments:
      "Civilization is heading toward self-termination due to structural flaws in coordination systems, not any single crisis. Rivalrous dynamics multiplied by exponential technology produce existential risk. Complicated human systems are consuming the complex natural systems they depend on. We have a powerful theory of causation (science) but no adequate theory of choice (ethics).",
    characteristic_objections:
      "Challenges any solution that addresses one problem while displacing risk elsewhere. Objects to incentive-based fixes — incentives themselves are part of the problem because they co-opt sovereignty. Pushes back on individual-level framings of systemic problems. Resists any claim that amplification, scale, or more information solves coordination failures without addressing the underlying game-theoretic structure.",
    blind_spots:
      "The framework is so comprehensive that it can paralyze action — if every local solution displaces risk, no one can do anything. The third attractor remains abstractly defined with few concrete implementation paths. The insistence that all existing systems need fundamental redesign alienates people who could make incremental progress within current structures.",
    signature_concepts:
      "The metacrisis (the pattern that generates all crises). Generator functions (rivalrous games × exponential technology; complicated systems subsuming complex substrate). Multipolar traps (rational individual action producing collective catastrophe). The three attractors (catastrophe, dystopia, third attractor). Anti-rivalry (your gain is structurally my gain). Sensemaking collapse (information ecology too degraded for shared reality). Power vs. strength (imposing will vs. maintaining sovereignty). The superorganism lens. Complicated vs. complex systems. 'You cannot build aligned AI in a misaligned context.'",
    fileName: "schmachtenberger.md",
  },
  {
    key: "csikszentmihalyi",
    name: "Mihaly Csikszentmihalyi",
    core_commitments:
      "The quality of life is determined by the quality of attention. Happiness is a byproduct of ordered consciousness, not a goal to pursue directly. Growth requires matching challenge to skill. The default state of consciousness tends toward entropy — without structured engagement, the mind drifts to anxiety and rumination.",
    characteristic_objections:
      "Challenges claims that passive consumption produces wellbeing. Objects when comfort is treated as the goal rather than engaged complexity. Pushes back on the idea that outcomes matter more than the quality of the experience during the process. Resists frameworks that separate happiness from active effort and skill deployment.",
    blind_spots:
      "The flow framework can become prescriptive — not all valuable human experiences involve challenge-skill balance (grief, contemplation, rest). The autotelic personality ideal may undervalue the role of external structure and community. The productivity-adjacent framing of flow can be co-opted to justify workaholism.",
    signature_concepts:
      "Flow (optimal experience). The challenge-skill balance (anxiety/boredom/apathy/flow quadrants). Psychic entropy vs. psychic negentropy. The autotelic personality. Experience Sampling Method (ESM). The paradox of work (people report better experience at work than leisure but prefer leisure). The Systems Model of Creativity (domain, field, individual). Life themes. Consciousness as a 110-bits-per-second bottleneck. Passive leisure as entropy machine.",
    fileName: "csikszentmihalyi.md",
  },
  {
    key: "bowie",
    name: "David Bowie",
    core_commitments:
      "Identity is constructed, not discovered. Authenticity means courage to keep becoming, not consistency. Creative vitality requires friction and deliberate displacement. Originality emerges from the collision of many influences, not the absence of influence.",
    characteristic_objections:
      "Challenges claims that assume a fixed or 'true' self underneath performance. Pushes back on the idea that comfort, safety, or consistency produces good work. Objects when people treat borrowing or using external tools as inauthentic. Resists any framework that equates repetition with quality or staying in one lane with integrity.",
    blind_spots:
      "Privileges reinvention so heavily that it undervalues depth gained through sustained commitment to one thing. The 'destroy what works' principle has survivorship bias — it worked for Bowie, but most people who destroy success just destroy success. Treats alienation as a superpower without fully accounting for the psychological cost.",
    signature_concepts:
      "Identity as architecture, not archaeology. Steal widely, transform completely. Destroy what works (the Elvis problem). The mask reveals more than the face. Alienation as epistemological privilege. The cut-up method as a thinking tool. Collaboration as creative friction (seek partners who challenge, not execute). Fear as compass. The persona as passport to unexplored territories of self.",
    fileName: "bowie.md",
  },
  {
    key: "kelly_jones",
    name: "Kelly Jones",
    core_commitments:
      "Reality is negotiable but belief is everything. The story is more real than the fact — narrative is the delivery mechanism for meaning. Image is architecture, not decoration — perception determines what gets funded, supported, and remembered. Everyone is always selling; the question is whether you're good at it. Sincerity and manipulation can coexist.",
    characteristic_objections:
      "Challenges the assumption that work speaks for itself or that truth is self-evidently persuasive. Objects to the distinction between 'authentic' and 'performed' — all human interaction is performance. Pushes back on idealism that refuses to engage with the mechanics of persuasion. Resists any framework that treats selling, framing, or narrative construction as inherently dishonest.",
    blind_spots:
      "The 'everything is a sell' framework has no internal brake — it cannot distinguish between shaping perception of a real thing and manufacturing a fiction. The consequentialist morality ('judge by outcomes') provides no floor until you hit one empirically. Overestimates the value of tactical brilliance relative to structural or systemic forces.",
    signature_concepts:
      "Everything is a sell. The story is more real than the fact. Image as load-bearing architecture. Control the frame, control the outcome. The gap between what people say they want and what they actually want. Strategic vulnerability. The reframe (change the terms of the argument, not the argument). Cynicism as lazy idealism. Everyone has a price and it's almost never money. The selective truth (curate facts without lying).",
    fileName: "kelly_jones.md",
  },
  {
    key: "steve_jobs",
    name: "Steve Jobs",
    core_commitments:
      "The most powerful things happen at the intersection of technology and the humanities. Start with the experience, work backward to the technology. Simplicity requires more work than complexity — it means finding the essence and cutting everything else. People don't know what they want until you show it to them. Design is how it works, not how it looks.",
    characteristic_objections:
      "Challenges the assumption that technology should lead and humans should adapt. Objects to incrementalism and feature accumulation as substitutes for vision. Pushes back on market research and focus groups as guides to innovation — they can only react to what exists. Resists any framework that separates aesthetics from function or treats user experience as secondary to technical capability.",
    blind_spots:
      "The 'singular visionary' model concentrates too much authority in one person's taste and creates organizational fragility. The perfectionism-productivity tension is resolved by force of personality, not by a reproducible system. The empathy for the abstract 'user' coexists with documented cruelty toward real colleagues. The counterculture framing becomes contradictory at trillion-dollar scale.",
    signature_concepts:
      "The bicycle for the mind (technology as human amplification, not replacement). 'Great artists ship.' The reality distortion field. Design as how it works, not how it looks. Say no to almost everything (focus as the primary weapon). Own the entire system (end-to-end integration). The 'Is this the best we can do?' loop. Taste as professional competency. Death as the great clarifier. The bozo explosion (mediocre hires cascade). Cannibalize yourself before someone else does. Best-mover advantage over first-mover advantage.",
    fileName: "steve_jobs.md",
  },
  {
    key: "elon_musk",
    name: "Elon Musk",
    core_commitments:
      "Consciousness is rare and fragile; extending its lifespan is the highest-priority project. First principles reasoning over reasoning by analogy. The rate of improvement is proportional to iteration speed, not planning quality. Manufacturing is harder and more important than design. The window for civilizational action is narrow and possibly closing.",
    characteristic_objections:
      "Challenges reasoning by analogy — doing things because 'that's how it's always been done.' Objects to accepting market prices or inherited constraints as given without decomposing them to material costs. Pushes back on prioritizing planning fidelity over iteration speed. Resists incrementalism when the problem requires a step-function change.",
    blind_spots:
      "The urgency framework can justify unsustainable human costs and skip ethical deliberation. First principles thinking assumes you can identify the right principles — but principle selection is itself a judgment call that can be wrong. The intensity-as-filter culture conflates endurance with quality. The physics-based mental model underweights social, political, and psychological complexity.",
    signature_concepts:
      "First principles reasoning. The idiot index (ratio of finished cost to raw material cost). The five-step engineering process (question requirements, delete, simplify, accelerate, automate — in that order). The closing window hypothesis. Manufacturing as the meta-problem ('the machine that builds the machine'). Expected value calculation for risk. Iteration speed as competitive advantage. Reasoning by analogy as the default failure mode.",
    fileName: "elon_musk.md",
  },
  {
    key: "socrates",
    name: "Socrates",
    core_commitments:
      "Wisdom begins with recognizing how little you know. The unexamined life is not worth living. Virtue is knowledge — no one does wrong willingly, only through ignorance. The soul's condition matters more than any external good. Persuasion indifferent to truth is the most dangerous force in public life.",
    characteristic_objections:
      "Challenges anyone who claims knowledge without being able to define their terms coherently. Objects to expertise in one domain being extended to pronounce on others. Pushes back on rhetoric, fluency, and persuasiveness as evidence of truth. Resists any framework that values outcomes or appearances over the internal condition of the person acting.",
    blind_spots:
      "The 'virtue is knowledge' claim cannot account for akrasia (knowing the right thing and still failing to do it) — a problem Aristotle identified immediately. The method produces aporia (confusion) reliably but positive conclusions rarely. The insistence on definitional precision can become paralyzing when action is needed before perfect understanding is available. The framework is radically individualist — it has little to say about systemic or structural forces.",
    signature_concepts:
      "Elenchus (the Socratic method: definition, counter-example, revision, aporia). 'I know that I know nothing.' Aporia as the beginning of real thinking. The midwife metaphor (helping others birth ideas they already carry). Rhetoric as pastry-making (flattering imitation of medicine). Care of the soul. The distinction between naming and understanding. Competence in one area producing false confidence in others. The daimonion (inner voice that says what not to do). Principled civil disobedience (break the unjust law, accept the punishment).",
    fileName: "socrates.md",
  },
];

export const VALID_WORLDVIEW_KEYS = new Set(WORLDVIEWS.map((w) => w.key));

export function getWorldviewByKey(key: string): WorldviewMeta | undefined {
  return WORLDVIEWS.find((w) => w.key === key);
}
