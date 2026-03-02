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
  deleteFeedback as apiDeleteFeedback,
  getAnnotations,
  getFeedback,
  requestAnnotations,
  saveAnnotation,
  saveFeedback as apiSaveFeedback,
  sendUserFeedback as apiSendUserFeedback,
  updateAnnotation as apiUpdateAnnotation,
} from "./api-client.js";
import { getProfile, getSession, getUserTier, signIn, signOut, signUp, updateProfile } from "./auth.js";
import { setupContextMenu } from "./context-menu.js";

// ─── Optimization: per-request abort controllers ───
// Keyed by "tabId:regionId" so re-requesting the same region with new content
// cancels the previous in-flight request (even when the content hash differs).
const inflight = new Map<string, AbortController>();

function abortKey(tabId: number, regionId: string): string {
  return `${tabId}:${regionId}`;
}

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
          const { url, regionId, contentHash, text, intensity, wordCount } =
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

          // Cancel any previous in-flight request for the same tab+region
          const tabId = sender.tab?.id ?? 0;
          const key = abortKey(tabId, regionId);
          inflight.get(key)?.abort();
          const controller = new AbortController();
          inflight.set(key, controller);

          try {
            // Trigger AI generation/caching (with abort signal)
            await requestAnnotations(
              {
                url,
                content_hash: contentHash,
                text,
                intensity,
                word_count: wordCount,
              },
              controller.signal,
            );

            // Check if aborted before fetching merged result
            if (controller.signal.aborted) return { aborted: true };

            // Fetch merged result (cached AI + user annotations) + feedback
            const [merged, feedback] = await Promise.all([
              getAnnotations(url, contentHash, controller.signal),
              getFeedback(url, contentHash),
            ]);

            // Forward annotations to the requesting tab
            if (sender.tab?.id) {
              await sendToTab(sender.tab.id, {
                action: "annotationsReady",
                payload: {
                  regionId: contentHash,
                  annotations: merged.annotations,
                  feedback,
                },
              });
            }

            return merged;
          } finally {
            // Only remove if this controller is still the active one for this key.
            // A newer request may have already replaced it — deleting would orphan
            // the newer controller and make it unabortable.
            if (inflight.get(key) === controller) {
              inflight.delete(key);
            }
          }
        }

        case "getAdapters": {
          const adapters = await getAdapters();
          return { adapters };
        }

        case "getAuthStatus": {
          const session = await getSession();
          if (!session) {
            return { authenticated: false, user: null };
          }
          const profile = await getProfile();
          return {
            authenticated: true,
            user: {
              id: session.user.id,
              email: session.user.email ?? "",
              display_name: profile?.display_name ?? null,
              tier: profile?.tier ?? "free",
              annotation_count: profile?.annotation_count ?? 0,
            },
          };
        }

        case "signIn": {
          const { email, password } = message.payload;
          const data = await signIn(email, password);
          const signInProfile = await getProfile();
          return {
            success: true,
            user: {
              id: data.user?.id ?? "",
              email: data.user?.email ?? "",
              display_name: signInProfile?.display_name ?? null,
              tier: signInProfile?.tier ?? "free",
            },
          };
        }

        case "signUp": {
          const { email, password, displayName } = message.payload;
          const data = await signUp(email, password, displayName);
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
          const { annotationId: delId, url: delUrl, contentHash: delHash } = message.payload;
          await apiDeleteAnnotation(delId, delUrl, delHash);
          return { success: true };
        }

        case "getProfile": {
          const userProfile = await getProfile();
          return userProfile ?? { display_name: null, tier: "free" };
        }

        case "updateProfile": {
          await updateProfile(message.payload.display_name);
          return { success: true };
        }

        case "getUserTier": {
          const tier = await getUserTier();
          return { tier };
        }

        case "saveFeedback": {
          const { annotationId, contentHash, url, feedbackType, replyText } =
            message.payload;
          const fb = await apiSaveFeedback({
            annotation_id: annotationId,
            content_hash: contentHash,
            url,
            feedback_type: feedbackType,
            reply_text: replyText,
          });
          return fb;
        }

        case "deleteFeedback": {
          await apiDeleteFeedback(message.payload.feedbackId);
          return { success: true };
        }

        case "updateAnnotation": {
          const { annotationId: annId, annotation: updatedAnn, url: updUrl, contentHash: updHash } =
            message.payload;
          const result = await apiUpdateAnnotation(annId, updatedAnn, updUrl, updHash);
          return result;
        }

        case "sendUserFeedback": {
          const feedbackResult = await apiSendUserFeedback(
            message.payload.message,
          );
          return feedbackResult;
        }

        default:
          return undefined;
      }
    };

    handleAsync()
      .then(sendResponse)
      .catch((err) => {
        // Intentional cancellation — not an error, no response needed
        if (err instanceof DOMException && err.name === 'AbortError') {
          sendResponse({ aborted: true });
          return;
        }

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
      // Update badge based on enabled state
      if (prefs.enabled === false) {
        chrome.action.setBadgeText({ text: "OFF" });
        chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
      } else {
        // Only clear if we were showing OFF (don't clear auth badge)
        chrome.action.getBadgeText({}).then((text) => {
          if (text === "OFF") {
            chrome.action.setBadgeText({ text: "" });
          }
        });
      }

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
                  "recall",
                  "provoking_question",
                  "insight",
                  "caveat",
                  "vocabulary",
                ],
                annotationFont: prefs.annotation_font,
                annotationFontSize: prefs.annotation_font_size,
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
