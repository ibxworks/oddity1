import type {
  AnnotationFont,
  AnnotationFontSize,
  AnnotationType,
  Intensity,
  UserPreferences,
  UserTier,
} from "@oddity/shared";
import { ALL_ANNOTATION_TYPES } from "@oddity/shared";
import { sendMessage } from "../shared/messaging.js";

// ─── DOM refs ───

const enabledToggle = document.getElementById(
  "enabled-toggle",
) as HTMLInputElement;
const toggleLabel = document.getElementById("toggle-label")!;
const intensityGroup = document.getElementById("intensity-group")!;
const typeFilters = document.getElementById("type-filters")!;
const exportBtn = document.getElementById("export-btn")!;
const openOptions = document.getElementById("open-options")!;
const welcomeText = document.getElementById("welcome-text")!;
const totalCountNumber = document.getElementById("total-count-number")!;
const fontSelect = document.getElementById("font-select") as HTMLSelectElement;
const fontSizeGroup = document.getElementById("font-size-group")!;

// Auth form refs
const authForm = document.getElementById("auth-form")!;
const authFormTitle = document.getElementById("auth-form-title")!;
const authError = document.getElementById("auth-error")!;
const authSuccess = document.getElementById("auth-success")!;
const authName = document.getElementById("auth-name") as HTMLInputElement;
const authEmail = document.getElementById("auth-email") as HTMLInputElement;
const authPassword = document.getElementById(
  "auth-password",
) as HTMLInputElement;
const authSubmitBtn = document.getElementById("auth-submit-btn")!;
const authToggleLink = document.getElementById("auth-toggle-link")!;
const authToggleText = document.getElementById("auth-toggle-text")!;
const mainContent = document.getElementById("main-content")!;

// Profile refs
const profileBtn = document.getElementById("profile-btn")!;
const profileAvatar = document.getElementById("profile-avatar")!;
const profileName = document.getElementById("profile-name")!;
const tierBadge = document.getElementById("tier-badge")!;
const profilePopover = document.getElementById("profile-popover")!;
const popoverName = document.getElementById("popover-name")!;
const popoverEmail = document.getElementById("popover-email")!;
const popoverTier = document.getElementById("popover-tier")!;
const popoverSignOut = document.getElementById("popover-sign-out")!;

// Feedback dialog refs
const feedbackDialog = document.getElementById("feedback-dialog")!;
const feedbackEmail = document.getElementById("feedback-email")!;
const feedbackTextarea = document.getElementById(
  "feedback-textarea",
) as HTMLTextAreaElement;
const feedbackCancelBtn = document.getElementById("feedback-cancel-btn")!;
const feedbackSendBtn = document.getElementById("feedback-send-btn")!;
const feedbackStatusEl = document.getElementById("feedback-status")!;
const feedbackLink = document.getElementById("feedback-link")!;

// Export dialog refs
const exportDialog = document.getElementById("export-dialog")!;
const exportTitle = document.getElementById("export-title") as HTMLInputElement;
const exportSubtitle = document.getElementById(
  "export-subtitle",
) as HTMLInputElement;
const exportProBadge = document.getElementById("export-pro-badge")!;
const exportCancelBtn = document.getElementById("export-cancel-btn")!;
const exportDownloadBtn = document.getElementById("export-download-btn")!;
const exportStatusEl = document.getElementById("export-status")!;

let isSignUpMode = false;

// ─── State ───

let currentPrefs: Required<UserPreferences> = {
  enabled: true,
  intensity: "default",
  visible_types: [...ALL_ANNOTATION_TYPES],
  disabled_sites: [],
  annotation_font: "default",
  annotation_font_size: "default",
};

let currentUser: {
  id: string;
  email: string;
  display_name: string | null;
  tier: UserTier;
  annotation_count?: number;
} | null = null;

// ─── Greetings ───

const GREETINGS = [
  (name: string) => `How you doin' ${name}?`,
  (name: string) => `Vamos, ${name}`,
  (name: string) => `We're here with you, ${name}`,
  (name: string) => `Let's go, ${name}`,
  (name: string) => `Good to see you, ${name}`,
];

function showWelcomeText(displayName: string | null): void {
  if (!displayName) {
    welcomeText.style.display = "none";
    return;
  }
  const firstName = displayName.split(" ")[0];
  const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  welcomeText.textContent = greeting(firstName);
  welcomeText.style.display = "";
}

// ─── Init ───

async function init(): Promise<void> {
  // Load preferences from storage
  const stored = await chrome.storage.local.get("preferences");
  if (stored["preferences"]) {
    const prefs = stored["preferences"] as UserPreferences;
    currentPrefs = {
      enabled: prefs.enabled ?? true,
      intensity: prefs.intensity ?? "default",
      visible_types: prefs.visible_types ?? [...ALL_ANNOTATION_TYPES],
      disabled_sites: prefs.disabled_sites ?? [],
      annotation_font: prefs.annotation_font ?? "default",
      annotation_font_size: prefs.annotation_font_size ?? "default",
    };
  }

  // Migrate old type names in stored preferences
  const typeMap: Record<string, string> = {
    underline: "recall",
    question: "provoking_question",
  };
  if (currentPrefs.visible_types.some((t) => t in typeMap)) {
    currentPrefs.visible_types = currentPrefs.visible_types.map(
      (t) => (typeMap[t] ?? t) as AnnotationType,
    );
    savePrefs();
  }

  // Apply state to UI
  applyPrefsToUI();

  // Fetch auth status
  loadAuthStatus();
}

function applyPrefsToUI(): void {
  // Toggle
  enabledToggle.checked = currentPrefs.enabled;
  toggleLabel.textContent = currentPrefs.enabled ? "On" : "Off";

  // Intensity buttons
  for (const btn of intensityGroup.querySelectorAll<HTMLButtonElement>(
    ".intensity-btn",
  )) {
    btn.classList.toggle(
      "active",
      btn.dataset["intensity"] === currentPrefs.intensity,
    );
  }

  // Type filter checkboxes
  for (const cb of typeFilters.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  )) {
    const t = cb.dataset["type"] as AnnotationType;
    cb.checked = currentPrefs.visible_types.includes(t);
  }

  // Font select
  fontSelect.value = currentPrefs.annotation_font;

  // Font size buttons
  for (const btn of fontSizeGroup.querySelectorAll<HTMLButtonElement>(
    ".intensity-btn",
  )) {
    btn.classList.toggle(
      "active",
      btn.dataset["fontsize"] === currentPrefs.annotation_font_size,
    );
  }
}

async function savePrefs(): Promise<void> {
  await chrome.storage.local.set({ preferences: currentPrefs });
}

// ─── Auth ───

function showAuthenticatedUI(user: {
  email: string;
  display_name: string | null;
  tier: UserTier;
  annotation_count?: number;
}): void {
  authForm.style.display = "none";
  mainContent.classList.remove("hidden");

  // Profile button
  const displayName = user.display_name || user.email.split("@")[0];
  const initial = displayName.charAt(0).toUpperCase();
  profileAvatar.textContent = initial;
  profileName.textContent = displayName;

  // Tier badge
  tierBadge.textContent = user.tier === "pro" ? "PRO" : "FREE";
  tierBadge.classList.toggle("pro", user.tier === "pro");

  // Popover data
  popoverName.textContent = user.display_name || displayName;
  popoverEmail.textContent = user.email;
  popoverTier.textContent = user.tier === "pro" ? "Pro Plan" : "Free Plan";

  // Welcome text
  showWelcomeText(user.display_name);

  // Total annotation count
  totalCountNumber.textContent = String(user.annotation_count ?? 0);
}

function showUnauthenticatedUI(): void {
  authForm.style.display = "";
  mainContent.classList.add("hidden");
  welcomeText.style.display = "none";
  currentUser = null;
}

function showAuthError(msg: string): void {
  authError.textContent = msg;
  authError.style.display = "block";
  authSuccess.style.display = "none";
}

function hideAuthMessages(): void {
  authError.style.display = "none";
  authSuccess.style.display = "none";
}

function friendlyAuthError(error: string): string {
  if (error.includes("Invalid login credentials"))
    return "Invalid email or password.";
  if (error.includes("Email not confirmed"))
    return "Please confirm your email before signing in.";
  if (error.includes("User already registered"))
    return "An account with this email already exists.";
  if (error.includes("Password should be at least"))
    return "Password must be at least 6 characters.";
  if (error.includes("Unable to validate email"))
    return "Please enter a valid email address.";
  return error;
}

async function refreshActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      await chrome.tabs.reload(tab.id);
    }
  } catch {
    // Tab refresh failed; not critical
  }
}

async function loadAuthStatus(): Promise<void> {
  try {
    const result = await sendMessage<{
      authenticated: boolean;
      user: {
        id: string;
        email: string;
        display_name: string | null;
        tier: UserTier;
        annotation_count?: number;
      } | null;
    }>({
      action: "getAuthStatus",
      payload: {},
    });

    if (result.authenticated && result.user) {
      currentUser = result.user;
      showAuthenticatedUI(result.user);
      chrome.action.setBadgeText({ text: "" });

      // If extension is disabled, show OFF badge
      if (!currentPrefs.enabled) {
        chrome.action.setBadgeText({ text: "OFF" });
        chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
      }
    } else {
      showUnauthenticatedUI();
    }
  } catch {
    showUnauthenticatedUI();
  }
}

// ─── Event Handlers ───

// Toggle enabled/disabled
enabledToggle.addEventListener("change", () => {
  currentPrefs.enabled = enabledToggle.checked;
  toggleLabel.textContent = currentPrefs.enabled ? "On" : "Off";

  // Update badge
  if (!currentPrefs.enabled) {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }

  savePrefs();
});

// Intensity selection
intensityGroup.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
    ".intensity-btn",
  );
  if (!btn) return;

  const intensity = btn.dataset["intensity"] as Intensity | undefined;
  if (!intensity) return;

  currentPrefs.intensity = intensity;

  for (const b of intensityGroup.querySelectorAll<HTMLButtonElement>(
    ".intensity-btn",
  )) {
    b.classList.toggle("active", b === btn);
  }

  savePrefs();
});

// Type filter checkboxes
typeFilters.addEventListener("change", (e) => {
  const cb = e.target as HTMLInputElement;
  const type = cb.dataset["type"] as AnnotationType | undefined;
  if (!type) return;

  if (cb.checked) {
    if (!currentPrefs.visible_types.includes(type)) {
      currentPrefs.visible_types.push(type);
    }
  } else {
    currentPrefs.visible_types = currentPrefs.visible_types.filter(
      (t) => t !== type,
    );
  }

  savePrefs();
});

// Font select
fontSelect.addEventListener("change", () => {
  currentPrefs.annotation_font = fontSelect.value as AnnotationFont;
  savePrefs();
});

// Font size buttons
fontSizeGroup.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
    ".intensity-btn",
  );
  if (!btn) return;

  const size = btn.dataset["fontsize"] as AnnotationFontSize | undefined;
  if (!size) return;

  currentPrefs.annotation_font_size = size;

  for (const b of fontSizeGroup.querySelectorAll<HTMLButtonElement>(
    ".intensity-btn",
  )) {
    b.classList.toggle("active", b === btn);
  }

  savePrefs();
});

// Export button — show export dialog
exportBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    exportTitle.value = tab?.title ?? "Untitled Page";
    exportSubtitle.value = "Created with Oddity 1";

    // Check user tier for subtitle gating
    try {
      const result = await sendMessage<{ tier: UserTier }>({
        action: "getUserTier",
        payload: {},
      });
      if (result.tier !== "pro") {
        exportSubtitle.disabled = true;
        exportProBadge.style.display = "inline-block";
      } else {
        exportSubtitle.disabled = false;
        exportProBadge.style.display = "none";
      }
    } catch {
      exportSubtitle.disabled = true;
      exportProBadge.style.display = "inline-block";
    }

    // Show dialog, hide main content
    mainContent.style.display = "none";
    exportDialog.style.display = "block";
    exportStatusEl.style.display = "none";
    exportStatusEl.className = "export-status";
  } catch {
    // Failed to set up export dialog
  }
});

// Export cancel
exportCancelBtn.addEventListener("click", () => {
  exportDialog.style.display = "none";
  mainContent.style.display = "";
});

// Export download
exportDownloadBtn.addEventListener("click", async () => {
  const title = exportTitle.value.trim() || "Untitled";
  const subtitle = exportSubtitle.value.trim();

  exportDownloadBtn.textContent = "Generating...";
  exportDownloadBtn.setAttribute("disabled", "");
  exportStatusEl.style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error("No active tab");

    const result = (await chrome.tabs.sendMessage(tab.id, {
      action: "exportPdf",
      payload: { title, subtitle },
    })) as { success: boolean; error?: string };

    if (result?.success) {
      exportStatusEl.textContent = "Print dialog opened — choose Save as PDF";
      exportStatusEl.className = "export-status success";
      exportStatusEl.style.display = "block";
      setTimeout(() => {
        exportDialog.style.display = "none";
        mainContent.style.display = "";
      }, 2500);
    } else {
      throw new Error(result?.error ?? "Export failed");
    }
  } catch (err) {
    exportStatusEl.textContent = String(
      err instanceof Error ? err.message : "Export failed",
    );
    exportStatusEl.className = "export-status error";
    exportStatusEl.style.display = "block";
  } finally {
    exportDownloadBtn.textContent = "Download";
    exportDownloadBtn.removeAttribute("disabled");
  }
});

// Open options page
openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ─── Profile Popover ───

profileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isVisible = profilePopover.style.display !== "none";
  profilePopover.style.display = isVisible ? "none" : "";
});

// Click outside popover → close it
document.addEventListener("click", (e) => {
  if (
    profilePopover.style.display !== "none" &&
    !profilePopover.contains(e.target as Node) &&
    !profileBtn.contains(e.target as Node)
  ) {
    profilePopover.style.display = "none";
  }
});

// Sign out from popover
popoverSignOut.addEventListener("click", async () => {
  profilePopover.style.display = "none";
  try {
    await sendMessage({ action: "signOut", payload: {} });
  } catch {
    // Sign out failed; still show unauthenticated UI
  }
  showUnauthenticatedUI();
  refreshActiveTab();
});

// ─── Auth Event Handlers ───

// Toggle between sign-in and sign-up mode
authToggleLink.addEventListener("click", (e) => {
  e.preventDefault();
  isSignUpMode = !isSignUpMode;
  hideAuthMessages();

  const authTerms = document.getElementById("auth-terms")!;
  if (isSignUpMode) {
    authFormTitle.textContent = "Sign Up";
    authSubmitBtn.textContent = "Sign Up";
    authToggleText.textContent = "Already have an account? ";
    authToggleLink.textContent = "Sign In";
    authName.style.display = "";
    authTerms.style.display = "block";
  } else {
    authFormTitle.textContent = "Sign In";
    authSubmitBtn.textContent = "Sign In";
    authToggleText.textContent = "Don't have an account? ";
    authToggleLink.textContent = "Sign Up";
    authName.style.display = "none";
    authName.value = "";
    authTerms.style.display = "none";
  }
});

// Submit auth form
authSubmitBtn.addEventListener("click", async () => {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  const displayName = authName.value.trim();

  hideAuthMessages();

  if (!email || !password) {
    showAuthError("Please enter both email and password.");
    return;
  }

  if (isSignUpMode && !displayName) {
    showAuthError("Please enter your name.");
    return;
  }

  authSubmitBtn.textContent = isSignUpMode ? "Signing up..." : "Signing in...";
  authSubmitBtn.setAttribute("disabled", "");

  try {
    if (isSignUpMode) {
      const result = await sendMessage<{
        success: boolean;
        needsConfirmation?: boolean;
        user: { id: string; email: string } | null;
        error?: string;
      }>({ action: "signUp", payload: { email, password, displayName } });

      if (result.error) {
        showAuthError(friendlyAuthError(result.error));
        return;
      }

      if (result.needsConfirmation) {
        authSuccess.textContent =
          "Check your email to confirm your account, then sign in.";
        authSuccess.style.display = "block";
        authError.style.display = "none";
        // Auto-switch to sign-in mode
        isSignUpMode = false;
        authFormTitle.textContent = "Sign In";
        authSubmitBtn.textContent = "Sign In";
        authToggleText.textContent = "Don't have an account? ";
        authToggleLink.textContent = "Sign Up";
        authName.style.display = "none";
        authName.value = "";
        return;
      }

      // Sign-up with auto-confirm (no email verification)
      if (result.user) {
        currentUser = {
          id: result.user.id,
          email: result.user.email,
          display_name: displayName,
          tier: "free",
        };
        showAuthenticatedUI({
          email: result.user.email,
          display_name: displayName,
          tier: "free",
        });
        chrome.action.setBadgeText({ text: "" });

        refreshActiveTab();
      }
    } else {
      const result = await sendMessage<{
        success: boolean;
        user: {
          id: string;
          email: string;
          display_name: string | null;
          tier: UserTier;
        };
        error?: string;
      }>({ action: "signIn", payload: { email, password } });

      if (result.error) {
        showAuthError(friendlyAuthError(result.error));
        return;
      }

      currentUser = result.user;
      showAuthenticatedUI(result.user);
      chrome.action.setBadgeText({ text: "" });
      refreshActiveTab();
    }
  } catch (err) {
    showAuthError(friendlyAuthError(String(err)));
  } finally {
    authSubmitBtn.textContent = isSignUpMode ? "Sign Up" : "Sign In";
    authSubmitBtn.removeAttribute("disabled");
  }
});

// Enter key on password → submit
authPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    authSubmitBtn.click();
  }
});

// Enter key on name → focus email
authName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    authEmail.focus();
  }
});

// Enter key on email → focus password
authEmail.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    authPassword.focus();
  }
});

// ─── Feedback Dialog ───

feedbackLink.addEventListener("click", (e) => {
  e.preventDefault();
  feedbackEmail.textContent = currentUser?.email ?? "";
  feedbackTextarea.value = "";
  feedbackStatusEl.style.display = "none";
  feedbackStatusEl.className = "feedback-status";
  mainContent.style.display = "none";
  feedbackDialog.style.display = "block";
});

feedbackCancelBtn.addEventListener("click", () => {
  feedbackDialog.style.display = "none";
  mainContent.style.display = "";
});

feedbackSendBtn.addEventListener("click", async () => {
  const message = feedbackTextarea.value.trim();
  if (!message) return;

  feedbackSendBtn.textContent = "Sending...";
  feedbackSendBtn.setAttribute("disabled", "");
  feedbackStatusEl.style.display = "none";

  try {
    const result = await sendMessage<{ success: boolean; error?: string }>({
      action: "sendUserFeedback",
      payload: { message },
    });

    if (result.error) throw new Error(result.error);

    feedbackStatusEl.textContent = "Feedback sent! Thank you.";
    feedbackStatusEl.className = "feedback-status success";
    feedbackStatusEl.style.display = "block";
    setTimeout(() => {
      feedbackDialog.style.display = "none";
      mainContent.style.display = "";
    }, 1500);
  } catch (err) {
    feedbackStatusEl.textContent = String(
      err instanceof Error ? err.message : "Failed to send feedback",
    );
    feedbackStatusEl.className = "feedback-status error";
    feedbackStatusEl.style.display = "block";
  } finally {
    feedbackSendBtn.textContent = "Send";
    feedbackSendBtn.removeAttribute("disabled");
  }
});

// ─── Start ───

init();
