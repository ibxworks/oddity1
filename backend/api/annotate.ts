import { Router } from 'express';
import { z } from 'zod';
import { MAX_TEXT_LENGTH, CACHE_TTL_DAYS } from '@oddity/shared';
import type { Intensity } from '@oddity/shared';
import { serviceClient } from '../lib/supabase.js';
import { generateAnnotations } from '../lib/openai.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsPath = resolve(__dirname, '../config/prompts.json');
const prompts = JSON.parse(readFileSync(promptsPath, 'utf-8'));

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

    // Cache check
    const { data: cached } = await serviceClient
      .from('annotation_cache')
      .select('annotations')
      .eq('content_hash', content_hash)
      .eq('intensity', intensity)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (cached) {
      res.json({
        success: true,
        cached: true,
        annotations: cached.annotations,
      });
      return;
    }

    // Generate annotations via OpenAI
    const profile = prompts.intensity_profiles[intensity as Intensity];
    const annotations = await generateAnnotations(text, intensity, profile);

    // Store in cache
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

    res.json({ success: true, cached: false, annotations });
  } catch (err) {
    console.error('[annotate] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
