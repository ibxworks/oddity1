import type { ExtensionMessage, UserPreferences } from '@oddity/shared';
import { sendToTab } from '../shared/messaging.js';
import { getSession } from './auth.js';
import {
  requestAnnotations,
  saveAnnotation,
  deleteAnnotation as apiDeleteAnnotation,
} from './api-client.js';
import {
  getAdapters,
  initAdapterRefresh,
  handleAdapterAlarm,
} from './adapter-registry.js';
import { setupContextMenu } from './context-menu.js';

// ─── Installed Event ───

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Oddity] Extension installed');
  setupContextMenu();
  initAdapterRefresh();
});

// ─── Message Router ───

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    const handleAsync = async (): Promise<unknown> => {
      switch (message.action) {
        case 'requestAnnotations': {
          const { url, contentHash, text, intensity, wordCount } =
            message.payload;
          const result = await requestAnnotations({
            url,
            content_hash: contentHash,
            text,
            intensity,
            word_count: wordCount,
          });

          // Forward annotations to the requesting tab
          if (sender.tab?.id) {
            await sendToTab(sender.tab.id, {
              action: 'annotationsReady',
              payload: {
                regionId: contentHash,
                annotations: result.annotations,
              },
            });
          }

          return result;
        }

        case 'getAdapters': {
          const adapters = await getAdapters();
          return { adapters };
        }

        case 'getAuthStatus': {
          const session = await getSession();
          return {
            authenticated: session !== null,
            user: session
              ? {
                  id: session.user.id,
                  email: session.user.email ?? '',
                }
              : null,
          };
        }

        case 'saveManualAnnotation': {
          const { url, contentHash, annotation } = message.payload;
          const saved = await saveAnnotation(url, contentHash, annotation);
          return saved;
        }

        case 'deleteAnnotation': {
          await apiDeleteAnnotation(message.payload.annotationId);
          return { success: true };
        }

        default:
          return undefined;
      }
    };

    handleAsync()
      .then(sendResponse)
      .catch((err) => {
        console.error('[Oddity] Message handler error:', err);
        sendResponse({ error: String(err) });
      });

    // CRITICAL: return true to keep the message channel open for async response
    return true;
  },
);

// ─── Alarm Handler ───

chrome.alarms.onAlarm.addListener((alarm) => {
  handleAdapterAlarm(alarm);
});

// ─── Storage Change Listener ───

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Detect settings/preferences changes
  if (changes['preferences']) {
    const prefs = changes['preferences'].newValue as
      | UserPreferences
      | undefined;
    if (prefs) {
      // Broadcast settings update to all tabs
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          if (tab.id) {
            sendToTab(tab.id, {
              action: 'settingsUpdated',
              payload: {
                enabled: prefs.enabled ?? true,
                intensity: prefs.intensity ?? 'default',
                visibleTypes: prefs.visible_types ?? [
                  'highlight',
                  'underline',
                  'question',
                  'insight',
                  'caveat',
                  'vocabulary',
                ],
              },
            }).catch(() => {
              // Tab may not have content script loaded; ignore
            });
          }
        }
      });
    }
  }
});

console.log('[Oddity] Service worker loaded');
