import { Router } from 'express';
import { z } from 'zod';
import { MAX_TEXT_LENGTH, CACHE_TTL_DAYS } from '@oddity/shared';
import type { Annotation, Intensity } from '@oddity/shared';
import { serviceClient } from '../lib/supabase.js';
import { generateAnnotations, generateAnnotationsStream } from '../lib/openai.js';
import { filterAndFixAnnotations, fixSingleAnnotation } from '../lib/annotation-filter.js';
import { createInflightDedup } from '../lib/inflight-dedup.js';
import { mergeAnnotationsAndFeedback } from '../lib/merge-annotations.js';
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

// ─── Parallel chunking for long texts ───
// Smaller chunks ensure the LLM can saturate each chunk with annotations
// without hitting output token limits or generation laziness.
// CRITICAL: extractText() normalizes ALL whitespace to spaces, so text
// arriving here has NO newlines. We must split on sentence boundaries.
//
// Threshold is deliberately LOW (100 words ≈ 2–3 paragraphs). This forces
// chunking for virtually all inputs, guaranteeing annotations are distributed
// across the full text instead of frontloaded to paragraph 1.
const CHUNK_WORD_THRESHOLD = 200;
const TARGET_CHUNK_WORDS = 250;

/**
 * Split text into segments at natural boundaries.
 * Handles: paragraph breaks (\n\n), line breaks (\n), sentence boundaries.
 * Falls back to hard word-count splits for texts with no punctuation.
 */
function findSegments(text: string): string[] {
  // Strategy 1: paragraph breaks (double newline)
  const paraSegments = text.split(/\n\n+/).filter(s => s.trim().length > 0);
  if (paraSegments.length > 1) return paraSegments;

  // Strategy 2: single newline breaks
  const lineSegments = text.split(/\n/).filter(s => s.trim().length > 0);
  if (lineSegments.length > 1) return lineSegments;

  // Strategy 3: sentence boundaries — this handles the common case where
  // extractText() has normalized all whitespace to spaces, destroying
  // paragraph structure. Split at ". X" / "! X" / "? X" where X is uppercase.
  const sentences: string[] = [];
  // Match sentence terminators followed by a space + uppercase letter
  const sentenceRegex = /(?<=[.!?])\s+(?=[A-Z])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = sentenceRegex.exec(text)) !== null) {
    const segment = text.slice(lastIndex, match.index + 1).trim(); // include the punctuation
    if (segment.length > 0) sentences.push(segment);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex).trim();
    if (tail.length > 0) sentences.push(tail);
  }
  if (sentences.length > 1) return sentences;

  // Strategy 4: hard word-count split (no usable boundaries at all)
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= TARGET_CHUNK_WORDS) return [text];

  const hardSegments: string[] = [];
  for (let i = 0; i < words.length; i += TARGET_CHUNK_WORDS) {
    hardSegments.push(words.slice(i, i + TARGET_CHUNK_WORDS).join(' '));
  }
  return hardSegments;
}

function splitIntoChunks(text: string): string[] {
  const segments = findSegments(text);

  // NO overlap between chunks. Overlap caused the LLM to front-load
  // annotations into the repeated text, which then got deduped by the
  // `seen` Set — effectively killing every chunk after the first.
  // The annotation-filter's fixSingleAnnotation already re-computes
  // prefix/suffix against the full text, so overlap isn't needed.
  const chunks: string[] = [];
  let currentChunk = '';
  let currentWordCount = 0;

  for (const seg of segments) {
    const segWords = seg.split(/\s+/).filter(Boolean).length;

    if (currentWordCount + segWords > TARGET_CHUNK_WORDS && currentWordCount > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = seg;
      currentWordCount = segWords;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + seg;
      currentWordCount += segWords;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 1 ? chunks : [text];
}

function deduplicateAnnotations(annotations: Annotation[]): Annotation[] {
  const seen = new Set<string>();
  return annotations.filter((ann) => {
    // Deduplicate by exact anchor text (overlap zones may produce duplicates)
    const key = ann.anchor.exact;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

    // SSE streaming path: client requests progressive delivery
    const wantsStream = req.headers.accept === 'text/event-stream';
    if (wantsStream) {
      return handleStreamingAnnotation(req, res, parsed.data);
    }

    const { url, content_hash, text, intensity, word_count: wordCount } = parsed.data;
    const key = cacheKey(content_hash, intensity);
    const authToken = req.headers.authorization?.slice(7) ?? '';

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
        // Merge with user annotations + feedback in single response
        const merged = await mergeAnnotationsAndFeedback(
          dbCached.annotations, url, content_hash, authToken,
        );
        res.json({ success: true, cached: true, source: 'db', ...merged });
        return;
      }
      // Stale entry (model/prompt changed) — fall through to re-generate
    }

    // ── Layer 2: LLM generation (deduplicated) ──
    const aiAnnotations = await dedup.run(key, async () => {
      const profile = prompts.intensity_profiles[intensity as Intensity];

      // Parallel chunking for long texts
      if (wordCount > CHUNK_WORD_THRESHOLD) {
        const chunks = splitIntoChunks(text);
        console.log(`[annotate] Splitting ${wordCount} words into ${chunks.length} chunks`);

        const chunkResults = await Promise.all(
          chunks.map((chunk, i) => generateAnnotations(chunk, intensity, profile, { index: i, total: chunks.length })),
        );

        // Merge all chunk results, then run filter on full text to fix anchors
        const allRaw = chunkResults.flat();
        const deduped = deduplicateAnnotations(allRaw);
        return filterAndFixAnnotations(deduped, text);
      }

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
        annotations: aiAnnotations,
        model_version: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
        prompt_version: prompts.version,
        expires_at: expiresAt.toISOString(),
      },
      { onConflict: 'content_hash,intensity' },
    );

    // Increment user's annotation count (fresh generation only)
    if (req.user?.id) {
      await serviceClient.rpc('increment_annotation_count', {
        p_user_id: req.user.id,
        p_count: aiAnnotations.length,
      });
    }

    // Merge with user annotations + feedback in single response
    const merged = await mergeAnnotationsAndFeedback(
      aiAnnotations, url, content_hash, authToken,
    );
    res.json({ success: true, cached: false, source: 'llm', ...merged });
  } catch (err) {
    console.error('[annotate] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * SSE streaming handler: sends individual annotations as they're generated,
 * then a final event with the complete merged result.
 */
async function handleStreamingAnnotation(
  req: import('express').Request,
  res: import('express').Response,
  data: z.infer<typeof AnnotateRequestSchema>,
): Promise<void> {
  const { url, content_hash, text, intensity } = data;
  const authToken = req.headers.authorization?.slice(7) ?? '';

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    // Check DB cache first — if cached, send all at once and close
    const { data: dbCached } = await serviceClient
      .from('annotation_cache')
      .select('annotations, model_version, prompt_version')
      .eq('content_hash', content_hash)
      .eq('intensity', intensity)
      .gt('expires_at', new Date().toISOString())
      .single();

    const currentModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    const currentPromptVersion = prompts.version;

    if (
      dbCached &&
      dbCached.model_version === currentModel &&
      dbCached.prompt_version === currentPromptVersion
    ) {
      const merged = await mergeAnnotationsAndFeedback(
        dbCached.annotations, url, content_hash, authToken,
      );
      // Send all cached annotations at once
      for (const ann of merged.annotations) {
        res.write(`data: ${JSON.stringify({ annotation: ann })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ done: true, cached: true, annotations: merged.annotations, feedback: merged.feedback })}\n\n`);
      res.end();
      return;
    }

    // Stream from LLM
    const profile = prompts.intensity_profiles[intensity as Intensity];
    const allAnnotations: Annotation[] = [];

    // Parallel chunking for long texts (mirrors non-streaming path)
    if (data.word_count > CHUNK_WORD_THRESHOLD) {
      const chunks = splitIntoChunks(text);
      console.log(`[annotate/stream] Splitting ${data.word_count} words into ${chunks.length} chunks`);

      const seen = new Set<string>();

      await Promise.all(
        chunks.map(async (chunk, i) => {
          try {
            const stream = generateAnnotationsStream(chunk, intensity, profile, { index: i, total: chunks.length });
            for await (const annotation of stream) {
              // Fix anchor against FULL original text (not the chunk)
              const fixed = fixSingleAnnotation(annotation, text);
              if (fixed && !seen.has(fixed.anchor.exact)) {
                seen.add(fixed.anchor.exact);
                allAnnotations.push(fixed);
                res.write(`data: ${JSON.stringify({ annotation: fixed })}\n\n`);
              }
            }
          } catch (err) {
            console.error(`[annotate/stream] Chunk ${i + 1}/${chunks.length} failed:`, err);
          }
        }),
      );
    } else {
      const stream = generateAnnotationsStream(text, intensity, profile);

      for await (const annotation of stream) {
        // Fix anchor against source text before sending
        const fixed = fixSingleAnnotation(annotation, text);
        if (fixed) {
          allAnnotations.push(fixed);
          res.write(`data: ${JSON.stringify({ annotation: fixed })}\n\n`);
        }
      }
    }

    // Cache the complete result
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

    await serviceClient.from('annotation_cache').upsert(
      {
        content_hash,
        url,
        intensity,
        annotations: allAnnotations,
        model_version: currentModel,
        prompt_version: currentPromptVersion,
        expires_at: expiresAt.toISOString(),
      },
      { onConflict: 'content_hash,intensity' },
    );

    if (req.user?.id) {
      await serviceClient.rpc('increment_annotation_count', {
        p_user_id: req.user.id,
        p_count: allAnnotations.length,
      });
    }

    // Send final event with feedback
    const merged = await mergeAnnotationsAndFeedback(
      allAnnotations, url, content_hash, authToken,
    );
    res.write(`data: ${JSON.stringify({ done: true, cached: false, annotations: merged.annotations, feedback: merged.feedback })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[annotate/stream] Error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
    res.end();
  }
}

export default router;
