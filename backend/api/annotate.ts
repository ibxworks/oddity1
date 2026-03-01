import { Router } from 'express';
import { z } from 'zod';
import { MAX_TEXT_LENGTH, CACHE_TTL_DAYS } from '@oddity/shared';
import type { Annotation, Intensity } from '@oddity/shared';
import { serviceClient } from '../lib/supabase.js';
import { generateAnnotations } from '../lib/openai.js';
import { filterAndFixAnnotations } from '../lib/annotation-filter.js';
import { createInflightDedup } from '../lib/inflight-dedup.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsPath = resolve(__dirname, '../config/prompts.json');
const prompts = JSON.parse(readFileSync(promptsPath, 'utf-8'));

// ─── Optimization: in-flight request dedup ───
// If two identical requests arrive concurrently, only one LLM call is made.
const dedup = createInflightDedup();

function cacheKey(contentHash: string, intensity: string): string {
  return `${contentHash}:${intensity}`;
}

const AnnotateRequestSchema = z.object({
  url: z.string().url(),
  content_hash: z.string().min(1),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  intensity: z.enum(['light', 'default', 'heavy']),
  word_count: z.number().int().positive(),
});

const router = Router();

router.post('/', async (req, res) => {
  try {
    const parsed = AnnotateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const { url, content_hash, text, intensity, word_count: _wordCount } = parsed.data;
    const key = cacheKey(content_hash, intensity);

    // ── Layer 1: DB cache (Supabase) ──
    const { data: dbCached } = await serviceClient
      .from('annotation_cache')
      .select('annotations, model_version, prompt_version')
      .eq('content_hash', content_hash)
      .eq('intensity', intensity)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (dbCached) {
      // Compatibility check: ensure cached entry matches current model + prompt version
      const currentModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
      const currentPromptVersion = prompts.version;

      if (
        dbCached.model_version === currentModel &&
        dbCached.prompt_version === currentPromptVersion
      ) {
        res.json({ success: true, cached: true, source: 'db', annotations: dbCached.annotations });
        return;
      }
      // Stale entry (model/prompt changed) — fall through to re-generate
    }

    // ── Layer 2: LLM generation (deduplicated) ──
    const annotations = await dedup.run(key, async () => {
      const profile = prompts.intensity_profiles[intensity as Intensity];
      const rawAnnotations = await generateAnnotations(text, intensity, profile);
      return filterAndFixAnnotations(rawAnnotations, text);
    });

    // Write-through: populate DB cache
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

    await serviceClient.from('annotation_cache').upsert(
      {
        content_hash,
        url,
        intensity,
        annotations,
        model_version: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
        prompt_version: prompts.version,
        expires_at: expiresAt.toISOString(),
      },
      { onConflict: 'content_hash,intensity' },
    );

    res.json({ success: true, cached: false, source: 'llm', annotations });
  } catch (err) {
    console.error('[annotate] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
