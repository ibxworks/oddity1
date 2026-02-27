import type { StabilitySignal } from '@oddity/shared';
import { STABILITY_DEBOUNCE_MS } from '@oddity/shared';

function queryWithinOrSelf(root: Element, selector: string): Element | null {
  return root.matches(selector) ? root : root.querySelector(selector);
}

export interface StabilityWatcher {
  observe(element: Element): void;
  disconnect(): void;
  onStable(callback: (element: Element) => void): void;
}

/**
 * Create a stability watcher. Uses signal-based detection when an adapter
 * provides a stability signal, otherwise falls back to mutation debouncing.
 */
export function createStabilityWatcher(
  signal: StabilitySignal | null,
): StabilityWatcher {
  if (signal) {
    return createSignalWatcher(signal);
  }
  return createDebounceWatcher();
}

function createSignalWatcher(signal: StabilitySignal): StabilityWatcher {
  let observer: MutationObserver | null = null;
  let callback: ((element: Element) => void) | null = null;
  let observedElement: Element | null = null;

  return {
    onStable(cb) {
      callback = cb;
    },

    observe(element: Element) {
      observedElement = element;

      observer = new MutationObserver(() => {
        if (!observedElement || !callback) return;

        switch (signal.type) {
          case 'selector_appears': {
            const target = queryWithinOrSelf(observedElement, signal.target_selector);
            if (target) {
              callback(observedElement);
              observer?.disconnect();
            }
            break;
          }
          case 'selector_disappears': {
            const target = queryWithinOrSelf(observedElement, signal.target_selector);
            if (!target) {
              callback(observedElement);
              observer?.disconnect();
            }
            break;
          }
          case 'attribute_change': {
            const target = queryWithinOrSelf(observedElement, signal.target_selector);
            if (target && signal.attribute) {
              const val = target.getAttribute(signal.attribute);
              if (val === signal.value) {
                callback(observedElement);
                observer?.disconnect();
              }
            }
            break;
          }
        }
      });

      observer.observe(element, {
        childList: true,
        subtree: true,
        attributes: signal.type === 'attribute_change',
        attributeFilter: signal.attribute ? [signal.attribute] : undefined,
      });

      // Check immediately in case condition is already met
      if (signal.type === 'selector_appears') {
        const target = queryWithinOrSelf(element, signal.target_selector);
        if (target && callback) {
          callback(element);
          observer.disconnect();
        }
      } else if (signal.type === 'selector_disappears') {
        const target = queryWithinOrSelf(element, signal.target_selector);
        if (!target && callback) {
          callback(element);
          observer.disconnect();
        }
      }
    },

    disconnect() {
      observer?.disconnect();
      observer = null;
    },
  };
}

function createDebounceWatcher(): StabilityWatcher {
  let observer: MutationObserver | null = null;
  let callback: ((element: Element) => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    onStable(cb) {
      callback = cb;
    },

    observe(element: Element) {
      const fireStable = () => {
        if (callback) {
          callback(element);
        }
        observer?.disconnect();
      };

      observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fireStable, STABILITY_DEBOUNCE_MS);
      });

      observer.observe(element, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      // Start the initial debounce timer (in case no mutations happen)
      debounceTimer = setTimeout(fireStable, STABILITY_DEBOUNCE_MS);
    },

    disconnect() {
      if (debounceTimer) clearTimeout(debounceTimer);
      observer?.disconnect();
      observer = null;
    },
  };
}
