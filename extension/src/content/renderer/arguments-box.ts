import type {
  Annotation,
  AnnotationFeedback,
  AnnotationFont,
  AnnotationFontSize,
} from "@oddity/shared";

import {
  getMarginNotesContentLeft,
  getMarginNotesContentRight,
} from "./margin-notes.js";
import {
  getThemeMode,
  offThemeChange,
  onThemeChange,
} from "./theme-detector.js";

// ─── Font / Size maps (mirrors margin-notes) ───

const FONT_MAP: Record<AnnotationFont, string> = {
  default: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  fraunces: "'Fraunces', Georgia, serif",
  kalam: "'Kalam', cursive, system-ui, sans-serif",
  helvetica: "Helvetica, 'Helvetica Neue', Arial, sans-serif",
  arial: "Arial, 'Helvetica Neue', sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
};
const SIZE_MAP: Record<AnnotationFontSize, string> = {
  small: "12px",
  default: "14px",
  large: "16px",
};

// ─── Types ───

type ArgumentItem = {
  icon: string;
  text: string; // body: user's note / reply text
  quote?: string; // header: highlighted text from page (for manual/reaction)
  sortKey: string;
  type: "reply" | "manual" | "reaction";
  replyHeader?: string;
  feedbackId?: string;
  annotationId?: string;
  annotation?: Annotation; // Full annotation object for manual type
};

// ─── State ───

let hostEl: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let outerWrapperEl: HTMLDivElement | null = null;
let toggleBarEl: HTMLDivElement | null = null;
let containerEl: HTMLDivElement | null = null;
let closeBtnEl: HTMLButtonElement | null = null;
let listEl: HTMLDivElement | null = null;
let panelToggleInput: HTMLInputElement | null = null;
let panelToggleLabelEl: HTMLSpanElement | null = null;
let expanded = false;
let dimmed = false;
let blocked = false;
let expandedCardId: string | null = null;

// Drag-to-scroll state
let listDragging = false;
let listDragStartY = 0;
let listScrollStart = 0;
let listDragDelta = 0;
let listDragMoveHandler: ((e: MouseEvent) => void) | null = null;
let listDragUpHandler: (() => void) | null = null;

let manualRunCb: (() => void) | null = null;
let notEnabledPanelEl: HTMLDivElement | null = null;
let blockedPanelEl: HTMLDivElement | null = null;
let canonicalItems: ArgumentItem[] = [];
let liveItems: ArgumentItem[] = [];
let themeHandler: ((mode: "light" | "dark") => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let closeBtnHideTimer: ReturnType<typeof setTimeout> | null = null;
let dashToggleInput: HTMLInputElement | null = null;
let dashToggleLabelEl: HTMLSpanElement | null = null;
let dashCountEl: HTMLSpanElement | null = null;
let dashProfileNameEl: HTMLSpanElement | null = null;
let dashProfileAvatarEl: HTMLSpanElement | null = null;
let dashTierBadgeEl: HTMLElement | null = null;
let dashDensityBtns: HTMLButtonElement[] = [];
let dashFontSelect: HTMLSelectElement | null = null;
let dashFontSizeSelect: HTMLSelectElement | null = null;
let dashPersonaSelect: HTMLSelectElement | null = null;
let dashPersonaAvatarImgEl: HTMLImageElement | null = null;
let dashPersonaCircleEl: HTMLDivElement | null = null;
let dashFeedbackViewEl: HTMLDivElement | null = null;
let dashFeedbackEmailEl: HTMLDivElement | null = null;
let dashFeedbackTextareaEl: HTMLTextAreaElement | null = null;
let dashFeedbackStatusEl: HTMLDivElement | null = null;
let dashFeedbackSendBtnEl: HTMLButtonElement | null = null;
let dashSignOutPopoverEl: HTMLDivElement | null = null;
let dashSignOutPopoverNameEl: HTMLSpanElement | null = null;
let dashSignOutPopoverEmailEl: HTMLSpanElement | null = null;
let dashSignOutPopoverPlanEl: HTMLSpanElement | null = null;
let dashUserEmail = "";
let dashUserTier = "free";
let dashSignInViewEl: HTMLDivElement | null = null;
let dashSignInEmailEl: HTMLInputElement | null = null;
let dashSignInPasswordEl: HTMLInputElement | null = null;
let dashSignInStatusEl: HTMLDivElement | null = null;
let dashSignInNameEl: HTMLInputElement | null = null;
let dashAuthTitleEl: HTMLDivElement | null = null;
let dashAuthSubmitBtnEl: HTMLButtonElement | null = null;
let dashAuthToggleLinkEl: HTMLSpanElement | null = null;
let dashSignInMode: "signin" | "signup" = "signup";
let dashFaceEl: HTMLDivElement | null = null;
let footerTextEl: HTMLSpanElement | null = null;
let sessionSiteEnabled = false; // set to true when user runs once or always-enables this session
let localAuthState: boolean | null = null; // cached auth state — avoids re-querying background on every toggle

// ── Button drag state ──
const BTN_DEFAULT_RIGHT = 20;
const BTN_DEFAULT_BOTTOM = 20;
let btnDragging = false;
let btnDragDelta = 0;
let btnDragStartX = 0;
let btnDragStartY = 0;
let btnCurrentRight = BTN_DEFAULT_RIGHT;
let btnCurrentBottom = BTN_DEFAULT_BOTTOM;
let btnDragMoveHandler: ((e: MouseEvent) => void) | null = null;
let btnDragUpHandler: (() => void) | null = null;

// ─── Mode Toggle Overlay (fixed, left margin) ───

let modeToggleHostEl: HTMLElement | null = null;
let modeToggleShadowRoot: ShadowRoot | null = null;
let modeToggleOverviewBtn: HTMLButtonElement | null = null;
let modeToggleDepthBtn: HTMLButtonElement | null = null;
let modeToggleResizeHandler: (() => void) | null = null;
let modeToggleThemeHandler: ((mode: "light" | "dark") => void) | null = null;

const TOGGLE_OVERLAY_WIDTH = 168; // px — approximate rendered width of the two buttons

// ─── Public API ───

export function initArgumentsBox(): void {
  if (hostEl) return;

  hostEl = document.createElement("oddity-arguments-box");
  hostEl.style.cssText =
    "position: fixed; bottom: 0; right: 0; z-index: 2147483647; pointer-events: none;";
  document.body.appendChild(hostEl);

  shadowRoot = hostEl.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = ARGUMENTS_BOX_CSS;
  shadowRoot.appendChild(style);

  // Apply stored font/size prefs immediately on init (same as margin-notes)
  chrome.storage.local.get("preferences", (result) => {
    const prefs = result["preferences"] as Record<string, unknown> | undefined;
    if (prefs) {
      updateArgumentsBoxStyle(
        prefs.annotation_font as AnnotationFont | undefined,
        prefs.annotation_font_size as AnnotationFontSize | undefined,
      );
    }
  });

  // Theme
  hostEl.dataset.theme = getThemeMode();
  themeHandler = (mode) => {
    if (hostEl) hostEl.dataset.theme = mode;
  };
  onThemeChange(themeHandler);

  // ── Morphing container (button → panel) ──
  containerEl = document.createElement("div");
  containerEl.className = "args-container";
  containerEl.addEventListener("click", () => {
    if (blocked) return;
    if (!expanded) {
      if (Math.abs(btnDragDelta) > 4) return; // suppress click after drag
      // Reset to default position before opening
      btnCurrentRight = BTN_DEFAULT_RIGHT;
      btnCurrentBottom = BTN_DEFAULT_BOTTOM;
      if (outerWrapperEl) {
        outerWrapperEl.style.right = `${BTN_DEFAULT_RIGHT}px`;
        outerWrapperEl.style.bottom = `${BTN_DEFAULT_BOTTOM}px`;
      }
      if (dimmed) {
        toggleDimmedPanel();
      } else {
        toggle();
      }
    }
  });

  // ── Button drag-to-reposition (collapsed only) ──
  containerEl.addEventListener("mousedown", (e) => {
    if (expanded) return;
    btnDragging = true;
    btnDragDelta = 0;
    // Origin: fixed for total-distance check (never updated during drag)
    const originX = e.clientX;
    const originY = e.clientY;
    // Prev: updated each frame for incremental position movement
    btnDragStartX = e.clientX;
    btnDragStartY = e.clientY;

    btnDragMoveHandler = (ev: MouseEvent) => {
      if (!btnDragging || !outerWrapperEl) return;
      // Total distance from mousedown origin — used to distinguish click vs drag
      const totalDx = ev.clientX - originX;
      const totalDy = ev.clientY - originY;
      btnDragDelta = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
      // Incremental movement for smooth repositioning
      const dx = ev.clientX - btnDragStartX;
      const dy = ev.clientY - btnDragStartY;
      btnCurrentRight -= dx;
      btnCurrentBottom -= dy;
      outerWrapperEl.style.right = `${btnCurrentRight}px`;
      outerWrapperEl.style.bottom = `${btnCurrentBottom}px`;
      btnDragStartX = ev.clientX;
      btnDragStartY = ev.clientY;
    };

    btnDragUpHandler = () => {
      btnDragging = false;
      document.removeEventListener("mousemove", btnDragMoveHandler!);
      document.removeEventListener("mouseup", btnDragUpHandler!);
    };

    document.addEventListener("mousemove", btnDragMoveHandler);
    document.addEventListener("mouseup", btnDragUpHandler);
  });

  // Button face (Terry.png, visible when collapsed)
  const buttonFace = document.createElement("div");
  buttonFace.className = "args-button-face";
  const logoImg = document.createElement("img");
  logoImg.src = chrome.runtime.getURL("Terry.png");
  logoImg.alt = "My Arguments";
  logoImg.className = "args-toggle-logo";
  buttonFace.appendChild(logoImg);
  // Content clip wrapper — clips button/panel faces during morph, sits inside container
  const contentClip = document.createElement("div");
  contentClip.className = "args-content-clip";
  contentClip.appendChild(buttonFace);

  // Panel face (visible when expanded)
  const panelFace = document.createElement("div");
  panelFace.className = "args-panel-face";
  panelFace.addEventListener("click", (e) => e.stopPropagation());

  // ── Panel header: "Argument Box" + icon buttons ──
  const panelHeader = document.createElement("div");
  panelHeader.className = "args-panel-header";

  const mainTitle = document.createElement("span");
  mainTitle.className = "args-main-title";
  mainTitle.textContent = "Argument Box";

  const headerIcons = document.createElement("div");
  headerIcons.className = "args-header-icons";

  const addBtn = document.createElement("button");
  addBtn.className = "args-header-icon-btn";
  addBtn.title = "Add";
  addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15" fill="none"><line x1="7.5" y1="2" x2="7.5" y2="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="2" y1="7.5" x2="13" y2="7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  addBtn.addEventListener("click", (e) => e.stopPropagation());

  const copyIconBtn = document.createElement("button");
  copyIconBtn.className = "args-header-icon-btn";
  copyIconBtn.title = "Copy";
  copyIconBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15" fill="none"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 5V3.5A1.5 1.5 0 0 0 8.5 2H3.5A1.5 1.5 0 0 0 2 3.5v5A1.5 1.5 0 0 0 3.5 10H5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  copyIconBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handleCopy(copyIconBtn);
  });

  const exportIconBtn = document.createElement("button");
  exportIconBtn.className = "args-header-icon-btn";
  exportIconBtn.title = "Export PDF";
  exportIconBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M7.5 2v8M4.5 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11.5v1A1.5 1.5 0 0 0 4 14h7a1.5 1.5 0 0 0 1.5-1.5v-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  exportIconBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.dispatchEvent(
      new CustomEvent("oddity:exportPdf", {
        detail: { title: document.title, subtitle: "Created with Oddity 1" },
      }),
    );
  });

  headerIcons.appendChild(addBtn);
  headerIcons.appendChild(copyIconBtn);
  headerIcons.appendChild(exportIconBtn);

  panelHeader.appendChild(mainTitle);
  panelHeader.appendChild(headerIcons);
  panelFace.appendChild(panelHeader);

  // ── Purpose section ──
  const purposeSection = document.createElement("div");
  purposeSection.className = "args-purpose-section";

  const purposeLabel = document.createElement("span");
  purposeLabel.className = "args-purpose-label";
  purposeLabel.textContent = "Purpose:";

  const purposeInput = document.createElement("textarea");
  purposeInput.className = "args-purpose-input";
  purposeInput.placeholder = "Why are you reading this?";
  purposeInput.rows = 2;
  purposeInput.addEventListener("click", (e) => e.stopPropagation());

  purposeSection.appendChild(purposeLabel);
  purposeSection.appendChild(purposeInput);
  panelFace.appendChild(purposeSection);

  // ── List ──
  listEl = document.createElement("div");
  listEl.className = "args-list";
  panelFace.appendChild(listEl);
  renderList();

  // Drag-to-scroll
  listEl.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("button, input, textarea")) return;
    listDragging = true;
    listDragDelta = 0;
    listDragStartY = e.clientY;
    listScrollStart = listEl!.scrollTop;
    listEl!.style.cursor = "grabbing";
  });

  listDragMoveHandler = (e: MouseEvent) => {
    if (!listDragging || !listEl) return;
    const delta = listDragStartY - e.clientY;
    listDragDelta = delta;
    listEl.scrollTop = listScrollStart + delta;
  };

  listDragUpHandler = () => {
    if (!listDragging || !listEl) return;
    listDragging = false;
    listEl.style.cursor = "";
    setTimeout(() => {
      listDragDelta = 0;
    }, 0);
  };

  document.addEventListener("mousemove", listDragMoveHandler);
  document.addEventListener("mouseup", listDragUpHandler);

  // ── Footer ──
  const footer = document.createElement("div");
  footer.className = "args-footer";

  const sketchBtn = document.createElement("button");
  sketchBtn.className = "args-sketch-btn";
  sketchBtn.textContent = "Sketch my Argument";
  sketchBtn.addEventListener("click", (e) => e.stopPropagation());
  footer.appendChild(sketchBtn);

  footerTextEl = document.createElement("span");
  footerTextEl.className = "args-footer-text";
  footerTextEl.textContent = "Go to Dashboard";
  chrome.runtime.sendMessage(
    { action: "getAuthStatus", payload: {} },
    (result) => {
      if (!result?.authenticated) {
        footerTextEl!.textContent = "Sign in";
      }
    },
  );
  footerTextEl.addEventListener("click", (e) => {
    e.stopPropagation();
    showDashboard();
  });
  footer.appendChild(footerTextEl);

  panelFace.appendChild(footer);

  contentClip.appendChild(panelFace);
  contentClip.appendChild(buildDashboardFace());
  containerEl.appendChild(contentClip);

  // Track mouse position to show close button only in top half
  containerEl.addEventListener("mousemove", (e) => {
    if (!expanded) return;
    const rect = containerEl!.getBoundingClientRect();
    const inTopHalf = e.clientY < rect.top + rect.height / 2;
    if (inTopHalf) {
      showCloseBtn();
    } else {
      hideCloseBtn();
    }
  });
  containerEl.addEventListener("mouseleave", () => hideCloseBtn());

  // ── Close button — slides down from top-center ──
  closeBtnEl = document.createElement("button");
  closeBtnEl.className = "args-close-btn";
  closeBtnEl.title = "Close";
  closeBtnEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  closeBtnEl.addEventListener("mouseenter", () => showCloseBtn());
  closeBtnEl.addEventListener("mouseleave", () => hideCloseBtn());
  closeBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (expanded) {
      if (dimmed) {
        toggleDimmedPanel();
      } else {
        toggle();
      }
    }
  });
  containerEl.appendChild(closeBtnEl);

  // ── Toggle bar (sits outside the panel, top-left of the outer wrapper) ──
  toggleBarEl = document.createElement("div");
  toggleBarEl.className = "args-toggle-bar";

  panelToggleLabelEl = document.createElement("span");
  panelToggleLabelEl.className = "args-enabled-label";
  panelToggleLabelEl.textContent = "On";

  panelToggleInput = document.createElement("input");
  panelToggleInput.type = "checkbox";
  panelToggleInput.className = "args-panel-toggle-input";
  panelToggleInput.id = "args-panel-toggle-chk";
  panelToggleInput.checked = true;

  const panelToggleSlider = document.createElement("label");
  panelToggleSlider.className = "args-panel-toggle-slider";
  panelToggleSlider.htmlFor = "args-panel-toggle-chk";

  panelToggleInput.addEventListener("change", (e) => {
    e.stopPropagation();
    const en = panelToggleInput!.checked;
    panelToggleLabelEl!.textContent = en ? "On" : "Off";
    chrome.storage.local.get("preferences").then((stored) => {
      const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
      chrome.storage.local.set({ preferences: { ...prefs, enabled: en } });
    });
  });

  toggleBarEl.appendChild(panelToggleLabelEl);
  toggleBarEl.appendChild(panelToggleInput);
  toggleBarEl.appendChild(panelToggleSlider);

  // ── Outer wrapper (toggle bar + container) ──
  outerWrapperEl = document.createElement("div");
  outerWrapperEl.className = "args-outer-wrapper";
  outerWrapperEl.appendChild(toggleBarEl);
  outerWrapperEl.appendChild(containerEl);

  shadowRoot.appendChild(outerWrapperEl);

  initModeToggleOverlay();

  // On init: set auth/site state without requiring user interaction
  chrome.runtime
    .sendMessage({ action: "getAuthStatus", payload: {} })
    .then(async (result: { authenticated: boolean }) => {
      if (blocked) return; // blocked domains skip auth/whitelist UI
      if (!result?.authenticated) {
        toggle();
        showDashboard();
        const stored = await chrome.storage.local.get("hadAccount");
        showAuthView(stored["hadAccount"] ? "signin" : "signup");
      } else {
        // Authenticated — mark red stroke if site not whitelisted (even if extension is off)
        const prefsStored = await chrome.storage.local.get("preferences");
        const enabledSites = (
          prefsStored["preferences"] as Record<string, unknown>
        )?.["enabled_sites"] as string[] | undefined;
        const hostname = window.location.hostname.replace(/^www\./, "");
        const siteEnabled =
          sessionSiteEnabled ||
          (Array.isArray(enabledSites) &&
            enabledSites.some(
              (s) => hostname === s || hostname.endsWith("." + s),
            ));
        if (!siteEnabled) {
          dimmed = true;
          containerEl?.classList.add("oddity-not-enabled");
        }
      }
    })
    .catch(() => {});
}

export function updateArgumentsBox(
  annotations: Map<string, Annotation[]>,
  feedback: Map<string, AnnotationFeedback[]>,
): void {
  if (!hostEl) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    canonicalItems = buildItems(annotations, feedback);
    liveItems = [];
    renderList();
  }, 150);
}

export function addLiveFeedback(icon: string, text: string): void {
  if (!hostEl) return;
  liveItems.push({
    icon,
    text,
    sortKey: `live-${Date.now()}`,
    type: "reaction",
  });
  renderList();
}

export function setArgumentsBoxVisible(visible: boolean): void {
  if (!hostEl) return;
  hostEl.style.display = visible ? "" : "none";
  if (modeToggleHostEl) modeToggleHostEl.style.display = visible ? "" : "none";
}

export function setArgumentsBoxEnabled(enabled: boolean): void {
  if (!containerEl) return;
  containerEl.classList.toggle("oddity-enabled", enabled);
  if (panelToggleInput) panelToggleInput.checked = enabled;
  if (panelToggleLabelEl)
    panelToggleLabelEl.textContent = enabled ? "On" : "Off";
  if (dashToggleInput) dashToggleInput.checked = enabled;
  if (dashToggleLabelEl) dashToggleLabelEl.textContent = enabled ? "On" : "Off";
}

export function setArgumentsBoxDimmed(isDimmed: boolean): void {
  dimmed = isDimmed;
  containerEl?.classList.toggle("oddity-not-enabled", isDimmed);
}

export function setArgumentsBoxBlocked(isBlocked: boolean): void {
  blocked = isBlocked;
  containerEl?.classList.toggle("oddity-blocked", isBlocked);
  if (isBlocked) {
    showBlockedOverlay();
  }
}

export function setManualRunCallback(cb: () => void): void {
  manualRunCb = cb;
}

export function updateArgumentsBoxStyle(
  font?: AnnotationFont,
  fontSize?: AnnotationFontSize,
): void {
  const host = shadowRoot?.host as HTMLElement;
  if (!host) return;
  host.style.setProperty("--oddity-note-font", FONT_MAP[font ?? "default"]);
  host.style.setProperty("--oddity-note-size", SIZE_MAP[fontSize ?? "default"]);
  renderList(); // re-layout since sizes changed
}

let signOutCb: (() => void) | null = null;

export function setSignOutCallback(cb: () => void): void {
  signOutCb = cb;
}

export function handleRemoteSignOut(): void {
  localAuthState = false;
  signOutCb?.();
  // Remove not-enabled overlay if present
  if (notEnabledPanelEl) {
    notEnabledPanelEl.remove();
    notEnabledPanelEl = null;
    dimmed = false;
    containerEl?.classList.remove("oddity-not-enabled");
  }
  showDashboard();
  showAuthView("signin");
}

export async function handleRemoteSignIn(user: {
  email: string;
  display_name: string | null;
  tier: string;
  annotation_count: number;
}): Promise<void> {
  localAuthState = true;
  // Hide auth overlay and update UI directly — no re-query needed (avoids service worker race)
  if (dashSignInViewEl) dashSignInViewEl.style.display = "none";
  if (footerTextEl) footerTextEl.textContent = "Go to Dashboard";
  const name = user.display_name || user.email || "?";
  dashUserEmail = user.email;
  dashUserTier = user.tier;
  if (dashCountEl) dashCountEl.textContent = String(user.annotation_count ?? 0);
  if (dashProfileNameEl) dashProfileNameEl.textContent = name;
  if (dashProfileAvatarEl)
    dashProfileAvatarEl.textContent = (name[0] ?? "?").toUpperCase();
  if (dashTierBadgeEl) dashTierBadgeEl.textContent = user.tier.toUpperCase();
  if (dashSignOutPopoverNameEl) dashSignOutPopoverNameEl.textContent = name;
  if (dashSignOutPopoverEmailEl)
    dashSignOutPopoverEmailEl.textContent = user.email;
  if (dashSignOutPopoverPlanEl)
    dashSignOutPopoverPlanEl.textContent =
      user.tier === "pro" ? "Pro Plan" : "Free Plan";
  await chrome.storage.local.set({ hadAccount: true });
  // Check site whitelist to show dashboard or not-enabled overlay
  const prefsStored = await chrome.storage.local.get("preferences");
  const enabledSites = (
    prefsStored["preferences"] as Record<string, unknown>
  )?.["enabled_sites"] as string[] | undefined;
  const hostname = window.location.hostname.replace(/^www\./, "");
  const siteEnabled =
    Array.isArray(enabledSites) &&
    enabledSites.some((s) => hostname === s || hostname.endsWith("." + s));
  if (!siteEnabled) {
    showNotEnabledOverlay();
  }
  // Load prefs (density, font, toggle state) without re-querying auth
  loadDashboardPrefs().catch(() => {});
}

export function destroyArgumentsBox(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (closeBtnHideTimer) clearTimeout(closeBtnHideTimer);
  if (themeHandler) {
    offThemeChange(themeHandler);
    themeHandler = null;
  }
  if (modeToggleResizeHandler) {
    window.removeEventListener("resize", modeToggleResizeHandler);
    modeToggleResizeHandler = null;
  }
  if (modeToggleThemeHandler) {
    offThemeChange(modeToggleThemeHandler);
    modeToggleThemeHandler = null;
  }
  document.removeEventListener(
    "oddity:layoutUpdated",
    updateModeTogglePosition,
  );
  modeToggleHostEl?.remove();
  modeToggleHostEl = null;
  modeToggleShadowRoot = null;
  modeToggleOverviewBtn = null;
  modeToggleDepthBtn = null;
  if (listDragMoveHandler) {
    document.removeEventListener("mousemove", listDragMoveHandler);
    listDragMoveHandler = null;
  }
  if (listDragUpHandler) {
    document.removeEventListener("mouseup", listDragUpHandler);
    listDragUpHandler = null;
  }
  hostEl?.remove();
  hostEl = null;
  shadowRoot = null;
  containerEl = null;
  closeBtnEl = null;
  listEl = null;
  panelToggleInput = null;
  panelToggleLabelEl = null;
  dashToggleInput = null;
  dashToggleLabelEl = null;
  dashCountEl = null;
  dashProfileNameEl = null;
  dashProfileAvatarEl = null;
  dashTierBadgeEl = null;
  dashSignOutPopoverEl = null;
  dashSignOutPopoverNameEl = null;
  dashSignOutPopoverEmailEl = null;
  dashSignOutPopoverPlanEl = null;
  dashUserEmail = "";
  dashUserTier = "free";
  dashDensityBtns = [];
  dashFontSelect = null;
  dashFontSizeSelect = null;
  dashPersonaSelect = null;
  dashPersonaAvatarImgEl = null;
  dashPersonaCircleEl = null;
  dashFeedbackViewEl = null;
  dashFeedbackEmailEl = null;
  dashFeedbackTextareaEl = null;
  dashFeedbackStatusEl = null;
  dashFeedbackSendBtnEl = null;
  expanded = false;
  dimmed = false;
  blocked = false;
  manualRunCb = null;
  notEnabledPanelEl = null;
  blockedPanelEl = null;
  canonicalItems = [];
  liveItems = [];
}

// ─── Internal ───

function showNotEnabledOverlay(): void {
  if (notEnabledPanelEl) return; // already showing
  dimmed = true;
  containerEl?.classList.add("oddity-not-enabled");
  containerEl?.classList.remove("dashboard");
  const contentClip = shadowRoot?.querySelector(".args-content-clip");
  if (!contentClip) return;

  notEnabledPanelEl = document.createElement("div");
  notEnabledPanelEl.className = "args-not-enabled-overlay";

  const msg = document.createElement("div");
  msg.className = "args-not-enabled-msg";
  msg.textContent = "Oddity 1 is not enabled for this site";

  const isMac =
    /mac/i.test(navigator.userAgent) &&
    !/iphone|ipad/i.test(navigator.userAgent);
  const shortcutHint = document.createElement("div");
  shortcutHint.className = "args-not-enabled-hint";
  shortcutHint.textContent = `${isMac ? "\u2318" : "Ctrl+"}O`;

  const btnRow = document.createElement("div");
  btnRow.className = "args-not-enabled-btn-row";

  const removeOverlay = () => {
    notEnabledPanelEl?.remove();
    notEnabledPanelEl = null;
  };

  const enableExtension = () => {
    chrome.storage.local
      .get("preferences")
      .then((stored) => {
        const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
        chrome.storage.local.set({ preferences: { ...prefs, enabled: true } });
      })
      .catch(() => {});
  };

  const runOnceBtn = document.createElement("button");
  runOnceBtn.className = "args-run-btn args-run-btn--secondary";
  runOnceBtn.textContent = "Run once";
  runOnceBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    enableExtension();
    sessionSiteEnabled = true;
    removeOverlay();
    manualRunCb?.();
  });

  const alwaysEnableBtn = document.createElement("button");
  alwaysEnableBtn.className = "args-run-btn";
  alwaysEnableBtn.textContent = "Always enable";
  alwaysEnableBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const domain = window.location.hostname.replace(/^www\./, "");
    chrome.runtime
      .sendMessage({ action: "addEnabledSite", payload: { domain } })
      .catch(() => {});
    enableExtension();
    sessionSiteEnabled = true;
    removeOverlay();
    manualRunCb?.();
  });

  btnRow.appendChild(alwaysEnableBtn);
  btnRow.appendChild(runOnceBtn);

  notEnabledPanelEl.appendChild(msg);
  notEnabledPanelEl.appendChild(btnRow);
  notEnabledPanelEl.appendChild(shortcutHint);
  notEnabledPanelEl.addEventListener("click", (e) => e.stopPropagation());
  contentClip.appendChild(notEnabledPanelEl);
}

function showBlockedOverlay(): void {
  if (blockedPanelEl) return;
  containerEl?.classList.add("oddity-blocked");
  containerEl?.classList.remove("dashboard");
  const contentClip = shadowRoot?.querySelector(".args-content-clip");
  if (!contentClip) return;

  blockedPanelEl = document.createElement("div");
  blockedPanelEl.className = "args-not-enabled-overlay";

  const msg = document.createElement("div");
  msg.className = "args-not-enabled-msg";
  msg.textContent = "Oddity 1 annotations are built into the dashboard";

  const btnRow = document.createElement("div");
  btnRow.className = "args-not-enabled-btn-row";

  const openDashBtn = document.createElement("button");
  openDashBtn.className = "args-run-btn";
  openDashBtn.textContent = "Open Dashboard";
  openDashBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    window.open("https://app.oddity1.com", "_blank");
  });

  btnRow.appendChild(openDashBtn);
  blockedPanelEl.appendChild(msg);
  blockedPanelEl.appendChild(btnRow);
  blockedPanelEl.addEventListener("click", (e) => e.stopPropagation());
  contentClip.appendChild(blockedPanelEl);

  // Auto-expand so the blocked overlay is visible
  expanded = true;
  containerEl?.classList.add("expanded");
}

function toggleDimmedPanel(): void {
  expanded = !expanded;
  containerEl?.classList.toggle("expanded", expanded);
  if (!expanded) {
    if (closeBtnHideTimer) clearTimeout(closeBtnHideTimer);
    closeBtnEl?.classList.remove("hovered");
    notEnabledPanelEl?.remove();
    notEnabledPanelEl = null;
    return;
  } else if (containerEl?.matches(":hover")) {
    showCloseBtn();
  }
  showNotEnabledOverlay();
}

function toggle(): void {
  expanded = !expanded;
  containerEl?.classList.toggle("expanded", expanded);
  toggleBarEl?.classList.toggle("visible", expanded);
  if (!expanded) {
    containerEl?.classList.remove("dashboard");
    if (dashFeedbackViewEl) dashFeedbackViewEl.style.display = "none";
    if (dashSignInViewEl) dashSignInViewEl.style.display = "none";
    if (containerEl) {
      containerEl.style.height = "";
      containerEl.style.width = "";
    }
    notEnabledPanelEl?.remove();
    notEnabledPanelEl = null;
    if (closeBtnHideTimer) clearTimeout(closeBtnHideTimer);
    closeBtnEl?.classList.remove("hovered");
  } else {
    const checkAuth = async (authenticated: boolean) => {
      if (!authenticated) {
        showDashboard();
        const stored = await chrome.storage.local.get("hadAccount");
        showAuthView(stored["hadAccount"] ? "signin" : "signup");
      } else {
        const prefsStored = await chrome.storage.local.get("preferences");
        const enabledSites = (
          prefsStored["preferences"] as Record<string, unknown>
        )?.["enabled_sites"] as string[] | undefined;
        const hostname = window.location.hostname.replace(/^www\./, "");
        const siteEnabled =
          sessionSiteEnabled ||
          (Array.isArray(enabledSites) &&
            enabledSites.some(
              (s) => hostname === s || hostname.endsWith("." + s),
            ));
        if (!siteEnabled) {
          showNotEnabledOverlay();
        }
      }
    };
    if (localAuthState !== null) {
      checkAuth(localAuthState).catch(() => {});
    } else {
      chrome.runtime
        .sendMessage({ action: "getAuthStatus", payload: {} })
        .then(async (result: { authenticated: boolean }) => {
          localAuthState = result?.authenticated ?? false;
          await checkAuth(localAuthState);
        })
        .catch(() => {});
    }
  }
}

function showCloseBtn(): void {
  if (!expanded) return;
  if (closeBtnHideTimer) {
    clearTimeout(closeBtnHideTimer);
    closeBtnHideTimer = null;
  }
  closeBtnEl?.classList.add("hovered");
}

function hideCloseBtn(): void {
  closeBtnHideTimer = setTimeout(() => {
    closeBtnEl?.classList.remove("hovered");
    closeBtnHideTimer = null;
  }, 80);
}

function fitDashboardHeight(): void {
  if (!dashFaceEl || !containerEl) return;
  // Don't override height when auth overlay is showing — it sets its own height
  if (dashSignInViewEl && dashSignInViewEl.style.display !== "none") return;
  let h = 0;
  for (const child of Array.from(dashFaceEl.children)) {
    const el = child as HTMLElement;
    // Skip absolutely-positioned overlays (e.g. sign-in view) — they don't contribute to flow height
    const pos = getComputedStyle(el).position;
    if (pos === "absolute" || pos === "fixed") continue;
    h += el.offsetHeight;
  }
  if (h > 0) containerEl.style.height = `${h}px`;
}

function showDashboard(): void {
  containerEl?.classList.add("dashboard");
  if (containerEl) {
    containerEl.style.height = "";
    containerEl.style.width = "";
  }
  loadDashboardData()
    .catch(() => {})
    .finally(() => requestAnimationFrame(() => fitDashboardHeight()));
}

function showAuthView(mode: "signin" | "signup"): void {
  dashSignInMode = mode;
  if (dashAuthTitleEl)
    dashAuthTitleEl.textContent =
      mode === "signup" ? "Create Account" : "Sign In";
  if (dashAuthSubmitBtnEl)
    dashAuthSubmitBtnEl.textContent =
      mode === "signup" ? "Create Account" : "Sign In";
  if (dashAuthToggleLinkEl)
    dashAuthToggleLinkEl.textContent =
      mode === "signup"
        ? "Already have an account? Sign in"
        : "New user? Create account";
  if (dashSignInNameEl)
    dashSignInNameEl.style.display = mode === "signup" ? "block" : "none";
  if (dashSignInStatusEl) {
    dashSignInStatusEl.style.display = "none";
    dashSignInStatusEl.className = "args-dash-feedback-status";
  }
  if (dashSignInViewEl) {
    dashSignInViewEl.style.display = "flex";
  }
  if (containerEl) {
    containerEl.style.width = "240px";
    containerEl.style.height = mode === "signup" ? "280px" : "240px";
  }
}

function buildDashboardFace(): HTMLDivElement {
  const face = document.createElement("div");
  face.className = "args-dash-face";
  dashFaceEl = face;
  face.addEventListener("click", (e) => e.stopPropagation());

  // ── Header ──
  const header = document.createElement("div");
  header.className = "args-dash-header";

  const backBtn = document.createElement("button");
  backBtn.className = "args-dash-back";
  backBtn.textContent = "←";
  backBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    containerEl?.classList.remove("dashboard");
    if (dashFeedbackViewEl) dashFeedbackViewEl.style.display = "none";
    if (containerEl) {
      containerEl.style.height = "";
      containerEl.style.width = "";
    }
  });

  const logo = document.createElement("span");
  logo.className = "args-dash-logo";
  logo.textContent = "Oddity 1";

  const toggleWrap = document.createElement("div");
  toggleWrap.className = "args-dash-toggle-wrap";

  dashToggleLabelEl = document.createElement("span");
  dashToggleLabelEl.className = "args-dash-toggle-label";
  dashToggleLabelEl.textContent = "On";

  dashToggleInput = document.createElement("input");
  dashToggleInput.type = "checkbox";
  dashToggleInput.className = "args-dash-toggle-input";
  dashToggleInput.id = "args-dash-toggle-chk";
  dashToggleInput.checked = true;

  const toggleSlider = document.createElement("label");
  toggleSlider.className = "args-dash-slider";
  toggleSlider.htmlFor = "args-dash-toggle-chk";

  dashToggleInput.addEventListener("change", () => {
    const en = dashToggleInput!.checked;
    if (dashToggleLabelEl) dashToggleLabelEl.textContent = en ? "On" : "Off";
    if (panelToggleInput) panelToggleInput.checked = en;
    if (panelToggleLabelEl) panelToggleLabelEl.textContent = en ? "On" : "Off";
    chrome.storage.local.get("preferences").then((stored) => {
      const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
      chrome.storage.local.set({ preferences: { ...prefs, enabled: en } });
    });
  });

  toggleWrap.appendChild(dashToggleLabelEl);
  toggleWrap.appendChild(dashToggleInput);
  toggleWrap.appendChild(toggleSlider);
  header.appendChild(backBtn);
  header.appendChild(logo);
  header.appendChild(toggleWrap);
  face.appendChild(header);

  // ── Profile + Count ──
  const profileSection = document.createElement("div");
  profileSection.className = "args-dash-profile";

  const avatarArea = document.createElement("div");
  avatarArea.className = "args-dash-avatar-area";

  dashPersonaCircleEl = document.createElement("div");
  dashPersonaCircleEl.className = "args-dash-avatar-circle";
  dashPersonaAvatarImgEl = document.createElement("img");
  dashPersonaAvatarImgEl.src = chrome.runtime.getURL("Terry.png");
  dashPersonaAvatarImgEl.alt = "Terry";
  dashPersonaAvatarImgEl.style.cssText =
    "width:100%;height:100%;object-fit:contain;border-radius:50%;";
  dashPersonaCircleEl.appendChild(dashPersonaAvatarImgEl);

  dashPersonaSelect = document.createElement("select");
  dashPersonaSelect.className = "args-dash-persona-select";
  for (const name of ["Terry", "Jerry"]) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    dashPersonaSelect.appendChild(opt);
  }
  dashPersonaSelect.addEventListener("change", () => {
    const name = dashPersonaSelect!.value;
    if (dashPersonaAvatarImgEl) {
      dashPersonaAvatarImgEl.src = chrome.runtime.getURL(`${name}.png`);
      dashPersonaAvatarImgEl.alt = name;
    }
    if (dashPersonaCircleEl)
      dashPersonaCircleEl.style.background =
        name === "Jerry" ? "#FDCB24" : "#fff";
    chrome.storage.local.get("preferences").then((stored) => {
      const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
      chrome.storage.local.set({ preferences: { ...prefs, persona: name } });
    });
  });

  avatarArea.appendChild(dashPersonaCircleEl);
  avatarArea.appendChild(dashPersonaSelect);

  const countArea = document.createElement("div");
  countArea.className = "args-dash-count-area";
  dashCountEl = document.createElement("span");
  dashCountEl.className = "args-dash-count-num";
  dashCountEl.textContent = "0";
  const countLabel = document.createElement("span");
  countLabel.className = "args-dash-count-label";
  countLabel.textContent = " annotations created with Oddity 1";
  countArea.appendChild(dashCountEl);
  countArea.appendChild(countLabel);

  profileSection.appendChild(avatarArea);
  profileSection.appendChild(countArea);
  face.appendChild(profileSection);

  // ── Annotation Settings ──
  const section = document.createElement("div");
  section.className = "args-dash-section";
  const sectionTitle = document.createElement("div");
  sectionTitle.className = "args-dash-section-title";
  sectionTitle.textContent = "Annotation";
  section.appendChild(sectionTitle);

  // Personality row (replaces density — only relevant for Depth mode)
  const personalityRow = document.createElement("div");
  personalityRow.className = "args-dash-row";
  const personalityLabel = document.createElement("span");
  personalityLabel.className = "args-dash-label";
  personalityLabel.textContent = "Personality";
  const personalityGroup = document.createElement("div");
  personalityGroup.className = "args-dash-density-group";
  dashDensityBtns = [];
  for (const [value, label] of [
    ["terry", "Terry"],
    ["jerry", "Jerry"],
    ["sally", "Sally"],
  ] as [string, string][]) {
    const btn = document.createElement("button");
    btn.className =
      "args-dash-density-btn" +
      (value === "terry" ? " args-dash-density-active" : "");
    btn.dataset.intensity = value;
    btn.textContent = label;
    btn.addEventListener("click", () => {
      dashDensityBtns.forEach((b) =>
        b.classList.remove("args-dash-density-active"),
      );
      btn.classList.add("args-dash-density-active");
      chrome.storage.local.get("preferences").then((stored) => {
        const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
        chrome.storage.local.set({
          preferences: { ...prefs, depth_personality: value },
        });
      });
    });
    dashDensityBtns.push(btn);
    personalityGroup.appendChild(btn);
  }
  personalityRow.appendChild(personalityLabel);
  personalityRow.appendChild(personalityGroup);
  section.appendChild(personalityRow);

  // Font row
  const fontRow = document.createElement("div");
  fontRow.className = "args-dash-row";
  const fontLabel = document.createElement("span");
  fontLabel.className = "args-dash-label";
  fontLabel.textContent = "Font";
  dashFontSelect = document.createElement("select");
  dashFontSelect.className = "args-dash-select";
  for (const [value, text] of [
    ["default", "System"],
    ["fraunces", "Fraunces"],
    ["kalam", "Kalam"],
    ["helvetica", "Helvetica Neue"],
    ["arial", "Arial"],
    ["georgia", "Georgia"],
  ] as [string, string][]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    dashFontSelect.appendChild(opt);
  }
  dashFontSelect.addEventListener("change", () => {
    const val = dashFontSelect!.value;
    chrome.storage.local.get("preferences").then((stored) => {
      const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
      chrome.storage.local.set({
        preferences: { ...prefs, annotation_font: val },
      });
    });
  });
  fontRow.appendChild(fontLabel);
  fontRow.appendChild(dashFontSelect);
  section.appendChild(fontRow);

  // Size row
  const sizeRow = document.createElement("div");
  sizeRow.className = "args-dash-row";
  const sizeLabel = document.createElement("span");
  sizeLabel.className = "args-dash-label";
  sizeLabel.textContent = "Size";
  dashFontSizeSelect = document.createElement("select");
  dashFontSizeSelect.className = "args-dash-select";
  for (const [value, text] of [
    ["small", "Small"],
    ["default", "Medium"],
    ["large", "Large"],
  ] as [string, string][]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    dashFontSizeSelect.appendChild(opt);
  }
  dashFontSizeSelect.addEventListener("change", () => {
    const val = dashFontSizeSelect!.value;
    chrome.storage.local.get("preferences").then((stored) => {
      const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
      chrome.storage.local.set({
        preferences: { ...prefs, annotation_font_size: val },
      });
    });
  });
  sizeRow.appendChild(sizeLabel);
  sizeRow.appendChild(dashFontSizeSelect);
  section.appendChild(sizeRow);
  face.appendChild(section);

  // ── Export PDF ──
  const exportSection = document.createElement("div");
  exportSection.className = "args-dash-export-section";
  const exportBtn = document.createElement("button");
  exportBtn.className = "args-dash-export-btn";
  exportBtn.textContent = "Export PDF";
  exportBtn.addEventListener("click", () => {
    document.dispatchEvent(
      new CustomEvent("oddity:exportPdf", {
        detail: { title: document.title, subtitle: "Created with Oddity 1" },
      }),
    );
  });
  exportSection.appendChild(exportBtn);
  face.appendChild(exportSection);

  // ── Auth bar ──
  const authBar = document.createElement("div");
  authBar.className = "args-dash-auth-bar";
  authBar.style.position = "relative";

  const profileBtnEl = document.createElement("div");
  profileBtnEl.className = "args-dash-profile-btn";
  profileBtnEl.style.cursor = "pointer";
  dashProfileAvatarEl = document.createElement("span");
  dashProfileAvatarEl.className = "args-dash-profile-avatar";
  dashProfileAvatarEl.textContent = "?";
  dashProfileNameEl = document.createElement("span");
  dashProfileNameEl.className = "args-dash-profile-name";
  dashProfileNameEl.textContent = "Loading...";
  profileBtnEl.appendChild(dashProfileAvatarEl);
  profileBtnEl.appendChild(dashProfileNameEl);
  dashTierBadgeEl = document.createElement("span");
  dashTierBadgeEl.className = "args-dash-tier-badge";
  dashTierBadgeEl.textContent = "FREE";

  // ── Sign-out popover ──
  dashSignOutPopoverEl = document.createElement("div");
  dashSignOutPopoverEl.className = "args-dash-signout-popover";
  dashSignOutPopoverEl.style.display = "none";

  dashSignOutPopoverNameEl = document.createElement("span");
  dashSignOutPopoverNameEl.className = "args-dash-signout-name";
  dashSignOutPopoverEmailEl = document.createElement("span");
  dashSignOutPopoverEmailEl.className = "args-dash-signout-email";
  dashSignOutPopoverPlanEl = document.createElement("span");
  dashSignOutPopoverPlanEl.className = "args-dash-signout-plan";

  const popoverDivider = document.createElement("div");
  popoverDivider.className = "args-dash-signout-divider";

  const signOutBtn = document.createElement("button");
  signOutBtn.className = "args-dash-signout-btn";
  signOutBtn.textContent = "Sign out";
  signOutBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Clean up UI immediately — don't wait for background response
    if (dashSignOutPopoverEl) dashSignOutPopoverEl.style.display = "none";
    if (dashProfileNameEl) dashProfileNameEl.textContent = "Not signed in";
    if (dashProfileAvatarEl) dashProfileAvatarEl.textContent = "?";
    if (dashTierBadgeEl) dashTierBadgeEl.textContent = "FREE";
    if (dashCountEl) dashCountEl.textContent = "0";
    dashUserEmail = "";
    dashUserTier = "free";
    if (dashSignInEmailEl) dashSignInEmailEl.value = "";
    if (dashSignInPasswordEl) dashSignInPasswordEl.value = "";
    if (dashSignInNameEl) dashSignInNameEl.value = "";
    localAuthState = false;
    showAuthView("signin");
    signOutCb?.();
    // Best-effort backend sign-out
    chrome.runtime
      .sendMessage({ action: "signOut", payload: {} })
      .catch(() => {});
  });

  dashSignOutPopoverEl.appendChild(dashSignOutPopoverNameEl);
  dashSignOutPopoverEl.appendChild(dashSignOutPopoverEmailEl);
  dashSignOutPopoverEl.appendChild(dashSignOutPopoverPlanEl);
  dashSignOutPopoverEl.appendChild(popoverDivider);
  dashSignOutPopoverEl.appendChild(signOutBtn);

  // Toggle popover on profile click; close on outside click
  profileBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!dashSignOutPopoverEl) return;
    const isOpen = dashSignOutPopoverEl.style.display !== "none";
    dashSignOutPopoverEl.style.display = isOpen ? "none" : "flex";
  });
  dashSignOutPopoverEl.addEventListener("click", (e) => e.stopPropagation());

  authBar.appendChild(dashSignOutPopoverEl);
  authBar.appendChild(profileBtnEl);
  authBar.appendChild(dashTierBadgeEl);
  face.appendChild(authBar);

  // ── Footer ──
  const dashFooter = document.createElement("div");
  dashFooter.className = "args-dash-footer";
  const settingsLink = document.createElement("span");
  settingsLink.className = "args-dash-footer-link";
  settingsLink.textContent = "Settings";
  settingsLink.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions", payload: {} });
  });
  const sep = document.createElement("span");
  sep.className = "args-dash-footer-sep";
  sep.textContent = "·";
  const feedbackLink = document.createElement("span");
  feedbackLink.className = "args-dash-footer-link";
  feedbackLink.textContent = "Send Feedback";
  feedbackLink.addEventListener("click", () => {
    if (
      !dashFeedbackViewEl ||
      !dashFeedbackEmailEl ||
      !dashFeedbackTextareaEl ||
      !dashFeedbackStatusEl
    )
      return;
    dashFeedbackEmailEl.textContent = dashUserEmail;
    dashFeedbackTextareaEl.value = "";
    dashFeedbackStatusEl.style.display = "none";
    dashFeedbackStatusEl.className = "args-dash-feedback-status";
    dashFeedbackViewEl.style.display = "flex";
    if (containerEl) containerEl.style.height = "290px";
  });
  const sep2 = document.createElement("span");
  sep2.className = "args-dash-footer-sep";
  sep2.textContent = "·";
  const archiveLink = document.createElement("span");
  archiveLink.className = "args-dash-footer-link";
  archiveLink.textContent = "Archive";
  archiveLink.addEventListener("click", () => {
    window.open("https://app.oddity1.com/archive", "_blank");
  });
  dashFooter.appendChild(settingsLink);
  dashFooter.appendChild(sep);
  dashFooter.appendChild(archiveLink);
  dashFooter.appendChild(sep2);
  dashFooter.appendChild(feedbackLink);
  face.appendChild(dashFooter);

  // ── Feedback View (overlay) ──
  dashFeedbackViewEl = document.createElement("div");
  dashFeedbackViewEl.className = "args-dash-feedback-view";

  const fbTitle = document.createElement("div");
  fbTitle.className = "args-dash-feedback-title";
  fbTitle.textContent = "Send Feedback";

  dashFeedbackEmailEl = document.createElement("div");
  dashFeedbackEmailEl.className = "args-dash-feedback-email";

  dashFeedbackTextareaEl = document.createElement("textarea");
  dashFeedbackTextareaEl.className = "args-dash-feedback-textarea";
  dashFeedbackTextareaEl.placeholder = "Enter your feedback...";
  dashFeedbackTextareaEl.rows = 5;

  const fbBtnRow = document.createElement("div");
  fbBtnRow.className = "args-dash-feedback-btn-row";

  const fbCancelBtn = document.createElement("button");
  fbCancelBtn.className = "args-dash-feedback-cancel-btn";
  fbCancelBtn.textContent = "Cancel";
  fbCancelBtn.addEventListener("click", () => {
    if (dashFeedbackViewEl) dashFeedbackViewEl.style.display = "none";
    if (containerEl) containerEl.style.height = "";
  });

  dashFeedbackSendBtnEl = document.createElement("button");
  dashFeedbackSendBtnEl.className = "args-dash-feedback-send-btn";
  dashFeedbackSendBtnEl.textContent = "Send";
  dashFeedbackSendBtnEl.addEventListener("click", async () => {
    const message = dashFeedbackTextareaEl!.value.trim();
    if (!message) return;
    dashFeedbackSendBtnEl!.textContent = "Sending...";
    dashFeedbackSendBtnEl!.setAttribute("disabled", "");
    dashFeedbackStatusEl!.style.display = "none";
    try {
      const result = (await chrome.runtime.sendMessage({
        action: "sendUserFeedback",
        payload: { message },
      })) as { success?: boolean; error?: string };
      if (result?.error) throw new Error(result.error);
      dashFeedbackStatusEl!.textContent = "Feedback sent! Thank you.";
      dashFeedbackStatusEl!.className = "args-dash-feedback-status success";
      dashFeedbackStatusEl!.style.display = "block";
      setTimeout(() => {
        if (dashFeedbackViewEl) dashFeedbackViewEl.style.display = "none";
        if (containerEl) containerEl.style.height = "";
      }, 1500);
    } catch (err) {
      dashFeedbackStatusEl!.textContent = String(
        err instanceof Error ? err.message : "Failed to send feedback",
      );
      dashFeedbackStatusEl!.className = "args-dash-feedback-status error";
      dashFeedbackStatusEl!.style.display = "block";
    } finally {
      dashFeedbackSendBtnEl!.textContent = "Send";
      dashFeedbackSendBtnEl!.removeAttribute("disabled");
    }
  });

  dashFeedbackStatusEl = document.createElement("div");
  dashFeedbackStatusEl.className = "args-dash-feedback-status";

  fbBtnRow.appendChild(fbCancelBtn);
  fbBtnRow.appendChild(dashFeedbackSendBtnEl);
  dashFeedbackViewEl.appendChild(fbTitle);
  dashFeedbackViewEl.appendChild(dashFeedbackEmailEl);
  dashFeedbackViewEl.appendChild(dashFeedbackTextareaEl);
  dashFeedbackViewEl.appendChild(fbBtnRow);
  dashFeedbackViewEl.appendChild(dashFeedbackStatusEl);
  face.appendChild(dashFeedbackViewEl);

  // ── Auth View (sign-in / sign-up overlay) ──
  dashSignInViewEl = document.createElement("div");
  dashSignInViewEl.className = "args-dash-signin-view";

  dashAuthTitleEl = document.createElement("div");
  dashAuthTitleEl.className = "args-dash-feedback-title";
  dashAuthTitleEl.textContent = "Create Account";

  dashSignInNameEl = document.createElement("input");
  dashSignInNameEl.className = "args-dash-signin-input";
  dashSignInNameEl.type = "text";
  dashSignInNameEl.placeholder = "Name";

  dashSignInEmailEl = document.createElement("input");
  dashSignInEmailEl.className = "args-dash-signin-input";
  dashSignInEmailEl.type = "email";
  dashSignInEmailEl.placeholder = "Email";

  dashSignInPasswordEl = document.createElement("input");
  dashSignInPasswordEl.className = "args-dash-signin-input";
  dashSignInPasswordEl.type = "password";
  dashSignInPasswordEl.placeholder = "Password";

  dashSignInStatusEl = document.createElement("div");
  dashSignInStatusEl.className = "args-dash-feedback-status";

  dashAuthSubmitBtnEl = document.createElement("button");
  dashAuthSubmitBtnEl.className = "args-dash-feedback-send-btn";
  dashAuthSubmitBtnEl.style.width = "100%";
  dashAuthSubmitBtnEl.style.flex = "none";
  dashAuthSubmitBtnEl.textContent = "Create Account";
  dashAuthSubmitBtnEl.addEventListener("click", async () => {
    const email = dashSignInEmailEl!.value.trim();
    const password = dashSignInPasswordEl!.value;
    const name = dashSignInNameEl!.value.trim();
    if (!email || !password) return;
    if (dashSignInMode === "signup" && !name) return;
    const isSignUp = dashSignInMode === "signup";
    dashAuthSubmitBtnEl!.textContent = isSignUp
      ? "Creating..."
      : "Signing in...";
    dashAuthSubmitBtnEl!.setAttribute("disabled", "");
    dashSignInStatusEl!.style.display = "none";
    try {
      if (isSignUp) {
        const result = (await chrome.runtime.sendMessage({
          action: "signUp",
          payload: { email, password, displayName: name },
        })) as {
          success?: boolean;
          needsConfirmation?: boolean;
          error?: string;
        };
        if (result?.error) throw new Error(result.error);
        if (result?.needsConfirmation) {
          dashSignInStatusEl!.textContent =
            "Check your email to confirm your account.";
          dashSignInStatusEl!.className = "args-dash-feedback-status success";
          dashSignInStatusEl!.style.display = "block";
          return;
        }
      } else {
        const result = (await chrome.runtime.sendMessage({
          action: "signIn",
          payload: { email, password },
        })) as { success?: boolean; error?: string };
        if (result?.error) throw new Error(result.error);
      }
      localAuthState = true;
      await chrome.storage.local.set({ hadAccount: true });
      if (dashSignInViewEl) dashSignInViewEl.style.display = "none";
      if (containerEl) {
        containerEl.style.height = "";
        containerEl.style.width = "";
      }
      dashSignInEmailEl!.value = "";
      dashSignInPasswordEl!.value = "";
      dashSignInNameEl!.value = "";
      if (footerTextEl) footerTextEl.textContent = "Go to Dashboard";
      const prefsStored = await chrome.storage.local.get("preferences");
      const enabledSites = (
        prefsStored["preferences"] as Record<string, unknown>
      )?.["enabled_sites"] as string[] | undefined;
      const hostname = window.location.hostname.replace(/^www\./, "");
      const siteEnabled =
        Array.isArray(enabledSites) &&
        enabledSites.some((s) => hostname === s || hostname.endsWith("." + s));
      if (!siteEnabled) {
        showNotEnabledOverlay();
      } else {
        await loadDashboardData();
      }
    } catch (err) {
      dashSignInStatusEl!.textContent = String(
        err instanceof Error ? err.message : "Something went wrong",
      );
      dashSignInStatusEl!.className = "args-dash-feedback-status error";
      dashSignInStatusEl!.style.display = "block";
    } finally {
      dashAuthSubmitBtnEl!.textContent =
        dashSignInMode === "signup" ? "Create Account" : "Sign In";
      dashAuthSubmitBtnEl!.removeAttribute("disabled");
    }
  });

  dashSignInPasswordEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") dashAuthSubmitBtnEl!.click();
  });

  dashAuthToggleLinkEl = document.createElement("span");
  dashAuthToggleLinkEl.className = "args-dash-signin-toggle";
  dashAuthToggleLinkEl.textContent = "Already have an account? Sign in";
  dashAuthToggleLinkEl.addEventListener("click", () => {
    showAuthView(dashSignInMode === "signup" ? "signin" : "signup");
  });

  dashSignInViewEl.appendChild(dashAuthTitleEl);
  dashSignInViewEl.appendChild(dashSignInNameEl);
  dashSignInViewEl.appendChild(dashSignInEmailEl);
  dashSignInViewEl.appendChild(dashSignInPasswordEl);
  dashSignInViewEl.appendChild(dashAuthSubmitBtnEl);
  dashSignInViewEl.appendChild(dashSignInStatusEl);
  dashSignInViewEl.appendChild(dashAuthToggleLinkEl);
  face.appendChild(dashSignInViewEl);

  return face;
}

async function loadDashboardPrefs(): Promise<void> {
  const stored = await chrome.storage.local.get("preferences");
  const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
  const personality = (prefs.depth_personality as string) ?? "terry";
  dashDensityBtns.forEach((btn) => {
    btn.classList.toggle(
      "args-dash-density-active",
      btn.dataset.intensity === personality,
    );
  });
  if (dashFontSelect)
    dashFontSelect.value = (prefs.annotation_font as string) ?? "default";
  if (dashFontSizeSelect)
    dashFontSizeSelect.value =
      (prefs.annotation_font_size as string) ?? "default";
  updateArgumentsBoxStyle(
    prefs.annotation_font as
      | import("@oddity/shared").AnnotationFont
      | undefined,
    prefs.annotation_font_size as
      | import("@oddity/shared").AnnotationFontSize
      | undefined,
  );
  const persona = (prefs.persona as string) ?? "Terry";
  if (dashPersonaSelect) dashPersonaSelect.value = persona;
  if (dashPersonaAvatarImgEl) {
    dashPersonaAvatarImgEl.src = chrome.runtime.getURL(`${persona}.png`);
    dashPersonaAvatarImgEl.alt = persona;
  }
  if (dashPersonaCircleEl)
    dashPersonaCircleEl.style.background =
      persona === "Jerry" ? "#FDCB24" : "#fff";
  const enabled = prefs.enabled !== false;
  if (dashToggleInput) dashToggleInput.checked = enabled;
  if (dashToggleLabelEl) dashToggleLabelEl.textContent = enabled ? "On" : "Off";
}

async function loadDashboardData(): Promise<void> {
  try {
    await loadDashboardPrefs();
  } catch {
    /* ignore */
  }

  try {
    const auth = (await chrome.runtime.sendMessage({
      action: "getAuthStatus",
      payload: {},
    })) as {
      authenticated: boolean;
      user: {
        email: string;
        display_name: string | null;
        tier: string;
        annotation_count: number;
      } | null;
    };
    localAuthState = auth?.authenticated ?? false;
    if (auth?.authenticated && auth.user) {
      if (footerTextEl) footerTextEl.textContent = "Go to Dashboard";
      if (dashCountEl)
        dashCountEl.textContent = String(auth.user.annotation_count ?? 0);
      const name = auth.user.display_name || auth.user.email || "?";
      dashUserEmail = auth.user.email || "";
      dashUserTier = auth.user.tier || "free";
      if (dashProfileNameEl)
        dashProfileNameEl.textContent =
          auth.user.display_name || auth.user.email || "?";
      if (dashProfileAvatarEl)
        dashProfileAvatarEl.textContent = (name[0] ?? "?").toUpperCase();
      if (dashTierBadgeEl)
        dashTierBadgeEl.textContent = dashUserTier.toUpperCase();
      if (dashSignOutPopoverNameEl) dashSignOutPopoverNameEl.textContent = name;
      if (dashSignOutPopoverEmailEl)
        dashSignOutPopoverEmailEl.textContent = dashUserEmail;
      if (dashSignOutPopoverPlanEl)
        dashSignOutPopoverPlanEl.textContent =
          dashUserTier === "pro" ? "Pro Plan" : "Free Plan";
    } else {
      if (dashProfileNameEl) dashProfileNameEl.textContent = "Not signed in";
      if (dashProfileAvatarEl) dashProfileAvatarEl.textContent = "?";
      if (dashTierBadgeEl) dashTierBadgeEl.textContent = "FREE";
      const stored = await chrome.storage.local.get("hadAccount");
      showAuthView(stored["hadAccount"] ? "signin" : "signup");
    }
  } catch {
    /* ignore */
  }
}

function buildItems(
  annotations: Map<string, Annotation[]>,
  feedback: Map<string, AnnotationFeedback[]>,
): ArgumentItem[] {
  const items: ArgumentItem[] = [];

  for (const [, anns] of annotations) {
    for (const ann of anns) {
      if (ann.id.startsWith("manual-")) {
        items.push({
          icon: "✎",
          text: ann.content.note,
          quote: ann.anchor.exact,
          sortKey: ann.id,
          type: "manual",
          annotationId: ann.id,
          annotation: ann,
        });
      }
    }
  }

  for (const [, fbs] of feedback) {
    for (const fb of fbs) {
      if (fb.feedback_type === "thumbs_up") {
        items.push({
          icon: "✓",
          text:
            fb.reply_text || findAnnotationNote(annotations, fb.annotation_id),
          quote: findAnnotationQuote(annotations, fb.annotation_id),
          sortKey: fb.created_at,
          type: "reaction",
          feedbackId: fb.id,
          annotationId: fb.annotation_id,
        });
      } else if (fb.feedback_type === "thumbs_down") {
        items.push({
          icon: "✗",
          text:
            fb.reply_text || findAnnotationNote(annotations, fb.annotation_id),
          quote: findAnnotationQuote(annotations, fb.annotation_id),
          sortKey: fb.created_at,
          type: "reaction",
          feedbackId: fb.id,
          annotationId: fb.annotation_id,
        });
      } else if (fb.feedback_type === "reply") {
        const note = findAnnotationNote(annotations, fb.annotation_id);
        const excerpt = note.length > 40 ? note.slice(0, 37) + "\u2026" : note;
        items.push({
          icon: "↳",
          text: fb.reply_text ?? "",
          sortKey: fb.created_at,
          type: "reply",
          replyHeader: excerpt,
          feedbackId: fb.id,
          annotationId: fb.annotation_id,
        });
      }
    }
  }

  items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return items;
}

function findAnnotationNote(
  annotations: Map<string, Annotation[]>,
  annotationId: string,
): string {
  for (const [, anns] of annotations) {
    const ann = anns.find((a) => a.id === annotationId);
    if (ann) return ann.content.note;
  }
  return "(annotation)";
}

function findAnnotationQuote(
  annotations: Map<string, Annotation[]>,
  annotationId: string,
): string {
  for (const [, anns] of annotations) {
    const ann = anns.find((a) => a.id === annotationId);
    if (ann) return ann.anchor.exact;
  }
  return "";
}

function expandCard(id: string): void {
  if (expandedCardId && expandedCardId !== id) {
    const prev = listEl?.querySelector<HTMLDivElement>(
      `.arg-card[data-card-id="${CSS.escape(expandedCardId)}"]`,
    );
    prev?.classList.remove("expanded");
  }
  expandedCardId = id;
  const card = listEl?.querySelector<HTMLDivElement>(
    `.arg-card[data-card-id="${CSS.escape(id)}"]`,
  );
  card?.classList.add("expanded");
}

function collapseAllCards(): void {
  if (expandedCardId) {
    const card = listEl?.querySelector<HTMLDivElement>(
      `.arg-card[data-card-id="${CSS.escape(expandedCardId)}"]`,
    );
    card?.classList.remove("expanded");
    expandedCardId = null;
  }
}

function dimOtherCards(id: string): void {
  listEl?.querySelectorAll<HTMLDivElement>(".arg-card").forEach((c) => {
    c.classList.toggle("dimmed", c.dataset.cardId !== id);
  });
}

function undimAllCards(): void {
  listEl
    ?.querySelectorAll<HTMLDivElement>(".arg-card")
    .forEach((c) => c.classList.remove("dimmed"));
}

function renderList(): void {
  if (!listEl) return;

  const allItems = [...canonicalItems, ...liveItems];
  listEl.innerHTML = "";
  expandedCardId = null;

  if (allItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "args-empty";
    empty.textContent =
      "No arguments yet. React to annotations or create your own!";
    listEl.appendChild(empty);
    return;
  }

  for (const item of allItems) {
    const cardId = item.sortKey;
    const card = document.createElement("div");
    card.className = "arg-card";
    card.dataset.cardId = cardId;
    if (item.feedbackId) card.dataset.feedbackId = item.feedbackId;

    // Label (1 line max, like note-label)
    const header = document.createElement("div");
    header.className = "arg-card-header";
    if (item.type === "reply") {
      header.textContent = `Reply to ${item.replyHeader ?? ""}`;
    } else {
      const src = item.quote || item.text;
      const MAX = 38;
      header.textContent =
        src.length > MAX
          ? `\u201c${src.slice(0, MAX)}\u2026\u201d`
          : `\u201c${src}\u201d`;
    }

    // Body text (note-text equivalent: clamped collapsed, full on expanded)
    const body = document.createElement("div");
    body.className = "arg-card-body";
    body.textContent = item.text;

    // Expanded content — grid animation in flow, exactly like note-expanded-content
    const expandedContent = document.createElement("div");
    expandedContent.className = "note-expanded-content";

    const expandedInner = document.createElement("div");
    expandedInner.className = "note-expanded-inner";

    // Reply thread (container for reply bubbles)
    const repliesContainer = document.createElement("div");
    repliesContainer.className = "note-replies";
    expandedInner.appendChild(repliesContainer);

    // Reply input bar ("Thoughts?")
    const replyBar = document.createElement("div");
    replyBar.className = "note-reply-bar";
    const replyInput = document.createElement("input");
    replyInput.type = "text";
    replyInput.placeholder = "Thoughts?";
    replyInput.className = "note-reply-input";

    const submitArgReply = () => {
      const text = replyInput.value.trim();
      if (!text) return;

      // Add bubble immediately
      const bubble = document.createElement("div");
      bubble.className = "note-reply-bubble";
      bubble.textContent = text;
      repliesContainer.appendChild(bubble);
      repliesContainer.scrollTop = repliesContainer.scrollHeight;

      // Send to background
      if (item.annotationId) {
        const hashEl = document.querySelector(
          "[data-oddity-hash]",
        ) as HTMLElement | null;
        const contentHash = hashEl?.dataset.oddityHash ?? "";
        chrome.runtime
          .sendMessage({
            action: "saveFeedback",
            payload: {
              annotationId: item.annotationId,
              contentHash,
              url: window.location.href,
              feedbackType: "reply",
              replyText: text,
              pageTitle: document.title,
            },
          })
          .catch(() => {});
      }

      replyInput.value = "";
    };

    replyInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && replyInput.value.trim()) {
        submitArgReply();
      }
    });
    replyInput.addEventListener("click", (e) => e.stopPropagation());
    const sendBtn = document.createElement("button");
    sendBtn.className = "note-reply-send";
    sendBtn.innerHTML = "&#8593;";
    sendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      submitArgReply();
    });
    replyBar.appendChild(replyInput);
    replyBar.appendChild(sendBtn);
    expandedInner.appendChild(replyBar);

    // Feedback row (pills + icons)
    const feedbackRow = document.createElement("div");
    feedbackRow.className = "note-feedback-row";

    const pillGroup = document.createElement("div");
    pillGroup.className = "note-pill-group";
    const thumbUp = document.createElement("button");
    thumbUp.className = "note-feedback-pill";
    thumbUp.textContent = "Exactly!";
    thumbUp.addEventListener("click", (e) => e.stopPropagation());
    const thumbDown = document.createElement("button");
    thumbDown.className = "note-feedback-pill";
    thumbDown.textContent = "Hmm..?";
    thumbDown.addEventListener("click", (e) => e.stopPropagation());
    pillGroup.appendChild(thumbUp);
    pillGroup.appendChild(thumbDown);

    const iconGroup = document.createElement("div");
    iconGroup.className = "note-icon-group";
    const editBtn = document.createElement("button");
    editBtn.className = "note-icon-btn note-edit-btn";
    editBtn.title = "Edit";
    editBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!item.feedbackId && !item.annotationId) return;
      const current = body.dataset.editMode;
      if (current === "true") return;
      body.dataset.editMode = "true";
      body.style.display = "none";
      const original = item.text;
      const ta = document.createElement("textarea");
      ta.className = "note-edit-textarea";
      ta.value = original;
      ta.rows = 3;
      ta.addEventListener("keydown", (ev) => ev.stopPropagation());
      ta.addEventListener("click", (ev) => ev.stopPropagation());
      const actions = document.createElement("div");
      actions.className = "note-edit-actions";
      const saveBtn = document.createElement("button");
      saveBtn.className = "note-save-btn";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const newText = ta.value.trim();
        if (!newText) return;
        if (item.feedbackId) {
          chrome.runtime
            .sendMessage({
              action: "updateFeedback",
              payload: { feedbackId: item.feedbackId, replyText: newText },
            })
            .catch(() => {});
          item.text = newText;
          body.textContent = newText;
          document.dispatchEvent(
            new CustomEvent("oddity:feedback-edited", {
              detail: { feedbackId: item.feedbackId, replyText: newText },
            }),
          );
        } else if (item.annotationId && item.annotation) {
          const updatedAnnotation = {
            ...item.annotation,
            content: { ...item.annotation.content, note: newText },
          };
          const hashEl = document.querySelector(
            "[data-oddity-hash]",
          ) as HTMLElement | null;
          chrome.runtime
            .sendMessage({
              action: "updateAnnotation",
              payload: {
                annotationId: item.annotationId,
                annotation: updatedAnnotation,
                url: window.location.href,
                contentHash: hashEl?.dataset.oddityHash ?? "",
                pageTitle: document.title,
              },
            })
            .catch(() => {});
          item.text = newText;
          item.annotation = updatedAnnotation;
          body.textContent = newText;
          document.dispatchEvent(
            new CustomEvent("oddity:annotation-edited", {
              detail: { annotationId: item.annotationId, note: newText },
            }),
          );
        }
        delete body.dataset.editMode;
        body.style.display = "";
        ta.remove();
        actions.remove();
      });
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "note-cancel-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        delete body.dataset.editMode;
        body.style.display = "";
        ta.remove();
        actions.remove();
      });
      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);
      body.after(ta, actions);
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "note-icon-btn note-delete-btn";
    deleteBtn.title = "Delete";
    deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.feedbackId) {
        chrome.runtime
          .sendMessage({
            action: "deleteFeedback",
            payload: { feedbackId: item.feedbackId },
          })
          .catch(() => {});
        card.remove();
        document.dispatchEvent(
          new CustomEvent("oddity:feedback-deleted", {
            detail: { feedbackId: item.feedbackId },
          }),
        );
      } else if (item.annotationId) {
        const hashEl = document.querySelector(
          "[data-oddity-hash]",
        ) as HTMLElement | null;
        chrome.runtime
          .sendMessage({
            action: "deleteAnnotation",
            payload: {
              annotationId: item.annotationId,
              url: window.location.href,
              contentHash: hashEl?.dataset.oddityHash ?? "",
            },
          })
          .catch(() => {});
        card.remove();
        document.dispatchEvent(
          new CustomEvent("oddity:annotation-deleted", {
            detail: { annotationId: item.annotationId },
          }),
        );
      }
    });
    iconGroup.appendChild(editBtn);
    iconGroup.appendChild(deleteBtn);

    feedbackRow.appendChild(pillGroup);
    feedbackRow.appendChild(iconGroup);
    expandedInner.appendChild(feedbackRow);

    expandedContent.appendChild(expandedInner);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(expandedContent);

    // Click: toggle expand/collapse (suppressed if user was dragging)
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      if (Math.abs(listDragDelta) > 4) return;
      if ((e.target as HTMLElement).closest("button, input, textarea")) return;
      if (expandedCardId === cardId) {
        card.classList.remove("expanded");
        expandedCardId = null;
        undimAllCards();
      } else {
        expandCard(cardId);
        dimOtherCards(cardId);
      }
    });

    listEl.appendChild(card);
  }

  // Measure collapsed heights then fix positions — mirrors margin notes' rAF approach.
  // Cards are position:absolute so expanding one never shifts siblings.
  requestAnimationFrame(() => {
    if (!listEl) return;
    const GAP = 10;
    let top = GAP;
    let maxCardWidth = 110; // min card width
    const cards = listEl.querySelectorAll<HTMLDivElement>(".arg-card");
    for (const card of cards) {
      card.style.top = `${top}px`;
      top += card.offsetHeight + GAP;
      if (card.offsetWidth > maxCardWidth) maxCardWidth = card.offsetWidth;
    }
    listEl.style.height = `${top}px`;

    const contentRight =
      getMarginNotesContentRight() ||
      (() => {
        const hashEl = document.querySelector(
          "[data-oddity-hash]",
        ) as HTMLElement | null;
        return hashEl
          ? hashEl.getBoundingClientRect().right
          : window.innerWidth * 0.7;
      })();
    const availableWidth = window.innerWidth - contentRight - 16 - 20;
    const panelWidth = Math.min(300, Math.max(134, availableWidth));
    containerEl?.style.setProperty("--panel-width", `${panelWidth}px`);
  });
}

function handleCopy(btn: HTMLButtonElement): void {
  const allItems = [...canonicalItems, ...liveItems];
  const text = allItems.map((i) => `${i.icon} ${i.text}`).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add("copied");
    setTimeout(() => btn.classList.remove("copied"), 1500);
  });
}

// ─── Mode Toggle Overlay ───

function updateModeTogglePosition(): void {
  if (!modeToggleHostEl) return;
  const contentLeft =
    getMarginNotesContentLeft() ||
    (() => {
      const hashEl = document.querySelector(
        "[data-oddity-hash]",
      ) as HTMLElement | null;
      return hashEl
        ? hashEl.getBoundingClientRect().left
        : window.innerWidth * 0.3;
    })();
  const availableWidth = contentLeft - 16 - 8;
  if (availableWidth < 80) {
    modeToggleHostEl.style.visibility = "hidden";
    return;
  }
  modeToggleHostEl.style.visibility = "";
  const left = Math.max(8, contentLeft - 16 - TOGGLE_OVERLAY_WIDTH);
  modeToggleHostEl.style.left = `${left}px`;
}

function initModeToggleOverlay(): void {
  if (modeToggleHostEl) return;

  modeToggleHostEl = document.createElement("div");
  modeToggleHostEl.style.cssText =
    "position: fixed; bottom: 20px; z-index: 2147483646; pointer-events: auto;";
  document.body.appendChild(modeToggleHostEl);

  modeToggleShadowRoot = modeToggleHostEl.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = TOGGLE_OVERLAY_CSS;
  modeToggleShadowRoot.appendChild(style);

  // Theme
  modeToggleHostEl.dataset.theme = getThemeMode();
  modeToggleThemeHandler = (mode) => {
    if (modeToggleHostEl) modeToggleHostEl.dataset.theme = mode;
  };
  onThemeChange(modeToggleThemeHandler);

  const toggleEl = document.createElement("div");
  toggleEl.className = "mode-toggle";

  modeToggleOverviewBtn = document.createElement("button");
  modeToggleOverviewBtn.className = "mode-btn mode-active";
  modeToggleOverviewBtn.textContent = "Overview";
  modeToggleOverviewBtn.dataset.mode = "overview";

  modeToggleDepthBtn = document.createElement("button");
  modeToggleDepthBtn.className = "mode-btn";
  modeToggleDepthBtn.textContent = "Depth";
  modeToggleDepthBtn.dataset.mode = "depth";

  function handleModeClick(e: MouseEvent): void {
    e.stopPropagation();
    const target = e.currentTarget as HTMLButtonElement;
    const mode = target.dataset.mode as "overview" | "depth";
    modeToggleOverviewBtn!.classList.toggle("mode-active", mode === "overview");
    modeToggleDepthBtn!.classList.toggle("mode-active", mode === "depth");
    document.dispatchEvent(
      new CustomEvent("oddity:modeChange", { detail: { mode } }),
    );
  }

  modeToggleOverviewBtn.addEventListener("click", handleModeClick);
  modeToggleDepthBtn.addEventListener("click", handleModeClick);

  toggleEl.appendChild(modeToggleOverviewBtn);
  toggleEl.appendChild(modeToggleDepthBtn);
  modeToggleShadowRoot.appendChild(toggleEl);

  // Restore stored mode
  chrome.storage.local.get("preferences", (result) => {
    const prefs = result["preferences"] as Record<string, unknown> | undefined;
    if ((prefs?.annotation_mode as string | undefined) === "depth") {
      modeToggleOverviewBtn?.classList.remove("mode-active");
      modeToggleDepthBtn?.classList.add("mode-active");
    }
  });

  // Position — update immediately, on layout changes, and on resize
  updateModeTogglePosition();
  document.addEventListener("oddity:layoutUpdated", updateModeTogglePosition);

  modeToggleResizeHandler = () => updateModeTogglePosition();
  window.addEventListener("resize", modeToggleResizeHandler, { passive: true });
}

// ─── CSS ───

const TOGGLE_OVERLAY_CSS = `
  :host { display: block; }
  * { box-sizing: border-box; }

  .mode-toggle {
    display: flex;
    gap: 0;
  }

  .mode-btn {
    all: unset;
    flex: 1;
    padding: 7px 13px;
    text-align: center;
    font-size: 13px;
    font-weight: 500;
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
    color: #888;
    background: transparent;
    border: 1px solid #333;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
  }

  .mode-btn:first-child { border-radius: 6px 0 0 6px; border-right: none; }
  .mode-btn:last-child  { border-radius: 0 6px 6px 0; }

  .mode-active {
    background: #363636;
    color: #fff;
    border-color: #363636;
  }

  .mode-btn:hover:not(.mode-active) {
    background: rgba(255, 255, 255, 0.05);
    color: #ccc;
  }

  :host([data-theme="light"]) .mode-btn          { color: #999; border-color: #ddd; }
  :host([data-theme="light"]) .mode-active       { background: #333; color: #fff; border-color: #333; }
  :host([data-theme="light"]) .mode-btn:hover:not(.mode-active) { background: #f5f5f5; color: #666; }
`;

const ARGUMENTS_BOX_CSS = `
  :host {
    --oddity-note-font: 'Inter', system-ui, -apple-system, sans-serif;
    --oddity-note-size: 11.5px;
  }

  * { box-sizing: border-box; }

  /* ── Outer wrapper (positions toggle + container together) ── */

  .args-outer-wrapper {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0;
    pointer-events: none;
  }

  /* ── Toggle bar (top-left, outside the panel) ── */

  .args-toggle-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    pointer-events: auto;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
    align-self: flex-start;
    margin-bottom: -28px;
  }

  .args-toggle-bar.visible {
    opacity: 1;
    pointer-events: auto;
  }

  .args-outer-wrapper:has(.args-container.dashboard) .args-toggle-bar {
    opacity: 0;
    pointer-events: none;
  }

  /* ── Morphing container ── */

  .args-container {
    all: unset;
    display: block;
    pointer-events: auto;
    overflow: visible;
    position: relative;
    background: rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    cursor: pointer;

    /* Collapsed (button) state */
    width: 56px;
    height: 56px;
    border-radius: 50%;
    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.2);

    transition:
      width 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      height 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      border-radius 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      transform 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      box-shadow 0.3s;
  }

  .args-container.expanded::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    z-index: 0;
    pointer-events: none;
  }

  .args-container:not(.expanded):hover {
    transform: scale(1.08);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.2);
    transition:
      transform 0.15s,
      box-shadow 0.15s,
      width 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      height 0.4s cubic-bezier(0.4, 0, 0.2, 1),
      border-radius 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .args-container.oddity-enabled {
    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.2), 0 0 0 2.5px #4ade80;
  }


  /* Expanded (panel) state — blur moves to ::after so child cards blur independently */
  .args-container.expanded {
    width: var(--panel-width, 300px);
    height: calc(100vh - 90px + 32px);
    border-radius: 16px;
    box-shadow: none;
    border: 2px solid rgba(231, 231, 231, 0.5);
    cursor: default;
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    transform: translateY(32px);
  }

  /* ── Transparent hover buffer (20px around panel when expanded) ── */

  .args-container.expanded::before {
    content: '';
    position: absolute;
    inset: -20px;
    border-radius: 36px; /* slightly larger than panel's 16px */
    pointer-events: auto;
    z-index: -1;
  }

  /* ── Content clip (clips faces during morph) ── */

  .args-content-clip {
    position: absolute;
    inset: 0;
    overflow: clip; /* clip (not hidden) preserves backdrop-filter on children */
    border-radius: inherit;
    z-index: 1; /* above ::after panel blur layer */
  }

  /* ── Button face ── */

  .args-button-face {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 1;
    transition: opacity 0.15s ease;
    pointer-events: none;
    background: #fff;
    border-radius: inherit;
    cursor: grab;
  }

  .args-container.expanded .args-button-face {
    opacity: 0;
    transition: opacity 0.1s ease;
  }

  .args-toggle-logo {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /* ── Panel face ── */

  .args-panel-face {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
  }

  .args-container.expanded .args-panel-face {
    opacity: 1;
    pointer-events: auto;
    transition: opacity 0.2s ease 0.2s;
  }

  /* ── Panel header ── */

  .args-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 16px 0;
    flex-shrink: 0;
  }

  .args-main-title {
    font-weight: 600;
    font-size: 16px;
    color: #fff;
    letter-spacing: 0.3px;
    font-family: "Fraunces", Georgia, serif;
  }

  .args-header-icons {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .args-header-icon-btn {
    all: unset;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.7);
    transition: background 0.15s, color 0.15s;
  }

  .args-header-icon-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
  }

  .args-header-icon-btn.copied {
    color: #4ade80;
  }

  /* ── Toggle bar ── */

  .args-enabled-label {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.7);
    font-family: system-ui, -apple-system, sans-serif;
  }

  .args-panel-toggle-input {
    display: none;
  }

  .args-panel-toggle-slider {
    display: inline-block;
    position: relative;
    width: 36px;
    height: 21px;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }

  .args-panel-toggle-slider::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .args-panel-toggle-input:checked + .args-panel-toggle-slider {
    background: #22c55e;
  }

  .args-panel-toggle-input:checked + .args-panel-toggle-slider::after {
    transform: translateX(15px);
  }

  /* ── Purpose section ── */

  .args-purpose-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 16px 0;
    flex-shrink: 0;
  }

  .args-purpose-label {
    font-size: 11px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.5);
    font-family: system-ui, -apple-system, sans-serif;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .args-purpose-input {
    all: unset;
    font-size: 12.5px;
    color: rgba(255, 255, 255, 0.85);
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.5;
    resize: none;
    width: 100%;
    box-sizing: border-box;
  }

  .args-purpose-input::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  /* ── List ── */

  .args-list {
    flex: 1;
    position: relative;
    overflow-y: auto;
    overflow-x: visible;
    min-height: 0;
    cursor: grab;
    scrollbar-width: none;
  }

  .args-list::-webkit-scrollbar {
    display: none;
  }

  .args-list:active {
    cursor: grabbing;
  }

  /* ── Argument cards (mirrors .oddity-note exactly) ── */

  .arg-card {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: 260px;
    background: rgba(40, 40, 50, 0.82);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-radius: 6.5px;
    padding: 10px 12px;
    font-family: var(--oddity-note-font);
    font-size: var(--oddity-note-size);
    line-height: 1.45;
    color: #FFFFFF;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08);
    transition: box-shadow 0.2s;
    box-sizing: border-box;
    flex-shrink: 0;
  }

  .arg-card:hover {
    box-shadow: 0 3px 12px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.1);
  }

  .arg-card.expanded {
    z-index: 1;
    box-shadow: 0 3px 12px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.1);
  }

  .arg-card.dimmed {
    opacity: 0.45;
    filter: grayscale(0.6);
    pointer-events: none;
  }

  /* Header = note-label (max 1 line) */
  .arg-card-header {
    display: block;
    font-family: var(--oddity-note-font);
    font-style: normal;
    font-size: var(--oddity-note-size);
    font-weight: 900;
    letter-spacing: normal;
    color: #59709E;
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Body = note-text */
  .arg-card-body {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: break-word;
    font-family: var(--oddity-note-font);
    font-style: normal;
    font-size: var(--oddity-note-size);
    font-weight: 250;
    line-height: 1.45;
    color: #FFFFFF;
  }

  /* Body unclamps on expand — exactly like .oddity-note.expanded .note-text */
  .arg-card.expanded .arg-card-body {
    display: block;
    -webkit-line-clamp: unset;
    overflow: visible;
  }

  /* ── Expanded content (grid animation, mirrors margin notes exactly) ── */

  /* Expanded content — in-flow grid animation, mirrors margin notes exactly */
  .arg-card .note-expanded-content {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    margin-top: 0;
    transition: grid-template-rows 0.25s ease, opacity 0.2s ease, margin-top 0.2s ease;
  }

  .arg-card .note-expanded-inner {
    overflow: hidden;
    min-height: 0;
  }

  .arg-card.expanded .note-expanded-content {
    grid-template-rows: 1fr;
    opacity: 1;
    margin-top: 10px;
  }

  /* ── Reply thread ── */
  .arg-card .note-replies {
    margin-top: 6px;
  }

  .arg-card .note-reply-bubble {
    background: rgba(255,255,255,0.08);
    border-radius: 8px;
    padding: 4px 10px;
    font-size: var(--oddity-note-size);
    margin-bottom: 3px;
    word-break: break-word;
    font-family: 'Inter', system-ui, sans-serif;
    color: #FFFFFF;
  }

  .arg-card .note-reply-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    margin-bottom: 7px;
  }

  .arg-card .note-reply-input {
    all: unset;
    flex: 1;
    min-width: 0;
    background: #DFE7EF;
    border-radius: 100px;
    padding: 5px 12px;
    font-size: var(--oddity-note-size);
    font-weight: 450;
    color: #293038;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    line-height: 1;
  }

  .arg-card .note-reply-input::placeholder {
    color: #6D6D6D;
  }

  .arg-card .note-reply-send {
    all: unset;
    cursor: pointer;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #59709E;
    color: #fff;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }

  .arg-card .note-reply-send:hover {
    opacity: 0.85;
  }

  .arg-card .note-feedback-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
  }

  .arg-card .note-pill-group {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
  }

  .arg-card .note-icon-group {
    display: flex;
    gap: 2px;
  }

  .arg-card .note-feedback-pill {
    all: unset;
    cursor: pointer;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 11.5px;
    font-weight: 450;
    padding: 4px 10px;
    border-radius: 100px;
    background: #59709E;
    color: #fff;
    opacity: 1;
    transition: opacity 0.15s;
    white-space: nowrap;
  }

  .arg-card .note-feedback-pill:hover {
    opacity: 0.8;
  }

  .arg-card .note-feedback-pill.active {
    opacity: 1;
  }

  .arg-card .note-icon-btn {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    color: #FFFFFF;
    transition: color 0.15s, background 0.15s;
  }

  .arg-card .note-icon-btn:hover {
    color: #FFFFFF;
    background: rgba(255,255,255,0.08);
  }

  .arg-card .note-icon-btn.note-delete-btn:hover {
    color: #f87171;
    background: rgba(248, 113, 113, 0.12);
  }

  .arg-card .note-edit-textarea {
    all: unset;
    display: block;
    width: 100%;
    font-size: var(--oddity-note-size);
    padding: 6px 10px;
    border: 1.5px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    font-family: var(--oddity-note-font);
    resize: vertical;
    min-height: 48px;
    box-sizing: border-box;
    background: rgba(255,255,255,0.06);
    color: #FFFFFF;
    margin-top: 6px;
  }

  .arg-card .note-edit-actions {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    justify-content: flex-end;
  }

  .arg-card .note-save-btn, .arg-card .note-cancel-btn {
    all: unset;
    cursor: pointer;
    font-size: 10.5px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 100px;
    font-family: var(--oddity-note-font);
    transition: opacity 0.15s;
  }

  .arg-card .note-save-btn {
    background: #59709E;
    color: #fff;
    opacity: 0.8;
  }

  .arg-card .note-save-btn:hover { opacity: 1; }

  .arg-card .note-cancel-btn {
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.6);
  }

  .arg-card .note-cancel-btn:hover { background: rgba(255,255,255,0.12); }

  .args-empty {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
    line-height: 1.5;
    padding: 8px 16px 4px;
    font-family: system-ui, -apple-system, sans-serif;
  }

  /* ── Mode Toggle (Overview / Depth) ── */

  .args-mode-toggle {
    display: flex;
    gap: 0;
    padding: 8px 14px;
    flex-shrink: 0;
  }

  .args-mode-btn {
    all: unset;
    flex: 1;
    padding: 7px 0;
    text-align: center;
    font-size: 13px;
    font-weight: 500;
    color: #888;
    background: transparent;
    border: 1px solid #333;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .args-mode-btn:first-child {
    border-radius: 6px 0 0 6px;
    border-right: none;
  }

  .args-mode-btn:last-child {
    border-radius: 0 6px 6px 0;
  }

  .args-mode-active {
    background: #363636;
    color: #fff;
    border-color: #363636;
  }

  .args-mode-btn:hover:not(.args-mode-active) {
    background: rgba(255, 255, 255, 0.05);
    color: #ccc;
  }

  :host([data-theme="light"]) .args-mode-btn {
    color: #999;
    border-color: #ddd;
  }

  :host([data-theme="light"]) .args-mode-active {
    background: #333;
    color: #fff;
    border-color: #333;
  }

  :host([data-theme="light"]) .args-mode-btn:hover:not(.args-mode-active) {
    background: #f5f5f5;
    color: #666;
  }

  /* ── Footer ── */

  .args-footer {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 16px 14px 24px;
    flex-shrink: 0;
  }

  .args-sketch-btn {
    all: unset;
    display: block;
    padding: 13px 16px;
    background: #363636;
    color: #fff;
    font-size: 14px;
    font-weight: 500;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    text-align: center;
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.15s;
    box-sizing: border-box;
  }

  .args-sketch-btn:hover {
    background: #484848;
  }

  .args-footer-text {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-weight: 400;
    text-align: center;
    text-decoration: underline;
  }

  .args-footer-text:hover {
    color: rgba(255, 255, 255, 0.9);
  }

  /* ── Close button (top-center, slides in from above) ── */

  .args-close-btn {
    all: unset;
    position: absolute;
    top: -40px;
    left: 50%;
    /* Hidden: pushed down so it sits behind the top of the box */
    transform: translateX(-50%) translateY(32px);
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(120, 120, 120, 0.7);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
    cursor: pointer;
    pointer-events: none;
    opacity: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ffffff;
    transition: opacity 0.18s ease, transform 0.22s ease;
    z-index: 3;
  }

  .args-close-btn.hovered {
    opacity: 1;
    pointer-events: auto;
    /* Shown: slides up to 8px above the box (top:-40px + translateY(0) → bottom edge at -8px) */
    transform: translateX(-50%) translateY(0);
  }

  .args-close-btn:hover {
    background: rgba(100, 100, 100, 0.85);
  }

  :host([data-theme="light"]) .args-close-btn {
    color: #ffffff;
    background: rgba(120, 120, 120, 0.7);
  }

  :host([data-theme="light"]) .args-close-btn:hover {
    background: rgba(100, 100, 100, 0.85);
  }

  /* ── Light mode overrides ── */

  :host([data-theme="light"]) .args-container {
    background: rgba(255, 255, 255, 0.4);
  }

  :host([data-theme="light"]) .args-container.expanded {
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  :host([data-theme="light"]) .args-main-title {
    color: #1a1a1a;
  }

  :host([data-theme="light"]) .args-header-icon-btn {
    color: rgba(0, 0, 0, 0.5);
  }

  :host([data-theme="light"]) .args-header-icon-btn:hover {
    background: rgba(0, 0, 0, 0.07);
    color: #1a1a1a;
  }

  :host([data-theme="light"]) .args-enabled-label {
    color: rgba(0, 0, 0, 0.55);
  }

  :host([data-theme="light"]) .args-panel-toggle-slider {
    background: rgba(0, 0, 0, 0.18);
  }

  :host([data-theme="light"]) .args-panel-toggle-input:checked + .args-panel-toggle-slider {
    background: #22c55e;
  }

  :host([data-theme="light"]) .args-purpose-label {
    color: rgba(0, 0, 0, 0.4);
  }

  :host([data-theme="light"]) .args-purpose-input {
    color: #1a1a1a;
  }

  :host([data-theme="light"]) .args-purpose-input::placeholder {
    color: rgba(0, 0, 0, 0.25);
  }

  :host([data-theme="light"]) .arg-card {
    background: rgba(255, 255, 255, 0.82);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }

  :host([data-theme="light"]) .arg-card-header {
    color: #59709e;
  }

  :host([data-theme="light"]) .arg-card-body {
    color: #293038;
  }

  :host([data-theme="light"]) .arg-card .note-reply-bubble {
    color: #293038;
    background: rgba(0, 0, 0, 0.06);
  }

  :host([data-theme="light"]) .arg-card .note-icon-btn,
  :host([data-theme="light"]) .arg-card .note-icon-btn:hover {
    color: #293038;
  }

  :host([data-theme="light"]) .arg-card .note-edit-textarea {
    background: rgba(0,0,0,0.05);
    border-color: rgba(0,0,0,0.15);
    color: #293038;
  }

  :host([data-theme="light"]) .arg-card .note-cancel-btn {
    background: rgba(0,0,0,0.06);
    border-color: rgba(0,0,0,0.12);
    color: rgba(41,48,56,0.7);
  }

  :host([data-theme="light"]) .arg-card .note-cancel-btn:hover {
    background: rgba(0,0,0,0.1);
  }

  :host([data-theme="light"]) .args-empty {
    color: rgba(0, 0, 0, 0.4);
  }

  :host([data-theme="light"]) .args-footer-text {
    color: rgba(0, 0, 0, 0.5);
  }

  :host([data-theme="light"]) .args-footer-text:hover {
    color: rgba(0, 0, 0, 0.8);
  }

  /* ── Not-enabled state (red button) ── */

  .args-container.oddity-not-enabled:not(.expanded) {
    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.2), 0 0 0 2.5px #ef4444;
  }

  /* ── Not-enabled overlay panel ── */

  .args-not-enabled-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    gap: 16px;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-radius: inherit;
    z-index: 2;
  }

  .args-not-enabled-msg {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.8);
    text-align: center;
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.4;
  }

  .args-not-enabled-btn-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }

  .args-run-btn {
    all: unset;
    flex: 1;
    display: block;
    padding: 11px 12px;
    background: #22c55e;
    color: #fff;
    font-size: 13px;
    font-weight: 500;
    font-family: system-ui, -apple-system, sans-serif;
    text-align: center;
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.15s;
    box-sizing: border-box;
  }

  .args-run-btn:hover {
    background: #16a34a;
  }

  .args-run-btn--secondary {
    background: rgba(255, 255, 255, 0.12);
    color: rgba(255, 255, 255, 0.85);
  }

  .args-run-btn--secondary:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .args-not-enabled-hint {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
    font-family: system-ui, -apple-system, sans-serif;
  }

  :host([data-theme="light"]) .args-not-enabled-overlay {
    background: rgba(255, 255, 255, 0.9);
  }

  :host([data-theme="light"]) .args-not-enabled-msg {
    color: #606060;
  }

  :host([data-theme="light"]) .args-not-enabled-hint {
    color: rgba(0, 0, 0, 0.35);
  }

  :host([data-theme="light"]) .args-run-btn--secondary {
    background: rgba(0, 0, 0, 0.07);
    color: #3a3a36;
  }

  :host([data-theme="light"]) .args-run-btn--secondary:hover {
    background: rgba(0, 0, 0, 0.13);
  }

  /* ── Blocked state (uses same overlay styles as not-enabled) ── */

  .args-container.oddity-blocked:not(.expanded) {
    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.2), 0 0 0 2.5px #6B7280;
  }

  :host([data-theme="light"]) .args-container.dashboard {
    height: 440px;
  }

  /* ── Dashboard state ── */

  .args-container.dashboard {
    width: 290px;
    height: 440px;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    background: #fff;
  }

  .args-container.dashboard .args-panel-face {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.1s ease;
  }

  .args-container.dashboard .args-button-face {
    opacity: 0;
  }

  /* ── Dashboard face ── */

  .args-dash-face {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
    background: #fff;
    border-radius: inherit;
    overflow: hidden;
    color: #1a1a1a;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 13px;
    letter-spacing: -0.01em;
    color-scheme: light;
  }

  .args-container.dashboard .args-dash-face {
    opacity: 1;
    pointer-events: auto;
    transition: opacity 0.2s ease 0.2s;
  }

  .args-dash-header {
    display: flex;
    align-items: center;
    padding: 14px 16px;
    gap: 8px;
    flex-shrink: 0;
  }

  .args-dash-back {
    all: unset;
    cursor: pointer;
    font-size: 16px;
    color: #9ca3af;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .args-dash-back:hover { color: #1a1a1a; }

  .args-dash-logo {
    font-family: "Fraunces", Georgia, serif;
    font-size: 16px;
    font-weight: 600;
    color: #1a1a1a;
    flex: 1;
    letter-spacing: 0.3px;
  }

  .args-dash-toggle-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .args-dash-toggle-label {
    font-size: 12px;
    color: #9ca3af;
    font-weight: 500;
  }

  .args-dash-toggle-input { display: none; }

  .args-dash-slider {
    display: inline-block;
    position: relative;
    width: 36px;
    height: 21px;
    background: #d1d5db;
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }

  .args-dash-slider::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  }

  .args-dash-toggle-input:checked + .args-dash-slider { background: #22c55e; }
  .args-dash-toggle-input:checked + .args-dash-slider::after { transform: translateX(15px); }

  .args-dash-profile {
    display: flex;
    align-items: flex-start;
    padding: 0 16px 14px;
    gap: 18px;
    flex-shrink: 0;
  }

  .args-dash-avatar-area {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    flex-shrink: 0;
  }

  .args-dash-avatar-circle {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: #fff;
    border: 0.5px solid #e5e7eb;
    overflow: hidden;
    flex-shrink: 0;
  }

  .args-dash-persona-select {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    font-family: "Fraunces", Georgia, serif;
    font-size: 12px;
    font-weight: 500;
    color: #111;
    outline: none;
    appearance: auto;
    height: 20px;
    line-height: 20px;
  }

  .args-dash-count-area {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    padding-top: 10px;
  }

  .args-dash-count-num {
    font-size: 17px;
    font-weight: 500;
    color: #111;
    line-height: 1;
  }

  .args-dash-count-label {
    font-size: 11px;
    color: #9ca3af;
    margin-left: 5px;
    line-height: 1.3;
  }

  .args-dash-section {
    padding: 12px 16px;
    border-top: 0.5px solid #f0f0f0;
    flex-shrink: 0;
  }

  .args-dash-section-title {
    font-family: "Fraunces", Georgia, serif;
    font-size: 13px;
    font-weight: 600;
    color: #1a1a1a;
    margin-bottom: 12px;
  }

  .args-dash-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .args-dash-row:last-child { margin-bottom: 0; }

  .args-dash-label {
    font-size: 12px;
    color: #9ca3af;
    min-width: 46px;
    flex-shrink: 0;
  }

  .args-dash-density-group {
    display: flex;
    gap: 5px;
    flex: 1;
  }

  .args-dash-density-btn {
    all: unset;
    flex: 1;
    height: 28px;
    border: 0.5px solid #e5e7eb;
    border-radius: 20px;
    background: #fff;
    font-size: 11px;
    cursor: pointer;
    color: #6b7280;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    text-align: center;
    transition: all 0.15s;
    box-sizing: border-box;
  }

  .args-dash-density-btn:hover { background: #f9fafb; }

  .args-dash-density-active {
    background: #1a1a1a !important;
    color: #fff !important;
    border-color: #1a1a1a !important;
  }

  .args-dash-select {
    flex: 1;
    padding: 6px 24px 6px 10px;
    border: 0.5px solid #e5e7eb;
    border-radius: 20px;
    background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E") no-repeat right 10px center;
    background-size: 8px;
    appearance: none;
    -webkit-appearance: none;
    font-size: 12px;
    color: #374151;
    cursor: pointer;
    outline: none;
  }

  .args-dash-export-section {
    padding: 10px 16px 14px;
    flex-shrink: 0;
  }

  .args-dash-export-btn {
    all: unset;
    display: block;
    width: 100%;
    padding: 12px 0;
    background: #1a1a1a;
    color: #fff;
    border-radius: 28px;
    font-size: 14px;
    text-align: center;
    cursor: pointer;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    box-sizing: border-box;
    transition: opacity 0.15s;
  }

  .args-dash-export-btn:hover { opacity: 0.88; }

  .args-dash-auth-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    flex-shrink: 0;
    margin-top: auto;
  }

  .args-dash-profile-btn {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .args-dash-profile-avatar {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #1a1a1a;
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .args-dash-profile-name {
    font-size: 12px;
    font-weight: 500;
    color: #374151;
  }

  .args-dash-tier-badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 3px 8px;
    border-radius: 6.5px;
    background: #f3f4f6;
    color: #9ca3af;
  }

  .args-dash-footer {
    padding: 14px 16px 22px;
    border-top: 0.5px solid #f0f0f0;
    text-align: center;
    flex-shrink: 0;
  }

  .args-dash-footer-link {
    font-size: 11px;
    color: #9ca3af;
    cursor: pointer;
    font-weight: 300;
  }

  .args-dash-footer-link:hover { color: #6b7280; }

  .args-dash-footer-sep {
    color: #d1d5db;
    margin: 0 4px;
    font-size: 11px;
  }

  /* ── Sign-out popover ── */

  .args-dash-signout-popover {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    right: 0;
    background: #fff;
    border-radius: 14px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.14), 0 1px 4px rgba(0,0,0,0.08);
    border: 0.5px solid #e5e7eb;
    padding: 14px 16px 10px;
    flex-direction: column;
    gap: 3px;
    z-index: 10;
  }

  .args-dash-signout-name {
    font-size: 13px;
    font-weight: 600;
    color: #111;
    line-height: 1.4;
  }

  .args-dash-signout-email {
    font-size: 12px;
    color: #6b7280;
    line-height: 1.4;
  }

  .args-dash-signout-plan {
    font-size: 12px;
    color: #9ca3af;
    margin-top: 2px;
    line-height: 1.4;
  }

  .args-dash-signout-divider {
    height: 0.5px;
    background: #f0f0f0;
    margin: 10px 0 8px;
  }

  .args-dash-signout-btn {
    all: unset;
    display: block;
    width: 100%;
    padding: 10px 0;
    text-align: center;
    font-size: 14px;
    color: #ef4444;
    font-weight: 400;
    cursor: pointer;
    border: 0.5px solid #fca5a5;
    border-radius: 100px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    box-sizing: border-box;
    transition: background 0.15s;
  }

  .args-dash-signout-btn:hover {
    background: #fff5f5;
  }

  /* ── Feedback View ── */

  .args-dash-feedback-view {
    position: absolute;
    inset: 0;
    background: #fff;
    border-radius: inherit;
    z-index: 2;
    display: none;
    flex-direction: column;
    padding: 18px 16px;
  }

  .args-dash-feedback-title {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 10px;
    color: #111;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  }

  .args-dash-feedback-email {
    font-size: 12px;
    color: #8a8a80;
    margin-bottom: 10px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  }

  .args-dash-feedback-textarea {
    display: block;
    width: 100%;
    padding: 9px 12px;
    border: 0.5px solid #e8e8e2;
    border-radius: 6.5px;
    font-size: 13px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    outline: none;
    transition: border-color 0.15s;
    background: #fff;
    color: #111;
    resize: vertical;
    min-height: 80px;
    box-sizing: border-box;
  }

  .args-dash-feedback-textarea:focus { border-color: #111; }

  .args-dash-feedback-btn-row {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .args-dash-feedback-cancel-btn {
    all: unset;
    flex: 1;
    display: block;
    padding: 10px 12px;
    border: 0.5px solid #e8e8e2;
    border-radius: 100px;
    background: #fff;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    color: #3a3a36;
    transition: all 0.15s;
    text-align: center;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    box-sizing: border-box;
  }

  .args-dash-feedback-cancel-btn:hover { background: #f5f4f0; }

  .args-dash-feedback-send-btn {
    all: unset;
    flex: 1;
    display: block;
    padding: 10px 12px;
    background: #111;
    color: #fff;
    border-radius: 100px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    text-align: center;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    transition: opacity 0.15s;
    box-sizing: border-box;
  }

  .args-dash-feedback-send-btn:hover { opacity: 0.9; }
  .args-dash-feedback-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .args-dash-feedback-status {
    display: none;
    text-align: center;
    padding: 8px;
    font-size: 12px;
    border-radius: 10px;
    margin-top: 8px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  }

  .args-dash-feedback-status.success { display: block; color: #16a34a; background: #f0fdf4; }
  .args-dash-feedback-status.error { display: block; color: #dc2626; background: #fef2f2; }

  .args-dash-signin-view {
    position: absolute;
    inset: 0;
    background: #fff;
    border-radius: inherit;
    z-index: 2;
    display: none;
    flex-direction: column;
    padding: 14px 12px;
    gap: 7px;
  }

  .args-dash-signin-subtitle {
    font-size: 12px;
    color: #8a8a80;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    margin-bottom: 2px;
  }

  .args-dash-signin-input {
    all: unset;
    display: block;
    width: 100%;
    padding: 7px 10px;
    border: 0.5px solid #e8e8e2;
    border-radius: 6.5px;
    font-size: 12px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #111;
    background: #fff;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }

  .args-dash-signin-input:focus { border-color: #111; }
  .args-dash-signin-input::placeholder { color: #aaa; }

  .args-dash-signin-toggle {
    font-size: 12px;
    color: #8a8a80;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    text-align: center;
    cursor: pointer;
    margin-top: 2px;
  }

  .args-dash-signin-toggle:hover { color: #111; }
`;
