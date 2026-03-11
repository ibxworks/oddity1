import type { ExtensionMessage, UserPreferences } from "@oddity/shared";
import { DEFAULT_ENABLED_SITES, MAX_TEXT_LENGTH } from "@oddity/shared";
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
  requestAnnotations,
  requestAnnotationsStreaming,
  saveAnnotation,
  saveFeedback as apiSaveFeedback,
  sendUserFeedback as apiSendUserFeedback,
  updateAnnotation as apiUpdateAnnotation,
} from "./api-client.js";
import { getEnabledSites, getProfile, getSession, getUserTier, signIn, signOut, signUp, updateEnabledSites, updateProfile } from "./auth.js";
import { setupContextMenu } from "./context-menu.js";
import { getFromSessionCache, setInSessionCache } from "./sw-cache.js";
import { getUrlCache, setUrlCache } from "./url-cache.js";

// ─── Optimization: per-request abort controllers ───
// Keyed by "tabId:regionId" so re-requesting the same region with new content
// cancels the previous in-flight request (even when the content hash differs).
const inflight = new Map<string, AbortController>();

function abortKey(tabId: number, regionId: string): string {
  return `${tabId}:${regionId}`;
}

// ─── Installed Event ───

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Oddity 1] Extension installed");
  setupContextMenu();
  initAdapterRefresh();

  // Migration: replace disabled_sites with enabled_sites
  const stored = await chrome.storage.local.get("preferences");
  const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
  if ('disabled_sites' in prefs) {
    delete prefs.disabled_sites;
    if (!Array.isArray(prefs.enabled_sites)) {
      prefs.enabled_sites = DEFAULT_ENABLED_SITES;
    }
    await chrome.storage.local.set({ preferences: prefs });
    console.log("[Oddity 1] Migrated disabled_sites → enabled_sites");
  }
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

          // ── Session cache: stale-while-revalidate for revisits ──
          // Send cached data immediately for instant render, but don't return —
          // fall through to fetch fresh merged data (with user annotations + feedback)
          const cached = await getFromSessionCache(contentHash, intensity);
          if (cached) {
            console.log(`[Oddity 1] Session cache hit for ${contentHash.slice(0, 12)}… (stale-while-revalidate)`);
            if (sender.tab?.id) {
              await sendToTab(sender.tab.id, {
                action: "annotationsReady",
                payload: {
                  regionId: contentHash,
                  annotations: cached.annotations,
                  feedback: cached.feedback,
                },
              });
            }
            // DON'T return — fall through to fetch fresh merged data from server
          }

          // Cancel any previous in-flight request for the same tab+region
          const tabId = sender.tab?.id ?? 0;
          const key = abortKey(tabId, regionId);
          inflight.get(key)?.abort();
          const controller = new AbortController();
          inflight.set(key, controller);

          try {
            // Defense-in-depth: validate payload before sending to API
            let validatedText = text;
            let validatedWordCount = wordCount;

            if (validatedText.length > MAX_TEXT_LENGTH) {
              console.log(`[Oddity 1] Truncating text from ${validatedText.length} to ${MAX_TEXT_LENGTH} chars`);
              validatedText = validatedText.slice(0, MAX_TEXT_LENGTH);
              validatedWordCount = validatedText.split(/\s+/).filter(Boolean).length;
            }

            if (validatedWordCount <= 0) {
              return { error: "No words to annotate" };
            }

            const requestPayload = {
              url,
              content_hash: contentHash,
              text: validatedText,
              intensity,
              word_count: validatedWordCount,
            };

            // Use streaming to progressively render annotations
            const result = await requestAnnotationsStreaming(
              requestPayload,
              (annotation) => {
                // Forward each annotation individually as it arrives
                if (sender.tab?.id && !controller.signal.aborted) {
                  sendToTab(sender.tab.id, {
                    action: "annotationReady",
                    payload: {
                      regionId: contentHash,
                      annotation,
                    },
                  }).catch(() => { /* tab may have closed */ });
                }
              },
              controller.signal,
            );

            // Check if aborted
            if (controller.signal.aborted) return { aborted: true };

            const annotations = result.annotations;
            const feedback = result.feedback ?? [];

            // Populate caches for future revisits
            await setInSessionCache(contentHash, intensity, annotations, feedback);
            await setUrlCache(url, contentHash, intensity, annotations, feedback);

            // Send final annotationsReady with complete set + feedback
            if (sender.tab?.id) {
              await sendToTab(sender.tab.id, {
                action: "annotationsReady",
                payload: {
                  regionId: contentHash,
                  annotations,
                  feedback,
                },
              });
            }

            return result;
          } finally {
            // Only remove if this controller is still the active one for this key.
            // A newer request may have already replaced it — deleting would orphan
            // the newer controller and make it unabortable.
            if (inflight.get(key) === controller) {
              inflight.delete(key);
            }
          }
        }

        case "getUrlPrediction": {
          const prediction = await getUrlCache(message.payload.url);
          return prediction ?? null;
        }

        case "getAdapters": {
          const adapters = await getAdapters();
          return { adapters };
        }

        case "openPopup": {
          chrome.action.openPopup().catch(() => {});
          return {};
        }

        case "openOptions": {
          chrome.runtime.openOptionsPage();
          return {};
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

          // Cache enabled sites locally after sign-in
          const signInSites = await getEnabledSites() ?? DEFAULT_ENABLED_SITES;
          const signInStored = await chrome.storage.local.get("preferences");
          const signInPrefs = (signInStored["preferences"] ?? {}) as Record<string, unknown>;
          await chrome.storage.local.set({ preferences: { ...signInPrefs, enabled_sites: signInSites } });

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

          // Cache default enabled sites locally after sign-up
          if (!needsConfirmation) {
            const signUpStored = await chrome.storage.local.get("preferences");
            const signUpPrefs = (signUpStored["preferences"] ?? {}) as Record<string, unknown>;
            await chrome.storage.local.set({ preferences: { ...signUpPrefs, enabled_sites: DEFAULT_ENABLED_SITES } });
          }

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

        case "getEnabledSites": {
          const sites = await getEnabledSites() ?? DEFAULT_ENABLED_SITES;
          // Cache locally
          const esStored = await chrome.storage.local.get("preferences");
          const esPrefs = (esStored["preferences"] ?? {}) as Record<string, unknown>;
          await chrome.storage.local.set({ preferences: { ...esPrefs, enabled_sites: sites } });
          return { sites };
        }

        case "addEnabledSite": {
          const { domain } = message.payload;
          const addStored = await chrome.storage.local.get("preferences");
          const addPrefs = (addStored["preferences"] ?? {}) as Record<string, unknown>;
          const addList = Array.isArray(addPrefs.enabled_sites) ? [...addPrefs.enabled_sites as string[]] : [...DEFAULT_ENABLED_SITES];
          if (!addList.includes(domain)) {
            addList.push(domain);
          }
          await chrome.storage.local.set({ preferences: { ...addPrefs, enabled_sites: addList } });
          // Persist to Supabase (non-blocking)
          updateEnabledSites(addList).catch((err) => {
            console.error("[Oddity 1] Failed to sync enabled sites to Supabase:", err);
          });
          // Broadcast to all tabs
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (tab.id) {
                sendToTab(tab.id, {
                  action: "enabledSitesUpdated",
                  payload: { sites: addList },
                }).catch(() => {});
              }
            }
          });
          return { sites: addList };
        }

        case "setBadge": {
          const { text, color } = message.payload;
          chrome.action.setBadgeText({ text, tabId: sender.tab?.id });
          if (color) chrome.action.setBadgeBackgroundColor({ color, tabId: sender.tab?.id });
          return {};
        }

        case "removeEnabledSite": {
          const { domain: rmDomain } = message.payload;
          const rmStored = await chrome.storage.local.get("preferences");
          const rmPrefs = (rmStored["preferences"] ?? {}) as Record<string, unknown>;
          const rmList = Array.isArray(rmPrefs.enabled_sites) ? (rmPrefs.enabled_sites as string[]).filter(s => s !== rmDomain) : [...DEFAULT_ENABLED_SITES];
          await chrome.storage.local.set({ preferences: { ...rmPrefs, enabled_sites: rmList } });
          // Persist to Supabase (non-blocking)
          updateEnabledSites(rmList).catch((err) => {
            console.error("[Oddity 1] Failed to sync enabled sites to Supabase:", err);
          });
          // Broadcast to all tabs
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (tab.id) {
                sendToTab(tab.id, {
                  action: "enabledSitesUpdated",
                  payload: { sites: rmList },
                }).catch(() => {});
              }
            }
          });
          return { sites: rmList };
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
                  "user_written",
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
