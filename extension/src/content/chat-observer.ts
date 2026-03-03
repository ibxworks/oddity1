import type { StabilitySignal } from '@oddity/shared';

export interface ChatObserverConfig {
  responseSelector: string;
  stabilitySignal: StabilitySignal | null;
  onResponse: (regionId: string, element: Element) => void;
}

export interface ChatObserver {
  start(): void;
  stop(): void;
}

/** Debounce for scanning document.body for new response elements. */
const SCAN_DEBOUNCE_MS = 200;

/** After the entire response stops mutating, fire the whole element.
 *  Must be generous: LLM streaming can pause >300ms between paragraphs,
 *  on network hiccups, or during reasoning delays. The timer resets on
 *  every mutation, so this only adds latency AFTER streaming truly stops. */
const COMPLETION_SETTLE_MS = 1200;

/** Block-level selectors that represent individual paragraphs/sections. */
const BLOCK_SELECTOR = 'p, li, pre, h1, h2, h3, h4, h5, h6, blockquote, table';

/** Minimum word count before a block is eligible for progressive fire. */
const MIN_PARAGRAPH_WORDS = 15;

// ─── Per-block tracking ───

interface BlockState {
  lastText: string;
  fired: boolean;
  index: number;
}

// ─── Per-response tracking ───

interface ResponseState {
  element: Element;
  observer: MutationObserver;
  blocks: Map<Element, BlockState>;
  blockIndex: number;
  responseIndex: number;
  completionTimer: ReturnType<typeof setTimeout> | null;
}

export function createChatObserver(config: ChatObserverConfig): ChatObserver {
  const { responseSelector, stabilitySignal, onResponse } = config;
  const processedElements = new WeakSet<Element>();
  const responseStates = new Map<Element, ResponseState>();
  let responseCounter = 0;
  let mutationObserver: MutationObserver | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;

  // Elements already on the page when start() was called — these are historical
  // messages that should fire as single chunks (not progressively split).
  // New elements appearing after start() are assumed to be streaming.
  let initialElements: Set<Element> | null = null;

  // ─── Response discovery ───

  function scanForResponses(): void {
    const elements = document.querySelectorAll(responseSelector);
    for (const el of elements) {
      if (!processedElements.has(el) && !responseStates.has(el)) {
        trackResponse(el);
      }
    }
  }

  // ─── Track a new response element ───

  function trackResponse(element: Element): void {
    const responseIndex = responseCounter++;

    // Already-complete response (no streaming indicators, has content).
    // Fire the whole element as a single region — better annotation quality
    // with full context, and no need for progressive splitting.
    if (isAlreadyComplete(element)) {
      processedElements.add(element);
      onResponse(`chat-${responseIndex}`, element);
      return;
    }

    // Streaming in progress — use progressive paragraph detection
    const state: ResponseState = {
      element,
      observer: null!, // assigned below
      blocks: new Map(),
      blockIndex: 0,
      responseIndex,
      completionTimer: null,
    };

    // Initial block scan
    scanBlocks(state);

    // Watch for streaming mutations
    state.observer = new MutationObserver(() => {
      scanBlocks(state);
      resetCompletionTimer(state);
    });

    state.observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Start completion timer (fires remaining blocks when streaming stops)
    resetCompletionTimer(state);
    responseStates.set(element, state);
  }

  // ─── Block scanning ───
  // On each mutation:
  //   1. Discover new block-level elements and track them
  //   2. Update text for existing blocks
  //   3. When a NEW block appears, immediately fire all prior unfired blocks
  //      (the LLM has moved past them — they're stable)

  function scanBlocks(state: ResponseState): void {
    const blocks = state.element.querySelectorAll(BLOCK_SELECTOR);

    for (const block of blocks) {
      if (state.blocks.has(block)) {
        // Existing block — update its latest text snapshot
        const bs = state.blocks.get(block)!;
        bs.lastText = block.textContent?.trim() ?? '';
      } else {
        // New block — register it (used for streaming completion detection)
        const text = block.textContent?.trim() ?? '';
        const bs: BlockState = {
          lastText: text,
          fired: false,
          index: state.blockIndex++,
        };
        state.blocks.set(block, bs);
      }
    }
    // Don't fire individual blocks — we fire the whole response on completion
    // to give the LLM full context for diverse annotation types.
  }

  // ─── Completion timer ───
  // When the entire response stops receiving mutations for COMPLETION_SETTLE_MS,
  // fire all remaining unfired blocks (the last paragraph + any short ones skipped).

  function resetCompletionTimer(state: ResponseState): void {
    if (state.completionTimer) clearTimeout(state.completionTimer);
    state.completionTimer = setTimeout(() => {
      finalizeResponse(state);
    }, COMPLETION_SETTLE_MS);
  }

  function finalizeResponse(state: ResponseState): void {
    // Fire the whole response element as a single region.
    // Full context lets the LLM produce diverse annotation types
    // (provoking questions, insights, caveats, recall) — not just highlights.
    const text = state.element.textContent?.trim() ?? '';
    if (text.length > 0) {
      onResponse(`chat-${state.responseIndex}`, state.element);
    }

    // Clean up
    state.observer.disconnect();
    processedElements.add(state.element);
    responseStates.delete(state.element);
  }

  // ─── Helpers ───

  function isAlreadyComplete(element: Element): boolean {
    // Pre-existing elements (on page before observer started) are historical.
    // Fire as single chunks — no need for progressive splitting.
    if (initialElements?.has(element)) return true;

    const text = element.textContent ?? '';
    if (text.trim().length < 20) return false;

    // Check for common streaming indicators
    const cursor = element.querySelector(
      '.result-streaming, .typing-indicator, [data-streaming="true"]',
    );
    if (cursor) return false;

    // If a stability signal is defined, use it to determine completion
    if (stabilitySignal) {
      return isSignalMet(element, stabilitySignal);
    }

    // New element without stability signal — assume streaming.
    // The completion timer (300ms) safely handles truly-static content
    // with only a minor delay. The cost of wrongly assuming "complete"
    // is far worse: partial text sent, rest of response never annotated.
    return false;
  }

  function isSignalMet(target: Element, signal: StabilitySignal): boolean {
    switch (signal.type) {
      case 'selector_appears':
        return target.querySelector(signal.target_selector) !== null ||
               target.matches(signal.target_selector);
      case 'selector_disappears':
        return target.querySelector(signal.target_selector) === null;
      case 'attribute_change': {
        const el = target.querySelector(signal.target_selector) ??
                   (target.matches(signal.target_selector) ? target : null);
        return el !== null && signal.attribute !== undefined &&
               el.getAttribute(signal.attribute) === signal.value;
      }
      default:
        return false;
    }
  }

  function countWords(text: string): number {
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
  }

  // ─── Public Interface ───

  return {
    start() {
      // Snapshot elements already on page — these are historical/complete messages.
      // Anything appearing AFTER this point is assumed to be a new streaming response.
      initialElements = new Set(document.querySelectorAll(responseSelector));

      scanForResponses();

      mutationObserver = new MutationObserver(() => {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(scanForResponses, SCAN_DEBOUNCE_MS);
      });

      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    },

    stop() {
      if (scanTimer) clearTimeout(scanTimer);
      mutationObserver?.disconnect();
      mutationObserver = null;
      initialElements = null;

      for (const [, state] of responseStates) {
        if (state.completionTimer) clearTimeout(state.completionTimer);
        state.observer.disconnect();
      }
      responseStates.clear();
    },
  };
}
