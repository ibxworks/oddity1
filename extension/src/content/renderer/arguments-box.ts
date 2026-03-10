import type { Annotation, AnnotationFeedback } from "@oddity/shared";
import { ANNOTATION_LABELS } from "@oddity/shared";
import {
  getThemeMode,
  offThemeChange,
  onThemeChange,
} from "./theme-detector.js";

// ─── Types ───

type ArgumentItem = { icon: string; text: string; sortKey: string };

// ─── State ───

let hostEl: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let containerEl: HTMLDivElement | null = null;
let closeBtnEl: HTMLButtonElement | null = null;
let listEl: HTMLDivElement | null = null;
let panelToggleInput: HTMLInputElement | null = null;
let panelToggleLabelEl: HTMLSpanElement | null = null;
let expanded = false;
let dimmed = false;
let manualRunCb: (() => void) | null = null;
let notEnabledPanelEl: HTMLDivElement | null = null;
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
let dashSignOutPopoverEl: HTMLDivElement | null = null;
let dashSignOutPopoverNameEl: HTMLSpanElement | null = null;
let dashSignOutPopoverEmailEl: HTMLSpanElement | null = null;
let dashSignOutPopoverPlanEl: HTMLSpanElement | null = null;
let dashUserEmail = "";
let dashUserTier = "free";

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
    if (!expanded) {
      if (dimmed) {
        toggleDimmedPanel();
      } else {
        toggle();
      }
    }
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

  // ── Panel header: "Oddity 1" + toggle ──
  const panelHeader = document.createElement("div");
  panelHeader.className = "args-panel-header";

  const mainTitle = document.createElement("span");
  mainTitle.className = "args-main-title";
  mainTitle.textContent = "Oddity 1";

  const toggleRow = document.createElement("div");
  toggleRow.className = "args-toggle-row";

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

  toggleRow.appendChild(panelToggleLabelEl);
  toggleRow.appendChild(panelToggleInput);
  toggleRow.appendChild(panelToggleSlider);
  panelHeader.appendChild(mainTitle);
  panelHeader.appendChild(toggleRow);
  panelFace.appendChild(panelHeader);

  // ── Section title ──
  const sectionTitle = document.createElement("div");
  sectionTitle.className = "args-section-title";
  sectionTitle.textContent = "Argument Box";
  panelFace.appendChild(sectionTitle);

  // ── List ──
  listEl = document.createElement("div");
  listEl.className = "args-list";
  panelFace.appendChild(listEl);
  renderList();

  // ── Copy button ──
  const copyBtnFull = document.createElement("button");
  copyBtnFull.className = "args-copy-btn-full";
  copyBtnFull.textContent = "Copy my arguments";
  copyBtnFull.addEventListener("click", (e) => {
    e.stopPropagation();
    handleCopy(copyBtnFull);
  });
  panelFace.appendChild(copyBtnFull);

  // ── Footer ──
  const footer = document.createElement("div");
  footer.className = "args-footer";

  const footerText = document.createElement("span");
  footerText.className = "args-footer-text";
  footerText.textContent = "Go to Dashboard";
  chrome.runtime.sendMessage({ action: "getAuthStatus", payload: {} }, (result) => {
    if (!result?.authenticated) {
      footerText.textContent = "Sign in";
    }
  });
  footerText.addEventListener("click", (e) => {
    e.stopPropagation();
    showDashboard();
  });

  const footerAvatar = document.createElement("div");
  footerAvatar.className = "args-footer-avatar";
  const footerAvatarImg = document.createElement("img");
  footerAvatarImg.src = chrome.runtime.getURL("Terry.png");
  footerAvatarImg.alt = "Terry";
  footerAvatarImg.className = "args-footer-avatar-img";
  footerAvatar.appendChild(footerAvatarImg);

  footer.appendChild(footerText);
  footer.appendChild(footerAvatar);
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

  shadowRoot.appendChild(containerEl);
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
  liveItems.push({ icon, text, sortKey: `live-${Date.now()}` });
  renderList();
}

export function setArgumentsBoxVisible(visible: boolean): void {
  if (!hostEl) return;
  hostEl.style.display = visible ? "" : "none";
}

export function setArgumentsBoxEnabled(enabled: boolean): void {
  if (!containerEl) return;
  containerEl.classList.toggle("oddity-enabled", enabled);
  if (panelToggleInput) panelToggleInput.checked = enabled;
  if (panelToggleLabelEl)
    panelToggleLabelEl.textContent = enabled ? "On" : "Off";
}

export function setArgumentsBoxDimmed(isDimmed: boolean): void {
  dimmed = isDimmed;
  containerEl?.classList.toggle("oddity-not-enabled", isDimmed);
}

export function setManualRunCallback(cb: () => void): void {
  manualRunCb = cb;
}

export function destroyArgumentsBox(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (closeBtnHideTimer) clearTimeout(closeBtnHideTimer);
  if (themeHandler) {
    offThemeChange(themeHandler);
    themeHandler = null;
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
  expanded = false;
  dimmed = false;
  manualRunCb = null;
  notEnabledPanelEl = null;
  canonicalItems = [];
  liveItems = [];
}

// ─── Internal ───

function toggleDimmedPanel(): void {
  expanded = !expanded;
  containerEl?.classList.toggle("expanded", expanded);
  if (!expanded) {
    if (closeBtnHideTimer) clearTimeout(closeBtnHideTimer);
    closeBtnEl?.classList.remove("hovered");
    // Remove the overlay when collapsing — re-created fresh each open
    notEnabledPanelEl?.remove();
    notEnabledPanelEl = null;
    return;
  } else if (containerEl?.matches(":hover")) {
    showCloseBtn();
  }

  // Build a fresh overlay each time (no stale state)
  const contentClip = shadowRoot?.querySelector(".args-content-clip");
  if (!contentClip) return;

  notEnabledPanelEl = document.createElement("div");
  notEnabledPanelEl.className = "args-not-enabled-overlay";

  const msg = document.createElement("div");
  msg.className = "args-not-enabled-msg";
  msg.textContent = "Oddity 1 is not enabled for this site";

  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const shortcutHint = document.createElement("div");
  shortcutHint.className = "args-not-enabled-hint";
  shortcutHint.textContent = `${isMac ? "\u2318" : "Ctrl+"}O`;

  const runBtn = document.createElement("button");
  runBtn.className = "args-run-btn";
  runBtn.textContent = "Run on this page";
  runBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (manualRunCb) {
      expanded = false;
      containerEl?.classList.remove("expanded");
      notEnabledPanelEl?.remove();
      notEnabledPanelEl = null;
      manualRunCb();
    }
  });

  notEnabledPanelEl.appendChild(msg);
  notEnabledPanelEl.appendChild(runBtn);
  notEnabledPanelEl.appendChild(shortcutHint);
  notEnabledPanelEl.addEventListener("click", (e) => e.stopPropagation());

  // Append as sibling to panelFace inside content-clip (not inside panelFace)
  contentClip.appendChild(notEnabledPanelEl);
}

function toggle(): void {
  expanded = !expanded;
  containerEl?.classList.toggle("expanded", expanded);
  if (!expanded) {
    containerEl?.classList.remove("dashboard");
    if (closeBtnHideTimer) clearTimeout(closeBtnHideTimer);
    closeBtnEl?.classList.remove("hovered");
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

function showDashboard(): void {
  containerEl?.classList.add("dashboard");
  loadDashboardData().catch(() => {});
}

function buildDashboardFace(): HTMLDivElement {
  const face = document.createElement("div");
  face.className = "args-dash-face";
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

  const avatarCircle = document.createElement("div");
  avatarCircle.className = "args-dash-avatar-circle";
  const avatarImg = document.createElement("img");
  avatarImg.src = chrome.runtime.getURL("Terry.png");
  avatarImg.alt = "Terry";
  avatarImg.style.cssText = "width:100%;height:100%;object-fit:contain;border-radius:50%;";
  avatarCircle.appendChild(avatarImg);

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

  profileSection.appendChild(avatarCircle);
  profileSection.appendChild(countArea);
  face.appendChild(profileSection);

  // ── Annotation Settings ──
  const section = document.createElement("div");
  section.className = "args-dash-section";
  const sectionTitle = document.createElement("div");
  sectionTitle.className = "args-dash-section-title";
  sectionTitle.textContent = "Annotation";
  section.appendChild(sectionTitle);

  // Density row
  const densityRow = document.createElement("div");
  densityRow.className = "args-dash-row";
  const densityLabel = document.createElement("span");
  densityLabel.className = "args-dash-label";
  densityLabel.textContent = "Density";
  const densityGroup = document.createElement("div");
  densityGroup.className = "args-dash-density-group";
  dashDensityBtns = [];
  for (const [value, label] of [["light", "Light"], ["default", "Default"], ["heavy", "Heavy"]] as [string, string][]) {
    const btn = document.createElement("button");
    btn.className = "args-dash-density-btn" + (value === "default" ? " args-dash-density-active" : "");
    btn.dataset.intensity = value;
    btn.textContent = label;
    btn.addEventListener("click", () => {
      dashDensityBtns.forEach(b => b.classList.remove("args-dash-density-active"));
      btn.classList.add("args-dash-density-active");
      chrome.storage.local.get("preferences").then((stored) => {
        const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
        chrome.storage.local.set({ preferences: { ...prefs, intensity: value } });
      });
    });
    dashDensityBtns.push(btn);
    densityGroup.appendChild(btn);
  }
  densityRow.appendChild(densityLabel);
  densityRow.appendChild(densityGroup);
  section.appendChild(densityRow);

  // Font row
  const fontRow = document.createElement("div");
  fontRow.className = "args-dash-row";
  const fontLabel = document.createElement("span");
  fontLabel.className = "args-dash-label";
  fontLabel.textContent = "Font";
  dashFontSelect = document.createElement("select");
  dashFontSelect.className = "args-dash-select";
  for (const [value, text] of [["default", "System"], ["fraunces", "Fraunces"], ["kalam", "Kalam"], ["helvetica", "Helvetica Neue"], ["arial", "Arial"], ["georgia", "Georgia"]] as [string, string][]) {
    const opt = document.createElement("option");
    opt.value = value; opt.textContent = text;
    dashFontSelect.appendChild(opt);
  }
  dashFontSelect.addEventListener("change", () => {
    const val = dashFontSelect!.value;
    chrome.storage.local.get("preferences").then((stored) => {
      const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
      chrome.storage.local.set({ preferences: { ...prefs, annotation_font: val } });
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
  for (const [value, text] of [["small", "Small"], ["default", "Medium"], ["large", "Large"]] as [string, string][]) {
    const opt = document.createElement("option");
    opt.value = value; opt.textContent = text;
    dashFontSizeSelect.appendChild(opt);
  }
  dashFontSizeSelect.addEventListener("change", () => {
    const val = dashFontSizeSelect!.value;
    chrome.storage.local.get("preferences").then((stored) => {
      const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
      chrome.storage.local.set({ preferences: { ...prefs, annotation_font_size: val } });
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
    document.dispatchEvent(new CustomEvent("oddity:exportPdf", {
      detail: { title: document.title, subtitle: "Created with Oddity 1" },
    }));
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
    chrome.runtime.sendMessage({ action: "signOut", payload: {} }).then(() => {
      if (dashSignOutPopoverEl) dashSignOutPopoverEl.style.display = "none";
      if (dashProfileNameEl) dashProfileNameEl.textContent = "Not signed in";
      if (dashProfileAvatarEl) dashProfileAvatarEl.textContent = "?";
      if (dashTierBadgeEl) dashTierBadgeEl.textContent = "FREE";
      if (dashCountEl) dashCountEl.textContent = "0";
      dashUserEmail = "";
      dashUserTier = "free";
    });
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
    const msg = prompt("Send feedback to the Oddity 1 team:");
    if (msg?.trim()) {
      chrome.runtime.sendMessage({ action: "sendUserFeedback", payload: { message: msg.trim() } });
    }
  });
  dashFooter.appendChild(settingsLink);
  dashFooter.appendChild(sep);
  dashFooter.appendChild(feedbackLink);
  face.appendChild(dashFooter);

  return face;
}

async function loadDashboardData(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get("preferences");
    const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
    const intensity = (prefs.intensity as string) ?? "default";
    dashDensityBtns.forEach(btn => {
      btn.classList.toggle("args-dash-density-active", btn.dataset.intensity === intensity);
    });
    if (dashFontSelect) dashFontSelect.value = (prefs.annotation_font as string) ?? "default";
    if (dashFontSizeSelect) dashFontSizeSelect.value = (prefs.annotation_font_size as string) ?? "default";
    const enabled = prefs.enabled !== false;
    if (dashToggleInput) dashToggleInput.checked = enabled;
    if (dashToggleLabelEl) dashToggleLabelEl.textContent = enabled ? "On" : "Off";
  } catch { /* ignore */ }

  try {
    const auth = await chrome.runtime.sendMessage({ action: "getAuthStatus", payload: {} }) as {
      authenticated: boolean;
      user: { email: string; display_name: string | null; tier: string; annotation_count: number } | null;
    };
    if (auth?.authenticated && auth.user) {
      if (dashCountEl) dashCountEl.textContent = String(auth.user.annotation_count ?? 0);
      const name = auth.user.display_name || auth.user.email || "?";
      dashUserEmail = auth.user.email || "";
      dashUserTier = auth.user.tier || "free";
      if (dashProfileNameEl) dashProfileNameEl.textContent = name;
      if (dashProfileAvatarEl) dashProfileAvatarEl.textContent = (name[0] ?? "?").toUpperCase();
      if (dashTierBadgeEl) dashTierBadgeEl.textContent = dashUserTier.toUpperCase();
      if (dashSignOutPopoverNameEl) dashSignOutPopoverNameEl.textContent = name;
      if (dashSignOutPopoverEmailEl) dashSignOutPopoverEmailEl.textContent = dashUserEmail;
      if (dashSignOutPopoverPlanEl) dashSignOutPopoverPlanEl.textContent = dashUserTier === "pro" ? "Pro Plan" : "Free Plan";
    } else {
      if (dashProfileNameEl) dashProfileNameEl.textContent = "Not signed in";
      if (dashProfileAvatarEl) dashProfileAvatarEl.textContent = "?";
      if (dashTierBadgeEl) dashTierBadgeEl.textContent = "FREE";
    }
  } catch { /* ignore */ }
}

function buildItems(
  annotations: Map<string, Annotation[]>,
  feedback: Map<string, AnnotationFeedback[]>,
): ArgumentItem[] {
  const items: ArgumentItem[] = [];

  for (const [, anns] of annotations) {
    for (const ann of anns) {
      if (ann.id.startsWith("manual-")) {
        const label = ANNOTATION_LABELS[ann.type] ?? ann.type;
        items.push({
          icon: "✎",
          text: `(${label}) ${ann.content.note}`,
          sortKey: ann.id,
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
          sortKey: fb.created_at,
        });
      } else if (fb.feedback_type === "thumbs_down") {
        items.push({
          icon: "✗",
          text:
            fb.reply_text || findAnnotationNote(annotations, fb.annotation_id),
          sortKey: fb.created_at,
        });
      } else if (fb.feedback_type === "reply") {
        const note = findAnnotationNote(annotations, fb.annotation_id);
        const excerpt = note.length > 60 ? note.slice(0, 57) + "..." : note;
        items.push({
          icon: "↳",
          text: `Re "${excerpt}": ${fb.reply_text ?? ""}`,
          sortKey: fb.created_at,
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

function renderList(): void {
  if (!listEl) return;

  const allItems = [...canonicalItems, ...liveItems];
  listEl.innerHTML = "";

  if (allItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "args-empty";
    empty.textContent =
      "No arguments yet. React to annotations or create your own!";
    listEl.appendChild(empty);
    return;
  }

  for (const item of allItems) {
    const row = document.createElement("div");
    row.className = "args-item";

    const bullet = document.createElement("span");
    bullet.className = "args-bullet";
    bullet.textContent = "·";

    const text = document.createElement("span");
    text.className = "args-text";
    text.textContent = item.text;

    row.appendChild(bullet);
    row.appendChild(text);
    listEl.appendChild(row);
  }
}

function handleCopy(btn: HTMLButtonElement): void {
  const allItems = [...canonicalItems, ...liveItems];
  const text = allItems.map((i) => `${i.icon} ${i.text}`).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => {
      btn.textContent = orig;
    }, 1500);
  });
}

// ─── CSS ───

const ARGUMENTS_BOX_CSS = `
  * { box-sizing: border-box; }

  /* ── Morphing container ── */

  .args-container {
    all: unset;
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2;
    pointer-events: auto;
    overflow: visible;
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
      box-shadow 0.3s;
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

  /* Expanded (panel) state */
  .args-container.expanded {
    width: 234px;
    height: 320px;
    border-radius: 16px;
    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.2);
    cursor: default;
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
    overflow: hidden;
    border-radius: inherit;
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
    padding: 16px 18px 0;
    flex-shrink: 0;
  }

  .args-main-title {
    font-weight: 600;
    font-size: 17px;
    color: #fff;
    letter-spacing: 0.3px;
    font-family: "Fraunces", Georgia, serif;
  }

  .args-toggle-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

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

  /* ── Section title ── */

  .args-section-title {
    font-weight: 500;
    font-size: 14px;
    color: #fff;
    padding: 12px 18px 6px;
    flex-shrink: 0;
    font-family: "Fraunces", Georgia, serif;
  }

  /* ── List ── */

  .args-list {
    flex: 1;
    padding: 0 18px;
    overflow-y: auto;
    min-height: 0;
  }

  .args-item {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    padding: 4px 0;
  }

  .args-bullet {
    flex-shrink: 0;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
    line-height: 1.5;
  }

  .args-text {
    font-family: Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.85);
    line-height: 1.5;
    word-break: break-word;
  }

  .args-empty {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
    line-height: 1.5;
    padding: 8px 0 4px;
    font-family: system-ui, -apple-system, sans-serif;
  }

  /* ── Copy button ── */

  .args-copy-btn-full {
    all: unset;
    display: block;
    margin: 12px 18px 0;
    padding: 11px 16px;
    background: #000;
    border: 1px solid #000;
    color: #fff;
    font-size: 14px;
    font-weight: 400;
    font-family: system-ui, -apple-system, sans-serif;
    text-align: center;
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.15s;
    flex-shrink: 0;
  }

  .args-copy-btn-full:hover {
    background: #222;
  }

  /* ── Footer ── */

  .args-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 10px 18px 14px;
    flex-shrink: 0;
  }

  .args-footer-text {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    font-family: "Fraunces", Georgia, serif;
    font-weight: 400;
  }

  .args-footer-text:hover {
    color: rgba(255, 255, 255, 0.9);
  }

  .args-footer-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: #fff;
    flex-shrink: 0;
  }

  .args-footer-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: contain;
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
    background: rgba(255, 255, 255, 0.25);
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
    background: rgba(255, 255, 255, 0.35);
  }

  :host([data-theme="light"]) .args-close-btn {
    color: #111111;
    background: rgba(255, 255, 255, 0.45);
  }

  :host([data-theme="light"]) .args-close-btn:hover {
    background: rgba(255, 255, 255, 0.65);
  }

  /* ── Light mode overrides ── */

  :host([data-theme="light"]) .args-container {
    background: rgba(255, 255, 255, 0.65);
  }

  :host([data-theme="light"]) .args-main-title {
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

  :host([data-theme="light"]) .args-section-title {
    color: #606060;
  }

  :host([data-theme="light"]) .args-bullet {
    color: rgba(0, 0, 0, 0.35);
  }

  :host([data-theme="light"]) .args-text {
    color: #606060;
  }

  :host([data-theme="light"]) .args-empty {
    color: rgba(0, 0, 0, 0.4);
  }

  :host([data-theme="light"]) .args-copy-btn-full {
    background: #1a1f27;
    border-color: #1a1f27;
    color: #fff;
  }

  :host([data-theme="light"]) .args-copy-btn-full:hover {
    background: #2e3440;
  }

  :host([data-theme="light"]) .args-footer-text {
    color: rgba(0, 0, 0, 0.5);
  }

  :host([data-theme="light"]) .args-footer-text:hover {
    color: rgba(0, 0, 0, 0.8);
  }

  :host([data-theme="light"]) .args-footer-avatar {
    border-color: rgba(0, 0, 0, 0.12);
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

  .args-run-btn {
    all: unset;
    display: block;
    padding: 11px 24px;
    background: #22c55e;
    color: #fff;
    font-size: 14px;
    font-weight: 500;
    font-family: system-ui, -apple-system, sans-serif;
    text-align: center;
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .args-run-btn:hover {
    background: #16a34a;
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

  /* ── Dashboard state ── */

  .args-container.dashboard {
    width: 290px;
    height: 460px;
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
    overflow-y: auto;
    color: #1a1a1a;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 13px;
    letter-spacing: -0.01em;
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

  .args-dash-avatar-circle {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: #fff;
    border: 0.5px solid #e5e7eb;
    overflow: hidden;
    flex-shrink: 0;
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
    padding: 6px 0;
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
    border-radius: 12px;
    background: #f3f4f6;
    color: #9ca3af;
  }

  .args-dash-footer {
    padding: 8px 16px 12px;
    border-top: 0.5px solid #f0f0f0;
    text-align: center;
    flex-shrink: 0;
    margin-top: auto;
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
`;
