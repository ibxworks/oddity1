import type {
  AnnotationFont,
  AnnotationFontSize,
  UserContextMode,
  UserPreferences,
  UserTier,
} from "@oddity/shared";
import { isBlockedDomain } from "@oddity/shared";
import { sendMessage } from "../shared/messaging.js";

// ─── DOM refs ───

const enabledToggle = document.getElementById(
  "enabled-toggle",
) as HTMLInputElement;
const toggleLabel = document.getElementById("toggle-label")!;
const exportBtn = document.getElementById("export-btn")!;
const openOptions = document.getElementById("open-options")!;
const totalCountNumber = document.getElementById("total-count-number")!;
const fontSelect = document.getElementById("font-select") as HTMLSelectElement;
const fontSizeSelect = document.getElementById(
  "font-size-select",
) as HTMLSelectElement;

// Auth form refs
const authForm = document.getElementById("auth-form")!;
const authError = document.getElementById("auth-error")!;
const authSuccess = document.getElementById("auth-success")!;
const authName = document.getElementById("auth-name") as HTMLInputElement;
const authEmail = document.getElementById("auth-email") as HTMLInputElement;
const authPassword = document.getElementById(
  "auth-password",
) as HTMLInputElement;
const authSubmitBtn = document.getElementById("auth-submit-btn")!;
const authGoogleBtn = document.getElementById(
  "auth-google-btn",
)! as HTMLButtonElement;
const authForgotLink = document.getElementById("auth-forgot-link")!;
const authToggleLink = document.getElementById("auth-toggle-link")!;
const authToggleText = document.getElementById("auth-toggle-text")!;
const mainContent = document.getElementById("main-content")!;
const blockedDomainSection = document.getElementById("blocked-domain-section")!;

// Persona picker refs (top section)
const profilePersonaSelect = document.getElementById(
  "profile-persona-select",
) as HTMLElement;

// Auth bar refs (bottom)
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
const feedbackRoleSelect = document.getElementById(
  "feedback-role",
) as HTMLSelectElement;
const feedbackRoleOther = document.getElementById(
  "feedback-role-other",
) as HTMLInputElement;
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
const exportStandardBadge = document.getElementById("export-standard-badge")!;
const exportCancelBtn = document.getElementById("export-cancel-btn")!;
const exportDownloadBtn = document.getElementById("export-download-btn")!;
const exportStatusEl = document.getElementById("export-status")!;

let isSignUpMode = true;

// ─── State ───

let currentPrefs: Required<UserPreferences> = {
  enabled: true,
  annotation_mode: "overview",
  depth_context_mode: undefined as unknown as UserContextMode,
  depth_context_note: "",
  visible_types: [],
  enabled_sites: [],
  annotation_font: "fraunces",
  annotation_font_size: "default",
};

let currentUser: {
  id: string;
  email: string;
  display_name: string | null;
  tier: UserTier;
  annotation_count?: number;
} | null = null;

let upgradeToastEl: HTMLDivElement | null = null;
let upgradeToastTimer: number | null = null;

// ─── Font appearance ───

const FONT_FAMILY_MAP: Record<AnnotationFont, string> = {
  default: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  fraunces: '"Fraunces", Georgia, serif',
  kalam: '"Kalam", cursive, sans-serif',
  helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  arial: "Arial, sans-serif",
  georgia: "Georgia, serif",
};

function updateFontSelectAppearance(): void {
  const family =
    FONT_FAMILY_MAP[fontSelect.value as AnnotationFont] ||
    '"Helvetica Neue", Helvetica, Arial, sans-serif';
  fontSelect.style.fontFamily = family;
}

// ─── Init ───

async function init(): Promise<void> {
  // Load preferences from storage
  const stored = await chrome.storage.local.get("preferences");
  if (stored["preferences"]) {
    const prefs = stored["preferences"] as UserPreferences;
    currentPrefs = {
      enabled: prefs.enabled ?? true,
      annotation_mode: prefs.annotation_mode ?? "overview",
      depth_context_mode: prefs.depth_context_mode as UserContextMode,
      depth_context_note: prefs.depth_context_note ?? "",
      visible_types: [],
      enabled_sites: prefs.enabled_sites ?? [],
      annotation_font: prefs.annotation_font ?? "fraunces",
      annotation_font_size: prefs.annotation_font_size ?? "default",
    };
  } else {
    // First launch — persist defaults so subsequent sessions always read from storage
    await savePrefs();
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

  // Context mode dropdown
  const contextModeSelect = document.getElementById("context-mode-select") as HTMLSelectElement | null;
  if (contextModeSelect) {
    contextModeSelect.value = currentPrefs.depth_context_mode ?? "";
  }

  // Context note input
  const contextNoteInput = document.getElementById("context-note-input") as HTMLInputElement | null;
  if (contextNoteInput) {
    contextNoteInput.value = currentPrefs.depth_context_note ?? "";
  }

  // Sync top label with mode
  const MODE_LABELS: Record<string, string> = {
    "info-takeaway": "Info Takeaway",
    "brainstorm": "Brainstorm",
    "argument-formation": "Argument",
    "decision": "Decision",
    "learning": "Learning",
  };
  const modeLabel = currentPrefs.depth_context_mode
    ? MODE_LABELS[currentPrefs.depth_context_mode] ?? "Default"
    : "Default";
  profilePersonaSelect.textContent = modeLabel;

  // Font select
  fontSelect.value = currentPrefs.annotation_font;
  updateFontSelectAppearance();

  // Font size select
  fontSizeSelect.value = currentPrefs.annotation_font_size;
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

  const displayName =
    user.display_name || user.email.split("@")[0] || user.email;
  const initial = displayName.charAt(0).toUpperCase();

  // Auth bar (bottom)
  profileAvatar.textContent = initial;
  profileName.textContent = displayName;

  // Tier badge
  tierBadge.textContent =
    user.tier === "standard" ? "Standard" : "Get Standard";
  tierBadge.classList.toggle("standard", user.tier === "standard");
  tierBadge.style.cursor = user.tier !== "standard" ? "pointer" : "";
  tierBadge.onclick =
    user.tier !== "standard"
      ? () => chrome.tabs.create({ url: "https://app.oddity1.com/plans" })
      : null;

  // Popover data
  popoverName.textContent = user.display_name ?? displayName;
  popoverEmail.textContent = user.email;
  popoverTier.textContent =
    user.tier === "standard" ? "Standard Plan" : "Free Plan";

  // Total annotation count
  totalCountNumber.textContent = String(user.annotation_count ?? 0);

}

function showUnauthenticatedUI(): void {
  authForm.style.display = "";
  mainContent.classList.add("hidden");
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

function showUpgradeToast(msg: string): void {
  if (!upgradeToastEl) {
    upgradeToastEl = document.createElement("div");
    upgradeToastEl.style.cssText = [
      "position: absolute",
      "left: 20px",
      "right: 20px",
      "bottom: 12px",
      "display: none",
      "padding: 8px 10px",
      "border-radius: 10px",
      "font-size: 12px",
      "line-height: 1.3",
      "background: #fef3c7",
      "color: #92400e",
      "z-index: 9999",
      "text-align: center",
    ].join(";");
    document.body.appendChild(upgradeToastEl);
  }

  upgradeToastEl.textContent = msg;
  upgradeToastEl.style.display = "block";

  if (upgradeToastTimer !== null) window.clearTimeout(upgradeToastTimer);
  upgradeToastTimer = window.setTimeout(() => {
    if (upgradeToastEl) upgradeToastEl.style.display = "none";
  }, 3000);
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
      chrome.action.setBadgeText({ text: "" });

      if (!currentPrefs.enabled) {
        chrome.action.setBadgeText({ text: "OFF" });
        chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
      }

      // Resolve active tab domain for blocked-domain check
      await resolveActiveTabDomain();

      // Blocked domain — show blocked section instead of any other UI
      if (isBlockedDomain(activeTabDomain)) {
        mainContent.classList.add("hidden");
        blockedDomainSection.style.display = "";
        return;
      }

      showAuthenticatedUI(result.user);
    } else {
      showUnauthenticatedUI();
    }
  } catch {
    showUnauthenticatedUI();
  }
}

// ─── Active Tab Domain ───

let activeTabDomain = "";

async function resolveActiveTabDomain(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.url) return;
    const url = new URL(tab.url);
    activeTabDomain = url.hostname.replace(/^www\./, "");
  } catch {
    // Can't determine domain
  }
}

// ─── Event Handlers ───

// Toggle enabled/disabled
enabledToggle.addEventListener("change", () => {
  currentPrefs.enabled = enabledToggle.checked;
  toggleLabel.textContent = currentPrefs.enabled ? "On" : "Off";

  if (!currentPrefs.enabled) {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }

  savePrefs();
});

// Context mode selection (depth mode)
const contextModeSelect = document.getElementById("context-mode-select") as HTMLSelectElement | null;
if (contextModeSelect) {
  contextModeSelect.addEventListener("change", () => {
    const value = contextModeSelect.value;
    currentPrefs.depth_context_mode = (value || undefined) as UserContextMode;

    // Sync the top persona selector label
    const MODE_LABELS: Record<string, string> = {
      "info-takeaway": "Info Takeaway",
      "brainstorm": "Brainstorm",
      "argument-formation": "Argument",
      "decision": "Decision",
      "learning": "Learning",
    };
    profilePersonaSelect.textContent = value ? (MODE_LABELS[value] ?? "Default") : "Default";

    savePrefs();
  });
}

// Context note input (depth mode)
const contextNoteInput = document.getElementById("context-note-input") as HTMLInputElement | null;
if (contextNoteInput) {
  let noteDebounce: number | null = null;
  contextNoteInput.addEventListener("input", () => {
    if (noteDebounce !== null) window.clearTimeout(noteDebounce);
    noteDebounce = window.setTimeout(() => {
      currentPrefs.depth_context_note = contextNoteInput.value.slice(0, 500);
      savePrefs();
    }, 400);
  });
}

// Font select
fontSelect.addEventListener("change", () => {
  currentPrefs.annotation_font = fontSelect.value as AnnotationFont;
  updateFontSelectAppearance();
  savePrefs();
});

// Font size select
fontSizeSelect.addEventListener("change", () => {
  currentPrefs.annotation_font_size =
    fontSizeSelect.value as AnnotationFontSize;
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

    try {
      const result = await sendMessage<{ tier: UserTier }>({
        action: "getUserTier",
        payload: {},
      });
      if (result.tier !== "standard") {
        exportSubtitle.disabled = true;
        exportStandardBadge.style.display = "inline-block";
      } else {
        exportSubtitle.disabled = false;
        exportStandardBadge.style.display = "none";
      }
    } catch {
      exportSubtitle.disabled = true;
      exportStandardBadge.style.display = "inline-block";
    }

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


// ─── Profile Popover (bottom bar) ───

profileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isVisible = profilePopover.style.display !== "none";
  profilePopover.style.display = isVisible ? "none" : "";
});

// Click outside → close both dropdowns
document.addEventListener("click", (e) => {
  if (
    profilePopover.style.display !== "none" &&
    !profilePopover.contains(e.target as Node) &&
    !profileBtn.contains(e.target as Node)
  ) {
    profilePopover.style.display = "none";
  }
});

// Sign out from bottom popover
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

authToggleLink.addEventListener("click", (e) => {
  e.preventDefault();
  isSignUpMode = !isSignUpMode;
  hideAuthMessages();

  const authTerms = document.getElementById("auth-terms")!;
  if (isSignUpMode) {
    authForm.classList.remove("sign-in-mode");
    authSubmitBtn.textContent = "Sign Up";
    authToggleText.textContent = "Already have an account? ";
    authToggleLink.textContent = "Sign In";
    authName.style.display = "";
    authTerms.style.display = "block";
    authForgotLink.style.display = "none";
  } else {
    authSubmitBtn.textContent = "Sign In";
    authToggleText.textContent = "Don't have an account? ";
    authToggleLink.textContent = "Sign Up";
    authName.style.display = "none";
    authName.value = "";
    authTerms.style.display = "none";
    authForgotLink.style.display = "block";
    authForm.classList.add("sign-in-mode");
  }
});

authForgotLink.addEventListener("click", async (e) => {
  e.preventDefault();
  const email = authEmail.value.trim();
  if (!email) {
    hideAuthMessages();
    authError.textContent = "Enter your email first.";
    authError.style.display = "block";
    return;
  }
  authForgotLink.style.pointerEvents = "none";
  authForgotLink.textContent = "Sending...";
  hideAuthMessages();
  try {
    await sendMessage({ action: "resetPassword", payload: { email } });
    authSuccess.textContent = "Check your email for a reset link.";
    authSuccess.style.display = "block";
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Failed to send reset email.";
    authError.textContent = msg;
    authError.style.display = "block";
  } finally {
    authForgotLink.textContent = "Forgot password?";
    authForgotLink.style.pointerEvents = "";
  }
});

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
    showAuthError("Please enter your full name (e.g. Terry Doe).");
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
        isSignUpMode = false;
        authSubmitBtn.textContent = "Sign In";
        authToggleText.textContent = "Don't have an account? ";
        authToggleLink.textContent = "Sign Up";
        authName.style.display = "none";
        authName.value = "";
        return;
      }

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

authGoogleBtn.addEventListener("click", async () => {
  authError.style.display = "none";
  authSuccess.style.display = "none";

  // Snapshot child nodes so the SVG + label can be restored without innerHTML
  const originalChildren = Array.from(authGoogleBtn.childNodes).map((n) =>
    n.cloneNode(true),
  );
  authGoogleBtn.textContent = "Signing in...";
  authGoogleBtn.disabled = true;

  const restoreBtn = (): void => {
    authGoogleBtn.textContent = "";
    for (const node of originalChildren)
      authGoogleBtn.appendChild(node.cloneNode(true));
    authGoogleBtn.disabled = false;
  };

  try {
    const result = await sendMessage<{
      success?: boolean;
      user?: {
        id: string;
        email: string;
        display_name: string | null;
        tier: string;
      };
      error?: string;
    }>({ action: "signInWithGoogle", payload: {} });

    if (result?.error) {
      authError.textContent = result.error;
      authError.style.display = "block";
      return;
    }

    if (result?.user) {
      currentUser = result.user as typeof currentUser;
      showAuthenticatedUI(
        result.user as Parameters<typeof showAuthenticatedUI>[0],
      );
      chrome.action.setBadgeText({ text: "" });
      refreshActiveTab();
    }
  } catch (err: unknown) {
    const msg = String(err instanceof Error ? err.message : err);
    // Don't show error if user simply closed the consent popup
    if (
      !msg.includes("cancelled") &&
      !msg.includes("canceled") &&
      !msg.includes("User interaction required")
    ) {
      authError.textContent = msg;
      authError.style.display = "block";
    }
  } finally {
    restoreBtn();
  }
});

authPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    authSubmitBtn.click();
  }
});

authName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    authEmail.focus();
  }
});

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
  feedbackRoleSelect.value = "";
  feedbackRoleOther.value = "";
  feedbackRoleOther.style.display = "none";
  feedbackTextarea.value = "";
  feedbackStatusEl.style.display = "none";
  feedbackStatusEl.className = "feedback-status";
  mainContent.style.display = "none";
  feedbackDialog.style.display = "block";
});

feedbackRoleSelect.addEventListener("change", () => {
  feedbackRoleOther.style.display =
    feedbackRoleSelect.value === "Other" ? "block" : "none";
  if (feedbackRoleSelect.value !== "Other") feedbackRoleOther.value = "";
});

feedbackCancelBtn.addEventListener("click", () => {
  feedbackDialog.style.display = "none";
  mainContent.style.display = "";
});

feedbackSendBtn.addEventListener("click", async () => {
  const message = feedbackTextarea.value.trim();
  if (!message) return;

  const role =
    feedbackRoleSelect.value === "Other"
      ? feedbackRoleOther.value.trim()
      : feedbackRoleSelect.value;

  feedbackSendBtn.textContent = "Sending...";
  feedbackSendBtn.setAttribute("disabled", "");
  feedbackStatusEl.style.display = "none";

  try {
    const result = await sendMessage<{ success: boolean; error?: string }>({
      action: "sendUserFeedback",
      payload: { message, role: role || undefined },
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
