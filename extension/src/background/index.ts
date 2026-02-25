import type { ExtensionMessage, UserPreferences } from "@oddity/shared";
import { sendToTab } from "../shared/messaging.js";
import {
  getAdapters,
  handleAdapterAlarm,
  initAdapterRefresh,
} from "./adapter-registry.js";
import {
  AuthError,
  deleteAnnotation as apiDeleteAnnotation,
  getAnnotations,
  requestAnnotations,
  saveAnnotation,
} from "./api-client.js";
import { getSession, getUserTier, signIn, signOut, signUp } from "./auth.js";
import { setupContextMenu } from "./context-menu.js";

// ─── Installed Event ───

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Oddity 1] Extension installed");
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
        case "requestAnnotations": {
          const { url, contentHash, text, intensity, wordCount } =
            message.payload;

          // Proactive auth check — fail fast with badge if not signed in
          const session = await getSession();
          if (!session) {
            chrome.action.setBadgeText({ text: "!" });
            chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
            return { error: "Sign in required" };
          }

          // Session exists — clear any stale badge
          chrome.action.setBadgeText({ text: "" });

          // Trigger AI generation/caching
          await requestAnnotations({
            url,
            content_hash: contentHash,
            text,
            intensity,
            word_count: wordCount,
          });

          // Fetch merged result (cached AI + user annotations)
          const merged = await getAnnotations(url, contentHash);

          // Forward annotations to the requesting tab
          if (sender.tab?.id) {
            await sendToTab(sender.tab.id, {
              action: "annotationsReady",
              payload: {
                regionId: contentHash,
                annotations: merged.annotations,
              },
            });
          }

          return merged;
        }

        case "getAdapters": {
          const adapters = await getAdapters();
          return { adapters };
        }

        case "getAuthStatus": {
          const session = await getSession();
          return {
            authenticated: session !== null,
            user: session
              ? {
                  id: session.user.id,
                  email: session.user.email ?? "",
                }
              : null,
          };
        }

        case "signIn": {
          const { email, password } = message.payload;
          const data = await signIn(email, password);
          return {
            success: true,
            user: {
              id: data.user?.id ?? "",
              email: data.user?.email ?? "",
            },
          };
        }

        case "signUp": {
          const { email, password } = message.payload;
          const data = await signUp(email, password);
          const needsConfirmation = data.session === null;
          return {
            success: true,
            needsConfirmation,
            user: data.user
              ? { id: data.user.id, email: data.user.email ?? "" }
              : null,
          };
        }

        case "signOut": {
          await signOut();
          return { success: true };
        }

        case "saveManualAnnotation": {
          const { url, contentHash, annotation } = message.payload;
          const saved = await saveAnnotation(url, contentHash, annotation);
          return saved;
        }

        case "deleteAnnotation": {
          await apiDeleteAnnotation(message.payload.annotationId);
          return { success: true };
        }

        case "getUserTier": {
          const tier = await getUserTier();
          return { tier };
        }

        default:
          return undefined;
      }
    };

    handleAsync()
      .then(sendResponse)
      .catch((err) => {
        console.error("[Oddity 1] Message handler error:", err);

        // Safety net: set badge on any auth failure
        if (err instanceof AuthError) {
          chrome.action.setBadgeText({ text: "!" });
          chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
        }

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
  if (area !== "local") return;

  // Detect settings/preferences changes
  if (changes["preferences"]) {
    const prefs = changes["preferences"].newValue as
      | UserPreferences
      | undefined;
    if (prefs) {
      // Broadcast settings update to all tabs
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          if (tab.id) {
            sendToTab(tab.id, {
              action: "settingsUpdated",
              payload: {
                enabled: prefs.enabled ?? true,
                intensity: prefs.intensity ?? "default",
                visibleTypes: prefs.visible_types ?? [
                  "highlight",
                  "underline",
                  "question",
                  "insight",
                  "caveat",
                  "vocabulary",
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

console.log("[Oddity 1] Service worker loaded");
