import type { StabilitySignal } from '@oddity/shared';
import { createStabilityWatcher } from './stability.js';

export interface ChatObserverConfig {
  responseSelector: string;
  stabilitySignal: StabilitySignal | null;
  onResponse: (regionId: string, element: Element) => void;
}

export interface ChatObserver {
  start(): void;
  stop(): void;
}

const MUTATION_DEBOUNCE_MS = 200;

export function createChatObserver(config: ChatObserverConfig): ChatObserver {
  const { responseSelector, stabilitySignal, onResponse } = config;
  const processedElements = new WeakSet<Element>();
  let mutationObserver: MutationObserver | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let responseCounter = 0;

  function findStabilityAncestor(responseEl: Element): Element {
    if (!stabilitySignal) return responseEl;

    let current: Element | null = responseEl.parentElement;
    while (current && current !== document.body) {
      // Check if this ancestor matches the target_selector itself
      if (current.matches(stabilitySignal.target_selector)) {
        return current;
      }
      // Check if this ancestor contains the target_selector
      if (current.querySelector(stabilitySignal.target_selector)) {
        return current;
      }
      current = current.parentElement;
    }

    // Fallback: use the response element's grandparent or parent
    return responseEl.parentElement?.parentElement ?? responseEl.parentElement ?? responseEl;
  }

  function processResponse(element: Element): void {
    if (processedElements.has(element)) return;
    processedElements.add(element);

    const regionId = `chat-response-${responseCounter++}`;
    const watchTarget = findStabilityAncestor(element);

    if (!stabilitySignal) {
      // No stability signal — process immediately
      onResponse(regionId, element);
      return;
    }

    // Check if stability condition is already met
    if (isAlreadyStable(watchTarget, stabilitySignal)) {
      onResponse(regionId, element);
      return;
    }

    // Set up stability watcher on the ancestor
    const watcher = createStabilityWatcher(stabilitySignal);
    watcher.onStable(() => {
      onResponse(regionId, element);
    });
    watcher.observe(watchTarget);
  }

  function isAlreadyStable(target: Element, signal: StabilitySignal): boolean {
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

  function scanForResponses(): void {
    const elements = document.querySelectorAll(responseSelector);
    elements.forEach((el) => processResponse(el));
  }

  return {
    start() {
      // Process existing responses
      scanForResponses();

      // Watch for new responses via MutationObserver
      mutationObserver = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(scanForResponses, MUTATION_DEBOUNCE_MS);
      });

      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    },

    stop() {
      if (debounceTimer) clearTimeout(debounceTimer);
      mutationObserver?.disconnect();
      mutationObserver = null;
    },
  };
}
