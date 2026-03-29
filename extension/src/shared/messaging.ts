import type { ExtensionMessage } from "@oddity/shared";

/**
 * Check whether the extension context is still valid.
 * Returns false after extension reload/update.
 */
function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * Type-safe wrapper around chrome.runtime.sendMessage.
 * Returns a typed response. Silently fails if extension context is invalidated.
 */
export async function sendMessage<T = unknown>(
  message: ExtensionMessage,
): Promise<T> {
  if (!isContextValid()) return undefined as T;
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return undefined as T;
  }
}

/**
 * Type-safe wrapper around chrome.runtime.onMessage.addListener.
 * The callback receives a typed ExtensionMessage.
 * IMPORTANT: If the handler is async, the wrapper returns true
 * to keep the message channel open.
 */
export function onMessage(
  handler: (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
  ) => void | Promise<unknown>,
): void {
  if (!isContextValid()) return;
  try {
    chrome.runtime.onMessage.addListener(
      (message: ExtensionMessage, sender, sendResponse) => {
        if (!isContextValid()) return;
        const result = handler(message, sender);
        if (result instanceof Promise) {
          result.then(sendResponse).catch((err) => {
            console.error("[Oddity 1] Message handler error:", err);
            sendResponse({ error: String(err) });
          });
          return true; // keep channel open for async response
        }
      },
    );
  } catch {
    // Extension context invalidated
  }
}

/**
 * Send a message to a specific tab's content script.
 */
export async function sendToTab<T = unknown>(
  tabId: number,
  message: ExtensionMessage,
): Promise<T> {
  if (!isContextValid()) return undefined as T;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return undefined as T;
  }
}
