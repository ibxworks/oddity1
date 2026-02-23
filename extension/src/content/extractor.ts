import { Readability } from '@mozilla/readability';
import type { DetectedRegion } from './detector.js';

export interface ExtractedContent {
  regionId: string;
  text: string;
  wordCount: number;
  element: Element;
}

/**
 * Extract text from a detected region.
 */
export function extractText(region: DetectedRegion): ExtractedContent {
  const raw = region.element.textContent ?? '';
  const text = normalizeWhitespace(raw);
  const wordCount = countWords(text);

  return {
    regionId: region.id,
    text,
    wordCount,
    element: region.element,
  };
}

/**
 * Extract text using Readability for article-like pages.
 * CRITICAL: Readability mutates the DOM — we clone the document first.
 */
export function extractWithReadability(): ExtractedContent | null {
  const clone = document.cloneNode(true) as Document;

  const reader = new Readability(clone);
  const result = reader.parse();

  if (!result || !result.textContent) return null;

  const text = normalizeWhitespace(result.textContent);
  const wordCount = countWords(text);

  // Find the best matching element in the real DOM
  const article = document.querySelector('article') ?? document.body;

  return {
    regionId: 'readability-full',
    text,
    wordCount,
    element: article,
  };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}
