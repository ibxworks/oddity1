import type { StabilitySignal } from '@oddity/shared';
import { STABILITY_DEBOUNCE_MS } from '@oddity/shared';

export interface ChatObserverConfig {
  responseSelector: string;
  stabilitySignal: StabilitySignal | null;
  onResponse: (regionId: string, element: Element) => void;
}

export interface ChatObserver {
  start(): void;
  stop(): void;
}

const SCAN_DEBOUNCE_MS = 200;
const SIGNAL_SETTLE_MS = 300;

interface ResponseWatcher {
  observer: MutationObserver;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createChatObserver(config: ChatObserverConfig): ChatObserver {
  const { responseSelector, stabilitySignal, onResponse } = config;
  const watchingElements = new WeakSet<Element>();
  const processedElements = new WeakSet<Element>();
  const activeWatchers = new Map<Element, ResponseWatcher>();
  let mutationObserver: MutationObserver | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
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

    // No stability signal — process immediately (static site adapters)
    if (!stabilitySignal) {
      processedElements.add(element);
      onResponse(regionId, element);
      return;
    }

    // Hybrid: signal check + mutation debounce
    let signalMet = isAlreadyStable(watchTarget, stabilitySignal);
    const state: ResponseWatcher = { observer: null!, timer: null };

    function fire(): void {
      state.timer = null;
      state.observer.disconnect();
      activeWatchers.delete(element);
      processedElements.add(element);
      onResponse(regionId, element);
    }

    function resetTimer(): void {
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(
        fire,
        signalMet ? SIGNAL_SETTLE_MS : STABILITY_DEBOUNCE_MS,
      );
    }

    state.observer = new MutationObserver(() => {
      if (!signalMet) {
        signalMet = isAlreadyStable(watchTarget, stabilitySignal);
      }
      resetTimer();
    });

    state.observer.observe(watchTarget, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    activeWatchers.set(element, state);
    resetTimer(); // initial kick — handles reload (no mutations → timer fires)
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
      for (const [, w] of activeWatchers) {
        if (w.timer) clearTimeout(w.timer);
        w.observer.disconnect();
      }
      activeWatchers.clear();
    },
  };
}
