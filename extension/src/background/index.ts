import type { ExtensionMessage, UserPreferences } from "@oddity/shared";
import { DEFAULT_ENABLED_SITES, isBlockedDomain, MAX_TEXT_LENGTH } from "@oddity/shared";
import { sendToTab } from "../shared/messaging.js";
import {
  getAdapters,
  handleAdapterAlarm,
  initAdapterRefresh,
} from "./adapter-registry.js";
import {
  AuthError,
  RateLimitError,
  deleteAnnotation as apiDeleteAnnotation,
  deleteFeedback as apiDeleteFeedback,
  updateFeedback as apiUpdateFeedback,
  requestAnnotationsStreaming,
  requestSketchStreaming,
  saveAnnotation,
  saveFeedback as apiSaveFeedback,
  sendUserFeedback as apiSendUserFeedback,
  updateAnnotation as apiUpdateAnnotation,
} from "./api-client.js";
import { getEnabledSites, getProfile, getSession, getUserTier, signIn, signInWithGoogle, signOut, signUp, updateEnabledSites, updateProfile } from "./auth.js";
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

// ─── Per-tab concurrency limiter ───
// Prevents bursts of simultaneous API requests (personality change, "all" mode).
const MAX_CONCURRENT_PER_TAB = 3;
const tabConcurrency = new Map<number, number>();

/** Acquire a concurrency slot for a tab. Resolves when a slot is available. */
async function acquireSlot(tabId: number, signal: AbortSignal): Promise<void> {
  while ((tabConcurrency.get(tabId) ?? 0) >= MAX_CONCURRENT_PER_TAB) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise((r) => setTimeout(r, 200));
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  tabConcurrency.set(tabId, (tabConcurrency.get(tabId) ?? 0) + 1);
}

function releaseSlot(tabId: number): void {
  const current = tabConcurrency.get(tabId) ?? 1;
  if (current <= 1) tabConcurrency.delete(tabId);
  else tabConcurrency.set(tabId, current - 1);
}

// Track recently deleted annotation/feedback IDs so the stale-while-revalidate
// cache write doesn't re-add them from a concurrent server response.
const deletedAnnotationIds = new Set<string>();
const deletedFeedbackIds = new Set<string>();

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
          const { url, regionId, contentHash, text, mode: rawMode, personality, wordCount } =
            message.payload;
          // Guard against stale content scripts (pre-mode-refactor) sending undefined mode
          const mode = (rawMode === "overview" || rawMode === "depth") ? rawMode : "overview";

          // Proactive auth check — fail fast with badge if not signed in
          const session = await getSession();
          if (!session) {
            chrome.action.setBadgeText({ text: "!" });
            chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
            return { error: "Sign in required" };
          }

          // Session exists — clear any stale badge
          chrome.action.setBadgeText({ text: "" });

          // Build session cache key; overview is persona-independent
          const sessionCacheKey = mode === "overview" ? "overview:terry" : `${mode}:${personality ?? "terry"}`;

          // ── Session cache: stale-while-revalidate for revisits ──
          const cached = await getFromSessionCache(contentHash, sessionCacheKey);
          if (cached) {
            console.log(`[Oddity 1] Session cache hit for ${contentHash.slice(0, 12)}… (stale-while-revalidate)`);
            // Filter out locally deleted items before sending cached data
            const cachedAnnotations = cached.annotations.filter((a) => !deletedAnnotationIds.has(a.id));
            const cachedFeedback = cached.feedback.filter((f) => !deletedFeedbackIds.has(f.id));
            if (sender.tab?.id) {
              await sendToTab(sender.tab.id, {
                action: "annotationsReady",
                payload: {
                  regionId: contentHash,
                  annotations: cachedAnnotations,
                  feedback: cachedFeedback,
                },
              });
            }
            // DON'T return — fall through to fetch fresh merged data from server
          }

          // Cancel any previous in-flight request for the same tab+region+mode
          // Include mode in the key so overview and depth requests don't cancel each other
          const tabId = sender.tab?.id ?? 0;
          const key = abortKey(tabId, `${mode}:${regionId}`);
          inflight.get(key)?.abort();
          const controller = new AbortController();
          inflight.set(key, controller);

          // Throttle concurrent requests per tab to prevent rate limit bursts
          let slotAcquired = false;
          await acquireSlot(tabId, controller.signal);
          slotAcquired = true;

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
              mode,
              personality,
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

            // Filter out locally deleted items so stale-while-revalidate
            // doesn't re-add them from a concurrent server response.
            const annotations = result.annotations.filter(
              (a: { id: string }) => !deletedAnnotationIds.has(a.id),
            );
            const feedback = (result.feedback ?? []).filter(
              (f: { id: string }) => !deletedFeedbackIds.has(f.id),
            );

            // Populate caches for future revisits
            await setInSessionCache(contentHash, sessionCacheKey, annotations, feedback);
            await setUrlCache(url, contentHash, sessionCacheKey, annotations, feedback);

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
            if (slotAcquired) releaseSlot(tabId);
            if (inflight.get(key) === controller) {
              inflight.delete(key);
            }
          }
        }

        case "getUrlPrediction": {
          const prediction = await getUrlCache(message.payload.url);
          return prediction ?? null;
        }

        case "abortAllRequests": {
          // Abort all in-flight requests for the sending tab (SPA navigation cleanup)
          const abortTabId = sender.tab?.id ?? 0;
          const prefix = `${abortTabId}:`;
          for (const [key, controller] of inflight) {
            if (key.startsWith(prefix)) {
              controller.abort();
              inflight.delete(key);
            }
          }
          // Reset concurrency tracking for this tab
          tabConcurrency.delete(abortTabId);
          return { success: true };
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

          // Broadcast auth change to all other tabs (include user data to avoid re-querying auth)
          const signInTabId = sender.tab?.id;
          const signInUser = {
            email: data.user?.email ?? "",
            display_name: signInProfile?.display_name ?? null,
            tier: signInProfile?.tier ?? "free",
            annotation_count: 0,
          };
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (tab.id && tab.id !== signInTabId) {
                sendToTab(tab.id, { action: "authStateChanged", payload: { authenticated: true, user: signInUser } }).catch(() => {});
              }
            }
          });

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

        case "signInWithGoogle": {
          const data = await signInWithGoogle();
          const googleProfile = await getProfile();

          // Cache enabled sites locally after Google sign-in
          const googleSites = (await getEnabledSites()) ?? DEFAULT_ENABLED_SITES;
          const googleStored = await chrome.storage.local.get("preferences");
          const googlePrefs = (googleStored["preferences"] ?? {}) as Record<string, unknown>;
          await chrome.storage.local.set({
            preferences: { ...googlePrefs, enabled_sites: googleSites },
          });

          // Broadcast auth change to all other tabs
          const googleTabId = sender.tab?.id;
          const googleUser = {
            email: data.user?.email ?? "",
            display_name: googleProfile?.display_name ?? null,
            tier: googleProfile?.tier ?? "free",
            annotation_count: googleProfile?.annotation_count ?? 0,
          };
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (tab.id && tab.id !== googleTabId) {
                sendToTab(tab.id, {
                  action: "authStateChanged",
                  payload: { authenticated: true, user: googleUser },
                }).catch(() => {});
              }
            }
          });

          return {
            success: true,
            user: {
              id: data.user?.id ?? "",
              email: data.user?.email ?? "",
              display_name: googleProfile?.display_name ?? null,
              tier: googleProfile?.tier ?? "free",
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
          // Broadcast auth change to all other tabs
          const signOutTabId = sender.tab?.id;
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (tab.id && tab.id !== signOutTabId) {
                sendToTab(tab.id, { action: "authStateChanged", payload: { authenticated: false } }).catch(() => {});
              }
            }
          });
          return { success: true };
        }

        case "saveManualAnnotation": {
          const { url, contentHash, annotation, pageTitle } = message.payload;
          const saved = await saveAnnotation(url, contentHash, annotation, pageTitle);
          return saved;
        }

        case "requestSketch": {
          const { inputText, purpose, userReactions } = message.payload;
          const tabId = sender.tab?.id;
          if (!tabId) return { error: "No tab" };

          try {
            await requestSketchStreaming(
              {
                input_text: inputText,
                purpose,
                user_reactions: userReactions,
              },
              (text) => {
                sendToTab(tabId, {
                  action: "sketchChunk",
                  payload: { text, done: false },
                }).catch(() => {});
              },
            );
            await sendToTab(tabId, {
              action: "sketchChunk",
              payload: { text: "", done: true },
            });
          } catch (err) {
            console.error("[Oddity 1] Sketch error:", err);
            const isRateLimit = err instanceof RateLimitError;
            const errorText = isRateLimit
              ? `\n\n⚠️ Rate limited. Please wait a moment and try again.`
              : `\n\n⚠️ Something went wrong. Please try again.`;
            await sendToTab(tabId, {
              action: "sketchChunk",
              payload: { text: errorText, done: true },
            }).catch(() => {});
            return { error: String(err) };
          }
          return { success: true };
        }

        case "deleteAnnotation": {
          const { annotationId: delId, url: delUrl, contentHash: delHash } = message.payload;
          deletedAnnotationIds.add(delId);

          // Evict from caches FIRST (before API call) so that if the service
          // worker is killed mid-execution, the caches are already clean.
          for (const intensity of ["overview:terry", "overview:jerry", "overview:sally", "depth:terry", "depth:jerry", "depth:sally"]) {
            const cached = await getFromSessionCache(delHash, intensity);
            if (cached) {
              cached.annotations = cached.annotations.filter((a) => a.id !== delId);
              // Also remove orphaned feedback for this annotation
              cached.feedback = cached.feedback.filter((f) => f.annotation_id !== delId);
              await setInSessionCache(delHash, intensity, cached.annotations, cached.feedback);
            }
          }
          if (delUrl) {
            const urlCached = await getUrlCache(delUrl);
            if (urlCached) {
              urlCached.annotations = urlCached.annotations.filter((a) => a.id !== delId);
              urlCached.feedback = urlCached.feedback.filter((f) => f.annotation_id !== delId);
              await setUrlCache(delUrl, urlCached.contentHash, urlCached.mode, urlCached.annotations, urlCached.feedback);
            }
          }

          // Then delete from server (may fail if SW is killed, but caches are safe)
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
          const { annotationId, contentHash, url, feedbackType, replyText, pageTitle } =
            message.payload;
          const fb = await apiSaveFeedback({
            annotation_id: annotationId,
            content_hash: contentHash,
            url,
            feedback_type: feedbackType,
            reply_text: replyText,
            page_title: pageTitle,
          });

          // Update session cache so the next page load includes this feedback
          // immediately instead of waiting for the stale-while-revalidate fetch.
          for (const intensity of ["overview:terry", "overview:jerry", "overview:sally", "depth:terry", "depth:jerry", "depth:sally"]) {
            const cached = await getFromSessionCache(contentHash, intensity);
            if (cached) {
              cached.feedback.push(fb);
              await setInSessionCache(contentHash, intensity, cached.annotations, cached.feedback);
            }
          }

          return fb;
        }

        case "updateFeedback": {
          const { feedbackId: ufId, replyText: ufText, contentHash: ufHash, url: ufUrl } = message.payload;
          const updatedFb = await apiUpdateFeedback(ufId, ufText);

          // Update caches so edits survive page refresh
          if (ufHash) {
            for (const intensity of ["overview:terry", "overview:jerry", "overview:sally", "depth:terry", "depth:jerry", "depth:sally"]) {
              const cached = await getFromSessionCache(ufHash, intensity);
              if (cached) {
                const fb = cached.feedback.find((f) => f.id === ufId);
                if (fb) fb.reply_text = ufText;
                await setInSessionCache(ufHash, intensity, cached.annotations, cached.feedback);
              }
            }
          }
          if (ufUrl) {
            const urlCached = await getUrlCache(ufUrl);
            if (urlCached) {
              const fb = (urlCached as any).feedback?.find((f: any) => f.id === ufId);
              if (fb) fb.reply_text = ufText;
              await setUrlCache(ufUrl, urlCached.contentHash, urlCached.mode, urlCached.annotations, urlCached.feedback);
            }
          }

          return updatedFb;
        }

        case "deleteFeedback": {
          const { feedbackId: delFbId, contentHash: delFbHash, url: delFbUrl } = message.payload;
          deletedFeedbackIds.add(delFbId);

          // Evict from caches FIRST (before API call) so that if the service
          // worker is killed mid-execution, the caches are already clean.
          if (delFbHash) {
            for (const intensity of ["overview:terry", "overview:jerry", "overview:sally", "depth:terry", "depth:jerry", "depth:sally"]) {
              const cached = await getFromSessionCache(delFbHash, intensity);
              if (cached) {
                cached.feedback = cached.feedback.filter((f) => f.id !== delFbId);
                await setInSessionCache(delFbHash, intensity, cached.annotations, cached.feedback);
              }
            }
          }
          if (delFbUrl) {
            const urlCached = await getUrlCache(delFbUrl);
            if (urlCached) {
              urlCached.feedback = urlCached.feedback.filter((f) => f.id !== delFbId);
              await setUrlCache(delFbUrl, urlCached.contentHash, urlCached.mode, urlCached.annotations, urlCached.feedback);
            }
          }

          // Then delete from server
          await apiDeleteFeedback(delFbId);

          return { success: true };
        }

        case "updateAnnotation": {
          const { annotationId: annId, annotation: updatedAnn, url: updUrl, contentHash: updHash, pageTitle: updTitle } =
            message.payload;
          const result = await apiUpdateAnnotation(annId, updatedAnn, updUrl, updHash, updTitle);

          // Update caches so edits survive page refresh
          if (updHash) {
            for (const intensity of ["overview:terry", "overview:jerry", "overview:sally", "depth:terry", "depth:jerry", "depth:sally"]) {
              const cached = await getFromSessionCache(updHash, intensity);
              if (cached) {
                const idx = cached.annotations.findIndex((a) => a.id === annId);
                if (idx !== -1) cached.annotations[idx] = updatedAnn;
                await setInSessionCache(updHash, intensity, cached.annotations, cached.feedback);
              }
            }
          }
          if (updUrl) {
            const urlCached = await getUrlCache(updUrl);
            if (urlCached) {
              const idx = urlCached.annotations.findIndex((a) => a.id === annId);
              if (idx !== -1) urlCached.annotations[idx] = updatedAnn;
              await setUrlCache(updUrl, urlCached.contentHash, urlCached.mode, urlCached.annotations, urlCached.feedback);
            }
          }

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
          if (isBlockedDomain(domain)) {
            return { error: "Cannot enable extension on app.oddity1.com — annotations are built into the dashboard" };
          }
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

        case "fetchPdfData": {
          const { url: pdfUrl } = message.payload;
          try {
            const res = await fetch(pdfUrl);
            const buf = await res.arrayBuffer();
            return { data: Array.from(new Uint8Array(buf)) };
          } catch (err) {
            return { error: `Failed to fetch PDF: ${err}` };
          }
        }

        case "injectNextNewTab": {
          // Listen for the next new tab and inject the content script into it.
          // Used for PDF→HTML conversion: content script opens a blob tab,
          // and we need to inject the content script since blob: URLs don't
          // get automatic content script injection.
          const onCreated = (tab: chrome.tabs.Tab) => {
            chrome.tabs.onCreated.removeListener(onCreated);
            if (!tab.id) return;
            const tabId = tab.id;

            // Wait for the tab to finish loading before injecting
            const onUpdated = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
              if (updatedId !== tabId || info.status !== "complete") return;
              chrome.tabs.onUpdated.removeListener(onUpdated);

              const manifest = chrome.runtime.getManifest();
              const file = manifest.content_scripts?.[0]?.js?.[0];
              if (!file) return;

              chrome.scripting.executeScript({
                target: { tabId },
                files: [file],
              }).catch((err) => {
                console.warn("[Oddity 1] Failed to inject into blob tab:", err);
              });
            };
            chrome.tabs.onUpdated.addListener(onUpdated);
          };
          chrome.tabs.onCreated.addListener(onCreated);

          // Auto-cleanup if no tab is created within 10s
          setTimeout(() => chrome.tabs.onCreated.removeListener(onCreated), 10000);
          return { success: true };
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

        if (err instanceof RateLimitError) {
          console.warn(`[Oddity 1] Rate limited — retry after ${err.retryAfter}s`);
          sendResponse({ error: `Rate limited. Please wait ~${Math.ceil(err.retryAfter / 60)} min.`, rateLimited: true });
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
                annotationMode: prefs.annotation_mode ?? "overview",
                depthPersonality: ((prefs.depth_personality as string) === "gary" ? "sally" : prefs.depth_personality) ?? "jerry",
                visibleTypes: prefs.visible_types ?? [],
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


// ─── Eager Session Refresh on SW Boot ───
// MV3 service workers suspend/resume frequently, killing Supabase's
// autoRefreshToken timer. Re-arm it on every boot so the first API
// call after wake-up already has a fresh token.
getSession().catch(() => {});

console.log("[Oddity 1] Service worker loaded");
