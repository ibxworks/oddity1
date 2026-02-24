import type { ExtensionMessage } from "@oddity/shared";

/**
 * Type-safe wrapper around chrome.runtime.sendMessage.
 * Returns a typed response.
 */
export function sendMessage<T = unknown>(
  message: ExtensionMessage,
): Promise<T> {
  return chrome.runtime.sendMessage(message);
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
  chrome.runtime.onMessage.addListener(
    (message: ExtensionMessage, sender, sendResponse) => {
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
}

/**
 * Send a message to a specific tab's content script.
 */
export function sendToTab<T = unknown>(
  tabId: number,
  message: ExtensionMessage,
): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message);
}
