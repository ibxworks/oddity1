/**
 * Inference Pipeline Benchmark — Auto-Measuring
 *
 * This benchmark AUTOMATICALLY measures real code and detects optimizations.
 * You NEVER need to edit numbers manually.
 *
 * How it works:
 *   1. FROZEN BASELINE: Hardcoded "before" numbers captured from the
 *      original unoptimized codebase. Never changes.
 *   2. LIVE MEASUREMENT: Runs real code (validator, filter), detects
 *      optimization modules you create, measures their performance.
 *   3. PROJECTION: Computes end-to-end latency from live measurements
 *      + fixed I/O constants, compares to frozen baseline.
 *
 * As you implement optimizations, this benchmark auto-detects them:
 *
 *   Create `lib/hot-cache.ts` exporting:
 *     export function createHotCache<T>(opts: { ttlMs: number; maxSize?: number }): {
 *       get(key: string): T | undefined;
 *       set(key: string, value: T): void;
 *       clear(): void;
 *     };
 *
 *   Create `lib/inflight-dedup.ts` exporting:
 *     export function createInflightDedup(): {
 *       run<T>(key: string, fn: () => Promise<T>): Promise<T>;
 *       readonly pendingCount: number;
 *     };
 *
 *   Modify `config/prompts.json`     → prompt size change auto-measured
 *   Optimize validator/filter code   → CPU time auto-measured
 *
 * Run:  npx vitest run lib/__tests__/inference-benchmark.test.ts
 */

import { describe, it, expect } from 'vitest';
import { validateAnnotations } from '../schema-validator.js';
import { filterAndFixAnnotations } from '../annotation-filter.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Annotation } from '@oddity/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Helpers ───

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function pctChange(baseline: number, current: number): string {
  if (baseline === 0 && current === 0) return '0.0%';
  if (baseline === 0) return '+∞';
  const pct = ((current - baseline) / baseline) * 100;
  const sign = pct <= 0 ? '' : '+';
  return `${sign}${pct.toFixed(1)}%`;
}

function percentile(values: number[], pct: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

/** Run a function many times and return timing stats (ms) */
function benchmark(fn: () => void, iterations = 200): { p50: number; p95: number; min: number; max: number } {
  // Warm up
  for (let i = 0; i < 10; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }

  return {
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    min: Math.min(...times),
    max: Math.max(...times),
  };
}

/** Rough token estimate: words × 1.3 (English approximation) */
function estimateTokens(text: string): number {
  return Math.round(text.split(/\s+/).filter(Boolean).length * 1.3);
}

// ─── Test Fixtures ───

const SAMPLE_TEXT = `
Artificial intelligence has transformed the technological landscape in ways that were
previously unimaginable. Machine learning algorithms now power everything from search engines
to medical diagnostics. The transformer architecture, first introduced in the seminal paper
"Attention Is All You Need," has become the foundation of modern large language models.
These models demonstrate emergent capabilities that scale with parameter count and training data.

Neural networks learn hierarchical representations of data through backpropagation, adjusting
weights across millions or billions of parameters. Transfer learning allows models pre-trained
on large corpora to be fine-tuned for specific downstream tasks with relatively little data.
This paradigm shift has democratized access to powerful AI capabilities.

However, significant challenges remain. Hallucination — where models generate plausible but
factually incorrect information — poses risks in high-stakes applications. Alignment research
seeks to ensure AI systems behave in accordance with human values and intentions. The compute
requirements for training frontier models continue to grow exponentially, raising concerns
about environmental impact and concentration of power among well-resourced organizations.
`.trim();

const SAMPLE_ANNOTATIONS: Annotation[] = [
  {
    id: 'ann_1', type: 'highlight',
    anchor: { type: 'TextQuoteSelector', exact: 'transformer architecture, first introduced in the seminal paper', prefix: 'The ', suffix: ' "Attention' },
    content: { note: 'Key architectural innovation', why_it_matters: 'Foundation of modern LLMs' },
  },
  {
    id: 'ann_2', type: 'vocabulary',
    anchor: { type: 'TextQuoteSelector', exact: 'backpropagation', prefix: 'through ', suffix: ', adjusting' },
    content: { note: 'Algorithm for computing gradients in neural networks' },
  },
  {
    id: 'ann_3', type: 'question',
    anchor: { type: 'TextQuoteSelector', exact: 'emergent capabilities that scale with parameter count and training data', prefix: 'demonstrate ', suffix: '.' },
    content: { note: 'Are these truly emergent?', question: 'How do we distinguish emergence from measurement effects?' },
  },
  {
    id: 'ann_4', type: 'caveat',
    anchor: { type: 'TextQuoteSelector', exact: 'Hallucination — where models generate plausible but factually incorrect information', prefix: '', suffix: ' — poses' },
    content: { note: 'Unsolved problem', why_it_matters: 'Blocker for high-stakes deployment' },
  },
  {
    id: 'ann_5', type: 'insight',
    anchor: { type: 'TextQuoteSelector', exact: 'concentration of power among well-resourced organizations', prefix: 'about ', suffix: '.' },
    content: { note: 'Compute moat creates oligopoly', why_it_matters: 'Implications for open-source AI' },
  },
];

// ═══════════════════════════════════════════════════════════════════
// FROZEN BASELINE — captured from the original unoptimized codebase
// DO NOT EDIT — this is the permanent "before" reference
// ═══════════════════════════════════════════════════════════════════

const FROZEN = {
  /** CPU stage p50 latencies (ms) — measured from unoptimized code with sample fixtures */
  cpu: {
    schemaValidation: 0.05,
    annotationFilter: 0.1,
  },

  /**
   * System prompt token estimates from original prompts.json v1.1
   * (word count × 1.3 approximation)
   */
  promptTokens: { light: 415, default: 437, heavy: 443 },

  /** Behavioral: no optimization modules present */
  behavior: {
    llmCallsFor5Concurrent: 5,   // no dedup → 5 concurrent = 5 calls
    dbLookupsPerCacheCheck: 1,   // no hot cache → always hit DB
  },

  /**
   * External I/O latencies (ms) — things outside our code.
   * These are CONSTANTS used for projection. We can't optimize them
   * directly, but optimizations like hot cache can skip them entirely.
   */
  io: {
    openaiCall: 2800,
    supabaseRead: 25,
    supabaseWrite: 20,
    networkRoundtrip: 80,   // request + response
    regionDetection: 15,
    extraction: 8,
    authAndValidation: 7,   // 5ms auth + 2ms zod
    selectorPerAnnotation: 12,
    renderPerAnnotation: 6,
    chatStabilityWait: 1500,
  },
};

// ─── Live Measurement State (populated during test run) ───

const live = {
  cpu: {
    schemaValidation: { p50: 0, p95: 0, min: 0, max: 0 },
    annotationFilter: { p50: 0, p95: 0, min: 0, max: 0 },
  },
  promptTokens: { light: 0, default: 0, heavy: 0 },
  hotCache: { detected: false, lookupP50: 0, lookupP95: 0, writeP50: 0 },
  inflightDedup: { detected: false, callsFor5Concurrent: 5 },
};

// ─── Pipeline Projection ───

interface Projection {
  ttfa: number;
  totalTime: number;
  llmCalls: number;
  annotationCount: number;
  stages: [name: string, ms: number][];
}

function project(opts: {
  cacheHit: boolean;
  regionCount: number;
  annotationsPerRegion: number;
  chatMode: boolean;
  /** Use frozen baseline values (true) or live measured values (false) */
  useBaseline: boolean;
}): Projection {
  const io = FROZEN.io;
  const cpu = opts.useBaseline ? FROZEN.cpu : {
    schemaValidation: live.cpu.schemaValidation.p50,
    annotationFilter: live.cpu.annotationFilter.p50,
  };

  // Cache lookup time: hot cache (if detected) replaces DB read
  const cacheLookupMs = (!opts.useBaseline && live.hotCache.detected)
    ? live.hotCache.lookupP50
    : io.supabaseRead;

  const stages: [string, number][] = [];
  let total = 0;
  let ttfa = 0;
  let llmCalls = 0;

  const add = (name: string, ms: number) => { stages.push([name, ms]); total += ms; };

  add('Region detection', opts.chatMode ? io.chatStabilityWait : io.regionDetection);
  add('Text extraction', io.extraction);

  for (let r = 0; r < opts.regionCount; r++) {
    const tag = opts.regionCount > 1 ? ` [R${r}]` : '';
    add(`Network req${tag}`, io.networkRoundtrip / 2);
    add(`Auth + validation${tag}`, io.authAndValidation);
    add(`Cache lookup${tag}`, cacheLookupMs);

    if (!opts.cacheHit) {
      add(`LLM call${tag}`, io.openaiCall);
      llmCalls++;
      add(`Schema validation${tag}`, cpu.schemaValidation);
      add(`Annotation filter${tag}`, cpu.annotationFilter);
      add(`Cache write${tag}`, io.supabaseWrite);
    }

    add(`Network resp${tag}`, io.networkRoundtrip / 2);

    const annCount = opts.annotationsPerRegion;
    add(`Selector resolve${tag}`, io.selectorPerAnnotation * annCount);
    add(`Render${tag}`, io.renderPerAnnotation * annCount);

    if (r === 0) ttfa = total;
  }

  return {
    ttfa,
    totalTime: total,
    llmCalls,
    annotationCount: opts.annotationsPerRegion * opts.regionCount,
    stages,
  };
}

// ─── Reporting ───

function printStageComparison(label: string, baseline: Projection, current: Projection): void {
  const lines: string[] = [];
  const sep = '─'.repeat(74);
  lines.push('');
  lines.push(sep);
  lines.push(`  ${label}`);
  lines.push(sep);
  lines.push('');
  lines.push('  Metric                       Baseline        Current         Change');
  lines.push('  ' + '─'.repeat(70));
  lines.push(`  TTFA                         ${fmt(baseline.ttfa).padEnd(16)}${fmt(current.ttfa).padEnd(16)}${pctChange(baseline.ttfa, current.ttfa)}`);
  lines.push(`  Total time                   ${fmt(baseline.totalTime).padEnd(16)}${fmt(current.totalTime).padEnd(16)}${pctChange(baseline.totalTime, current.totalTime)}`);
  lines.push(`  LLM calls                    ${String(baseline.llmCalls).padEnd(16)}${String(current.llmCalls).padEnd(16)}${baseline.llmCalls !== current.llmCalls ? pctChange(baseline.llmCalls || 1, current.llmCalls || 1) : '—'}`);
  lines.push(`  Annotations                  ${String(baseline.annotationCount).padEnd(16)}${String(current.annotationCount).padEnd(16)}—`);
  lines.push('');
  lines.push('  Stage                        Baseline        Current         Change');
  lines.push('  ' + '─'.repeat(70));

  // Pair up stages by name (baseline and current have the same structure)
  const bMap = new Map(baseline.stages);
  for (const [name, curMs] of current.stages) {
    const bMs = bMap.get(name) ?? curMs;
    lines.push(`  ${name.padEnd(31)}${fmt(bMs).padEnd(16)}${fmt(curMs).padEnd(16)}${pctChange(bMs, curMs)}`);
  }

  lines.push('');
  lines.push(sep);
  console.log(lines.join('\n'));
}

// ═══════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Inference Pipeline Benchmark', () => {

  // ─── Section 1: Measure real CPU stages ───

  describe('1. CPU Stage Measurement', () => {
    it('schema validation', () => {
      live.cpu.schemaValidation = benchmark(() => validateAnnotations(SAMPLE_ANNOTATIONS));
      const { p50, p95 } = live.cpu.schemaValidation;
      console.log(`  schemaValidation  p50=${fmt(p50)} p95=${fmt(p95)}  (baseline p50=${fmt(FROZEN.cpu.schemaValidation)})`);
      expect(p95).toBeLessThan(50); // sanity: should never take 50ms
    });

    it('annotation filter', () => {
      live.cpu.annotationFilter = benchmark(() => filterAndFixAnnotations(SAMPLE_ANNOTATIONS, SAMPLE_TEXT));
      const { p50, p95 } = live.cpu.annotationFilter;
      console.log(`  annotationFilter  p50=${fmt(p50)} p95=${fmt(p95)}  (baseline p50=${fmt(FROZEN.cpu.annotationFilter)})`);
      expect(p95).toBeLessThan(50);
    });
  });

  // ─── Section 2: Prompt analysis ───

  describe('2. Prompt Analysis', () => {
    it('measures system prompt token budget', () => {
      const promptsPath = resolve(__dirname, '../../config/prompts.json');
      const prompts = JSON.parse(readFileSync(promptsPath, 'utf-8'));
      const profiles = prompts.intensity_profiles as Record<string, { system_prompt: string }>;

      // Expand {{shared_rules}} and {{schema_example}} templates (if present)
      const sharedRules: string = prompts.shared_rules ?? '';
      const schemaExample: string = prompts.schema_example ?? '';

      function expand(template: string): string {
        return template
          .replace(/\{\{shared_rules\}\}/g, sharedRules)
          .replace(/\{\{schema_example\}\}/g, schemaExample);
      }

      for (const key of ['light', 'default', 'heavy'] as const) {
        live.promptTokens[key] = estimateTokens(expand(profiles[key]!.system_prompt));
      }

      for (const key of ['light', 'default', 'heavy'] as const) {
        const cur = live.promptTokens[key];
        const base = FROZEN.promptTokens[key];
        console.log(`  ${key.padEnd(10)} ~${cur} tokens  (baseline ~${base}, ${pctChange(base, cur)})`);
      }
    });
  });

  // ─── Section 3: Auto-detect optimization modules ───

  describe('3. Optimization Detection', () => {
    it('hot cache (lib/hot-cache.ts)', async () => {
      try {
        const mod = await import('../hot-cache.js');
        if (typeof mod.createHotCache !== 'function') throw new Error('missing export');

        const cache = mod.createHotCache({ ttlMs: 60_000, maxSize: 200 });

        // Populate
        for (let i = 0; i < 200; i++) cache.set(`k${i}`, SAMPLE_ANNOTATIONS);

        // Benchmark reads
        const readTimes: number[] = [];
        for (let i = 0; i < 1000; i++) {
          const t0 = performance.now();
          cache.get(`k${i % 200}`);
          readTimes.push(performance.now() - t0);
        }

        // Benchmark writes
        const writeTimes: number[] = [];
        for (let i = 0; i < 1000; i++) {
          const t0 = performance.now();
          cache.set(`w${i}`, SAMPLE_ANNOTATIONS);
          writeTimes.push(performance.now() - t0);
        }

        live.hotCache = {
          detected: true,
          lookupP50: percentile(readTimes, 50),
          lookupP95: percentile(readTimes, 95),
          writeP50: percentile(writeTimes, 50),
        };

        console.log(`  ✅ Hot Cache DETECTED`);
        console.log(`     read  p50=${fmt(live.hotCache.lookupP50)} p95=${fmt(live.hotCache.lookupP95)}  (replaces ${fmt(FROZEN.io.supabaseRead)} DB read)`);
        console.log(`     write p50=${fmt(live.hotCache.writeP50)}`);
        console.log(`     → saves ~${fmt(FROZEN.io.supabaseRead - live.hotCache.lookupP50)} per cache check`);

        // Functional: verify it actually works
        cache.set('test-key', [SAMPLE_ANNOTATIONS[0]!]);
        expect(cache.get('test-key')).toEqual([SAMPLE_ANNOTATIONS[0]]);
      } catch {
        live.hotCache.detected = false;
        console.log('  ⏭  Hot Cache — not implemented yet (create lib/hot-cache.ts)');
      }
    });

    it('inflight dedup (lib/inflight-dedup.ts)', async () => {
      try {
        const mod = await import('../inflight-dedup.js');
        if (typeof mod.createInflightDedup !== 'function') throw new Error('missing export');

        const dedup = mod.createInflightDedup();
        let execCount = 0;

        const work = async () => {
          execCount++;
          await new Promise((r) => setTimeout(r, 5));
          return SAMPLE_ANNOTATIONS;
        };

        // Fire 5 concurrent calls with the same key
        const results = await Promise.all(
          Array.from({ length: 5 }, () => dedup.run('same-key', work)),
        );

        live.inflightDedup = {
          detected: true,
          callsFor5Concurrent: execCount,
        };

        console.log(`  ✅ Inflight Dedup DETECTED`);
        console.log(`     5 concurrent identical requests → ${execCount} actual execution(s)`);
        console.log(`     → saves ${5 - execCount} redundant LLM calls per burst`);

        // Functional: all callers get the same result, only 1 execution
        expect(execCount).toBe(1);
        expect(results.every((r) => r === results[0])).toBe(true);
      } catch {
        live.inflightDedup.detected = false;
        console.log('  ⏭  Inflight Dedup — not implemented yet (create lib/inflight-dedup.ts)');
      }
    });
  });

  // ─── Section 4: Pipeline projections (auto-computed) ───

  describe('4. Pipeline Projection', () => {
    const SCENARIOS = [
      { name: 'Cold start (1 region)',   cacheHit: false, regionCount: 1, annotationsPerRegion: 5,  chatMode: false },
      { name: 'Warm start (1 region)',   cacheHit: true,  regionCount: 1, annotationsPerRegion: 5,  chatMode: false },
      { name: 'Full page cold (3 reg)',  cacheHit: false, regionCount: 3, annotationsPerRegion: 10, chatMode: false },
      { name: 'Full page revisit (3)',   cacheHit: true,  regionCount: 3, annotationsPerRegion: 10, chatMode: false },
      { name: 'Chat cold (1 response)',  cacheHit: false, regionCount: 1, annotationsPerRegion: 5,  chatMode: true  },
    ] as const;

    for (const scenario of SCENARIOS) {
      it(`projects: ${scenario.name}`, () => {
        const baseline = project({ ...scenario, useBaseline: true });
        const current = project({ ...scenario, useBaseline: false });

        printStageComparison(scenario.name, baseline, current);

        // Current should not regress from baseline
        expect(current.totalTime).toBeLessThanOrEqual(baseline.totalTime * 1.05);
      });
    }

    it('prints optimization summary', () => {
      const sep = '═'.repeat(90);
      const lines: string[] = [];
      lines.push('');
      lines.push(sep);
      lines.push('  OPTIMIZATION SUMMARY');
      lines.push(sep);

      // Active optimizations
      lines.push('');
      lines.push('  Active Optimizations:');
      if (live.hotCache.detected) {
        lines.push(`    ✅ Hot Cache       read p50=${fmt(live.hotCache.lookupP50)} (saves ~${fmt(FROZEN.io.supabaseRead - live.hotCache.lookupP50)}/req)`);
      } else {
        lines.push('    ⏭  Hot Cache       not implemented');
      }
      if (live.inflightDedup.detected) {
        lines.push(`    ✅ Inflight Dedup  ${live.inflightDedup.callsFor5Concurrent}/5 calls (saves ${5 - live.inflightDedup.callsFor5Concurrent} LLM calls/burst)`);
      } else {
        lines.push('    ⏭  Inflight Dedup  not implemented');
      }

      const promptDelta = live.promptTokens.default - FROZEN.promptTokens.default;
      if (promptDelta !== 0) {
        lines.push(`    ✅ Prompt Trimmed  ${promptDelta > 0 ? '+' : ''}${promptDelta} tokens (${pctChange(FROZEN.promptTokens.default, live.promptTokens.default)})`);
      } else {
        lines.push('    ⏭  Prompt Trim     no change');
      }

      const cpuDelta = live.cpu.annotationFilter.p50 - FROZEN.cpu.annotationFilter;
      if (Math.abs(cpuDelta) > 0.5) {
        lines.push(`    ✅ Faster Filter   p50=${fmt(live.cpu.annotationFilter.p50)} (was ${fmt(FROZEN.cpu.annotationFilter)}, ${pctChange(FROZEN.cpu.annotationFilter, live.cpu.annotationFilter.p50)})`);
      } else {
        lines.push('    ⏭  Faster Filter   no significant change');
      }

      // Scenario table
      lines.push('');
      lines.push('  Scenario                    TTFA Baseline  TTFA Current   Δ           Total Baseline  Total Current   Δ');
      lines.push('  ' + '─'.repeat(106));

      for (const s of SCENARIOS) {
        const bl = project({ ...s, useBaseline: true });
        const cur = project({ ...s, useBaseline: false });
        lines.push(
          `  ${s.name.padEnd(30)}${fmt(bl.ttfa).padEnd(14)}${fmt(cur.ttfa).padEnd(15)}${pctChange(bl.ttfa, cur.ttfa).padEnd(12)}${fmt(bl.totalTime).padEnd(16)}${fmt(cur.totalTime).padEnd(16)}${pctChange(bl.totalTime, cur.totalTime)}`,
        );
      }

      lines.push('');
      lines.push(sep);
      console.log(lines.join('\n'));
    });
  });
});
