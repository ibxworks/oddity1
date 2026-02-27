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
  const watchingElements = new WeakSet<Element>();
  const processedElements = new WeakSet<Element>();
  let mutationObserver: MutationObserver | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let responseCounter = 0;

  function findTurnContainer(responseEl: Element): Element {
    let current: Element | null = responseEl;
    let turnContainer = responseEl;
    while (current.parentElement && current.parentElement !== document.body) {
      current = current.parentElement;
      if (current.querySelectorAll(responseSelector).length > 1) {
        return turnContainer;
      }
      turnContainer = current;
    }
    return turnContainer;
  }

  function processResponse(element: Element): void {
    if (watchingElements.has(element) || processedElements.has(element)) return;
    watchingElements.add(element);

    const regionId = `chat-response-${responseCounter++}`;
    const watchTarget = findTurnContainer(element);

    if (!stabilitySignal) {
      // No stability signal — process immediately
      processedElements.add(element);
      onResponse(regionId, element);
      return;
    }

    // Check if stability condition is already met
    if (isAlreadyStable(watchTarget, stabilitySignal)) {
      processedElements.add(element);
      onResponse(regionId, element);
      return;
    }

    // Set up stability watcher on the turn container
    const watcher = createStabilityWatcher(stabilitySignal);
    watcher.onStable(() => {
      processedElements.add(element);
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
