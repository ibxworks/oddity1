import type {
  Annotation,
  AnnotationFeedback,
  AnnotationFont,
  AnnotationFontSize,
  AnnotationType,
} from "@oddity/shared";
import { getAnnotationColor } from "@oddity/shared";

import { getPageUrl } from "../page-url.js";
import { showNoticeToast } from "../notice-toast.js";
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
  replyHeader?: string; // truncated annotation note (for display)
  replyFullNote?: string; // full annotation note text (for copy/sketch)
  replyAnchor?: string; // anchor text of the annotation being replied to
  feedbackId?: string;
  annotationId?: string;
  annotation?: Annotation; // Full annotation object for manual type
  contentHash?: string; // region content hash for feedback API calls
  annotationType?: AnnotationType; // source annotation type for color
};

// ─── State ───

let hostEl: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let outerWrapperEl: HTMLDivElement | null = null;
let toggleBarEl: HTMLDivElement | null = null;
let containerEl: HTMLDivElement | null = null;
let topBarEl: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let panelToggleInput: HTMLInputElement | null = null;
let panelToggleLabelEl: HTMLSpanElement | null = null;
let expanded = false;
let dimmed = false;
let blocked = false;
let extensionEnabled = true;
let boxVisible = true;
let expandedCardId: string | null = null;
let layoutPending = false;
let onboardingOverlayEl: HTMLDivElement | null = null;

// Drag-to-scroll state
let listDragging = false;
let listDragStartY = 0;
let listScrollStart = 0;
let listDragDelta = 0;
let listDragMoveHandler: ((e: MouseEvent) => void) | null = null;
let listDragUpHandler: (() => void) | null = null;

let manualRunCb: (() => void) | null = null;
let inputTextProviderCb: (() => string) | null = null;
let activeTab: "notes" | "sketch" = "notes";
let tabBarEl: HTMLDivElement | null = null;
let notesTabBtn: HTMLButtonElement | null = null;
let sketchTabBtn: HTMLButtonElement | null = null;
let sketchContentEl: HTMLDivElement | null = null;
let sketchBuffer = "";
let sketchLoading = false;
let sketchBtnEl: HTMLButtonElement | null = null;
let footerEl: HTMLDivElement | null = null;
let purposeInputEl: HTMLTextAreaElement | null = null;
let notEnabledPanelEl: HTMLDivElement | null = null;
let enableBubbleEl: HTMLDivElement | null = null;
let emptyBubbleEl: HTMLDivElement | null = null;
let blockedPanelEl: HTMLDivElement | null = null;
let pdfDetected = false;
let pdfPanelEl: HTMLDivElement | null = null;
let pdfRunCb: (() => void) | null = null;
let dashCloseBtnEl: HTMLButtonElement | null = null;
let canonicalItems: ArgumentItem[] = [];
let liveItems: ArgumentItem[] = [];
const deletedFeedbackIds = new Set<string>();
const deletedAnnotationIds = new Set<string>();
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
let dashPersonaSelect: HTMLElement | null = null;
let dashPersonaAvatarImgEl: HTMLImageElement | null = null;
let bubbleLogoImgEl: HTMLImageElement | null = null;
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
let dashForgotLinkEl: HTMLSpanElement | null = null;
let dashAuthTermsEl: HTMLDivElement | null = null;
let dashSignInMode: "signin" | "signup" = "signup";
let dashFaceEl: HTMLDivElement | null = null;
let footerTextEl: HTMLSpanElement | null = null;
let sessionSiteEnabled = false;
let localAuthState: boolean | null = null; // cached auth state — avoids re-querying background on every toggle

// ── Sync bubble logo when preferences change externally (e.g. from popup) ──
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.preferences) return;
  const prefs = (changes.preferences.newValue ?? {}) as Record<string, unknown>;
  const personality = (prefs.depth_personality as string) ?? "terry";
  const display = personality.charAt(0).toUpperCase() + personality.slice(1);
  if (bubbleLogoImgEl) {
    bubbleLogoImgEl.src = chrome.runtime.getURL(`${display}.png`);
    bubbleLogoImgEl.alt = display;
  }
});

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

// ─── Mode Toggle (inside FAB outer wrapper) ───

let modeToggleWrapperEl: HTMLDivElement | null = null;
let modeToggleOverviewBtn: HTMLButtonElement | null = null;
let modeToggleDepthBtn: HTMLButtonElement | null = null;
let modeToggleSliderEl: HTMLDivElement | null = null;
let modeToggleEl: HTMLDivElement | null = null;

// ─── Public API ───

export function initArgumentsBox(): void {
  if (hostEl) return;

  hostEl = document.createElement("oddity-arguments-box");
  hostEl.style.cssText =
    "position: fixed; bottom: 0; right: 0; z-index: 2147483647; pointer-events: none; overflow: visible;";
  // Stop keyboard events from leaking to the host page (e.g. Claude's chat input)
  for (const evt of [
    "keydown",
    "keyup",
    "keypress",
    "input",
    "beforeinput",
  ] as const) {
    hostEl.addEventListener(evt, (e) => e.stopPropagation());
  }
  document.body.appendChild(hostEl);

  shadowRoot = hostEl.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = ARGUMENTS_BOX_CSS;
  shadowRoot.appendChild(style);

  // Apply stored font/size prefs and persona immediately on init
  chrome.storage.local.get("preferences", (result) => {
    const prefs = result["preferences"] as Record<string, unknown> | undefined;
    if (prefs) {
      updateArgumentsBoxStyle(
        prefs.annotation_font as AnnotationFont | undefined,
        prefs.annotation_font_size as AnnotationFontSize | undefined,
      );
      // Sync bubble logo to stored persona
      const personality = (prefs.depth_personality as string) ?? "terry";
      const display =
        personality.charAt(0).toUpperCase() + personality.slice(1);
      if (bubbleLogoImgEl) {
        bubbleLogoImgEl.src = chrome.runtime.getURL(`${display}.png`);
        bubbleLogoImgEl.alt = display;
      }
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

  // Re-layout cards after the container finishes its width transition (56px → 300px).
  // Without this, cards measured during the transition get incorrect heights.
  containerEl.addEventListener("transitionend", (e) => {
    if (e.propertyName === "width" && expanded && layoutPending) {
      scheduleLayout();
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
      syncModeTogglePosition();
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
  bubbleLogoImgEl = document.createElement("img");
  bubbleLogoImgEl.src = chrome.runtime.getURL("Terry.png");
  bubbleLogoImgEl.alt = "My Arguments";
  bubbleLogoImgEl.className = "args-toggle-logo";
  buttonFace.appendChild(bubbleLogoImgEl);
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
  addBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 19 19" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8.5" width="1.5" height="18.5" rx="0.5" fill="currentColor"/><rect x="18.5" y="8.5" width="1.5" height="18.5" rx="0.5" transform="rotate(90 18.5 8.5)" fill="currentColor"/></svg>`;
  // ── Plus-button tooltip ──
  const addTooltip = document.createElement("div");
  addTooltip.className = "add-tooltip";
  addTooltip.innerHTML = `
    <span class="add-tooltip-title">Add your thoughts</span>
    <span class="add-tooltip-desc">Highlight text on the page, then click <b>+</b> to attach your note.</span>
  `;
  addBtn.style.position = "relative";
  addBtn.appendChild(addTooltip);

  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    addTooltip.classList.toggle("visible");
  });

  // Close tooltip when clicking outside
  document.addEventListener("click", () => {
    addTooltip.classList.remove("visible");
  });

  const copyIconBtn = document.createElement("button");
  copyIconBtn.className = "args-header-icon-btn";
  copyIconBtn.title = "Copy";
  copyIconBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.4883 5.5H7.94922C6.59655 5.5 5.5 6.59655 5.5 7.94922V17.4883C5.5 18.8409 6.59655 19.9375 7.94922 19.9375H17.4883C18.8409 19.9375 19.9375 18.8409 19.9375 17.4883V7.94922C19.9375 6.59655 18.8409 5.5 17.4883 5.5Z" stroke="currentColor" stroke-width="1.375" stroke-linejoin="round"/><path d="M16.4785 5.5L16.5 4.46875C16.4982 3.83113 16.2441 3.22014 15.7932 2.76928C15.3424 2.31841 14.7314 2.06431 14.0938 2.0625H4.8125C4.08382 2.06465 3.38559 2.35508 2.87034 2.87034C2.35508 3.38559 2.06465 4.08382 2.0625 4.8125V14.0938C2.06431 14.7314 2.31841 15.3424 2.76928 15.7932C3.22014 16.2441 3.83113 16.4982 4.46875 16.5H5.5" stroke="currentColor" stroke-width="1.375" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  copyIconBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handleCopy(copyIconBtn);
  });

  const exportIconBtn = document.createElement("button");
  exportIconBtn.className = "args-header-icon-btn";
  exportIconBtn.title = "Export PDF";
  exportIconBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.5305 8.28025L10.5305 13.2802C10.2375 13.5732 9.7625 13.5732 9.4705 13.2802L4.4705 8.28025C4.1765 7.98725 4.1765 7.51225 4.4705 7.22025C4.7645 6.92825 5.2375 6.92625 5.5305 7.22025L9.2505 10.9403V0.75025C9.2505 0.33625 9.5865 0.000249863 10.0005 0.000249863C10.4145 0.000249863 10.7505 0.33625 10.7505 0.75025V10.9403L14.4705 7.22025C14.6165 7.07325 14.8085 7.00025 15.0005 7.00025C15.1925 7.00025 15.3845 7.07225 15.5305 7.22025C15.8235 7.51325 15.8235 7.98725 15.5305 8.28025Z" fill="currentColor"/><path d="M17.708 19.694H2.292C1.028 19.694 0 18.666 0 17.402V11.75C0 11.336 0.336 11 0.75 11C1.164 11 1.5 11.336 1.5 11.75V17.402C1.5 17.839 1.855 18.194 2.292 18.194H17.708C18.145 18.194 18.5 17.839 18.5 17.402V11.75C18.5 11.336 18.836 11 19.25 11C19.664 11 20 11.336 20 11.75V17.402C20 18.666 18.972 19.694 17.708 19.694Z" fill="currentColor"/></svg>`;
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
  purposeInput.addEventListener("input", () => {
    purposeInput.classList.remove("args-purpose-error");
    purposeInput.placeholder = "Why are you reading this?";
  });
  purposeInputEl = purposeInput;

  purposeSection.appendChild(purposeLabel);
  purposeSection.appendChild(purposeInput);
  panelFace.appendChild(purposeSection);

  // ── Tab Bar ──
  tabBarEl = document.createElement("div");
  tabBarEl.className = "args-tab-bar";

  notesTabBtn = document.createElement("button");
  notesTabBtn.className = "args-tab active";
  notesTabBtn.textContent = "Notes";
  notesTabBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    switchTab("notes");
  });

  sketchTabBtn = document.createElement("button");
  sketchTabBtn.className = "args-tab";
  sketchTabBtn.textContent = "Sketch";
  sketchTabBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    switchTab("sketch");
  });

  tabBarEl.appendChild(notesTabBtn);
  tabBarEl.appendChild(sketchTabBtn);
  panelFace.appendChild(tabBarEl);

  // ── List ──
  listEl = document.createElement("div");
  listEl.className = "args-list";
  panelFace.appendChild(listEl);
  renderList();

  // ── Sketch Content ──
  sketchContentEl = document.createElement("div");
  sketchContentEl.className = "args-sketch-content";
  sketchContentEl.style.display = "none";
  panelFace.appendChild(sketchContentEl);

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
  footerEl = document.createElement("div");
  const footer = footerEl;
  footer.className = "args-footer";

  const sketchBtn = document.createElement("button");
  sketchBtn.className = "args-sketch-btn";
  sketchBtn.textContent = "Sketch my Argument";
  sketchBtnEl = sketchBtn;
  sketchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handleSketch();
  });
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

  // Track mouse position to show close button only in top 30%
  containerEl.addEventListener("mousemove", (e) => {
    if (!expanded) return;
    const rect = containerEl!.getBoundingClientRect();
    const inTopZone = e.clientY < rect.top + rect.height * 0.3;
    if (inTopZone) {
      showTopBar();
    } else {
      hideTopBar();
    }
  });
  containerEl.addEventListener("mouseleave", () => hideTopBar());

  // ── Top bar — slides in above the box on hover (holds the mode toggle) ──
  topBarEl = document.createElement("div");
  topBarEl.className = "args-top-bar-hover";
  topBarEl.addEventListener("mouseenter", () => showTopBar());
  topBarEl.addEventListener("mouseleave", () => hideTopBar());
  containerEl.appendChild(topBarEl);

  // ── Enable-site bubble (visible when collapsed & not-enabled) ──
  enableBubbleEl = document.createElement("div");
  enableBubbleEl.className = "args-enable-bubble";
  enableBubbleEl.addEventListener("click", (e) => e.stopPropagation());

  const bubbleTextWrapper = document.createElement("span");
  bubbleTextWrapper.className = "args-enable-bubble-text";
  bubbleTextWrapper.innerHTML = `<a class="args-enable-bubble-link">Click here</a> to enable Oddity 1 `;

  const bubbleLink = bubbleTextWrapper.querySelector(
    ".args-enable-bubble-link",
  )!;
  bubbleLink.addEventListener("click", (e) => {
    e.stopPropagation();
    enableBubbleEl?.remove();
    if (dimmed) toggleDimmedPanel();
  });

  const bubbleClose = document.createElement("button");
  bubbleClose.className = "args-enable-bubble-close";
  bubbleClose.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8" fill="none"><line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  bubbleClose.addEventListener("click", (e) => {
    e.stopPropagation();
    enableBubbleEl?.remove();
    // Snooze the bubble for the next 3 non-listed sites
    chrome.storage.local.set({ enableBubbleSnoozeRemaining: 3 });
  });

  enableBubbleEl.appendChild(bubbleTextWrapper);
  enableBubbleEl.appendChild(bubbleClose);
  containerEl.appendChild(enableBubbleEl);

  // ── Empty-annotations bubble (visible when collapsed & empty result) ──
  emptyBubbleEl = document.createElement("div");
  emptyBubbleEl.className = "args-empty-bubble";
  emptyBubbleEl.addEventListener("click", (e) => e.stopPropagation());

  const emptyBubbleText = document.createElement("span");
  emptyBubbleText.className = "args-empty-bubble-text";
  emptyBubbleText.textContent =
    "This text is too short or not annotatable for Oddity 1";

  const emptyBubbleClose = document.createElement("button");
  emptyBubbleClose.className = "args-enable-bubble-close";
  emptyBubbleClose.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8" fill="none"><line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  emptyBubbleClose.addEventListener("click", (e) => {
    e.stopPropagation();
    emptyBubbleEl?.classList.remove("visible");
  });

  emptyBubbleEl.appendChild(emptyBubbleText);
  emptyBubbleEl.appendChild(emptyBubbleClose);
  containerEl.appendChild(emptyBubbleEl);

  // ── Resize handle (top-left corner, visible only when expanded) ──
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "args-resize-handle";
  containerEl.appendChild(resizeHandle);

  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;
  let resizeMinW = 0;
  let resizeMinH = 0;
  let resizeMaxW = 0;
  let resizeMaxH = 0;

  resizeHandle.addEventListener("mousedown", (e) => {
    if (!expanded) return;
    e.preventDefault();
    e.stopPropagation();
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = containerEl!.offsetWidth;
    resizeStartH = containerEl!.offsetHeight;
    const defaultW =
      parseFloat(containerEl!.style.getPropertyValue("--panel-width")) || 300;
    const defaultH = window.innerHeight - 58;
    resizeMinW = defaultW * 0.75;
    resizeMinH = defaultH * 0.5;
    resizeMaxW = defaultW;
    resizeMaxH = defaultH;
    containerEl!.style.transition = "none";
    document.addEventListener("mousemove", onResizeMove);
    document.addEventListener("mouseup", onResizeEnd);
  });

  function onResizeMove(e: MouseEvent) {
    if (!containerEl) return;
    const newW = Math.min(
      resizeMaxW,
      Math.max(resizeMinW, resizeStartW + (resizeStartX - e.clientX)),
    );
    const newH = Math.min(
      resizeMaxH,
      Math.max(resizeMinH, resizeStartH + (resizeStartY - e.clientY)),
    );
    containerEl.style.width = `${newW}px`;
    containerEl.style.height = `${newH}px`;
  }

  function onResizeEnd() {
    if (containerEl) containerEl.style.transition = "";
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", onResizeEnd);
  }

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
    extensionEnabled = en;
    containerEl?.classList.toggle("oddity-enabled", en);
    chrome.storage.local.get("preferences").then((stored) => {
      const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
      chrome.storage.local.set({ preferences: { ...prefs, enabled: en } });
    });
  });

  toggleBarEl.appendChild(panelToggleLabelEl);
  toggleBarEl.appendChild(panelToggleInput);
  toggleBarEl.appendChild(panelToggleSlider);

  // ── Dashboard close button (floats above mid-sized panel) ──
  dashCloseBtnEl = document.createElement("button");
  dashCloseBtnEl.className = "dash-close-btn";
  const dashCloseIcon = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  dashCloseIcon.setAttribute("width", "11");
  dashCloseIcon.setAttribute("height", "11");
  dashCloseIcon.setAttribute("viewBox", "0 0 12 12");
  dashCloseIcon.setAttribute("fill", "none");
  const dashCloseLine1 = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "line",
  );
  dashCloseLine1.setAttribute("x1", "1");
  dashCloseLine1.setAttribute("y1", "1");
  dashCloseLine1.setAttribute("x2", "11");
  dashCloseLine1.setAttribute("y2", "11");
  dashCloseLine1.setAttribute("stroke", "currentColor");
  dashCloseLine1.setAttribute("stroke-width", "2");
  dashCloseLine1.setAttribute("stroke-linecap", "round");
  const dashCloseLine2 = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "line",
  );
  dashCloseLine2.setAttribute("x1", "11");
  dashCloseLine2.setAttribute("y1", "1");
  dashCloseLine2.setAttribute("x2", "1");
  dashCloseLine2.setAttribute("y2", "11");
  dashCloseLine2.setAttribute("stroke", "currentColor");
  dashCloseLine2.setAttribute("stroke-width", "2");
  dashCloseLine2.setAttribute("stroke-linecap", "round");
  dashCloseIcon.appendChild(dashCloseLine1);
  dashCloseIcon.appendChild(dashCloseLine2);
  dashCloseBtnEl.appendChild(dashCloseIcon);
  dashCloseBtnEl.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    if (expanded) {
      toggle();
    }
  });
  containerEl.appendChild(dashCloseBtnEl);

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
      localAuthState = result?.authenticated ?? false;
      if (!result?.authenticated) {
        updateModeToggleVisibility();
        toggle();
        showDashboard();
        const stored = await chrome.storage.local.get("hadAccount");
        showAuthView(stored["hadAccount"] ? "signin" : "signup");
      } else {
        // Authenticated — check if site is whitelisted
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
        updateModeToggleVisibility();
      }
    })
    .catch(() => {});

  // Listen for "Go to highlight" failures (annotation not on page)
  document.addEventListener("oddity:scroll-to-annotation-missing", ((
    e: CustomEvent,
  ) => {
    const isReply = e?.detail?.isReply;
    if (isReply) {
      showArgToast(
        "This note is from a different personality and isn't on the page right now.",
      );
    } else {
      showArgToast("Could not find this highlight on the page.");
    }
  }) as EventListener);
}

function showArgToast(message: string): void {
  if (!shadowRoot || !outerWrapperEl) return;
  // Remove any existing toast
  const existing = shadowRoot.querySelector(".args-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "args-toast";
  toast.textContent = message;
  outerWrapperEl.appendChild(toast);

  // Force reflow then animate in
  void toast.offsetHeight;
  toast.classList.add("visible");

  setTimeout(() => {
    toast.classList.remove("visible");
    toast.addEventListener("transitionend", () => toast.remove(), {
      once: true,
    });
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

export function updateArgumentsBox(
  annotations: Map<string, Annotation[]>,
  feedback: Map<string, AnnotationFeedback[]>,
): void {
  if (!hostEl) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    cacheAnnotationNotes(annotations);
    canonicalItems = buildItems(annotations, feedback);
    // Remove live items that are now in canonical data:
    // 1. Reply/reaction items: matched by feedbackId
    const canonicalFbIds = new Set(
      canonicalItems.map((i) => i.feedbackId).filter(Boolean),
    );
    // 2. Manual annotation items: matched by annotationId (they have no feedbackId)
    const canonicalManualAnnIds = new Set(
      canonicalItems
        .filter((i) => i.type === "manual")
        .map((i) => i.annotationId)
        .filter(Boolean),
    );
    liveItems = liveItems.filter((li) => {
      if (li.feedbackId && canonicalFbIds.has(li.feedbackId)) return false;
      if (
        li.type === "manual" &&
        li.annotationId &&
        canonicalManualAnnIds.has(li.annotationId)
      )
        return false;
      return true;
    });
    renderList();
  }, 150);
}

/** Pre-cache annotation types from any annotation map (call with both modes to persist colors across switches). */
export function cacheAnnotationMeta(
  annotations: Map<string, Annotation[]>,
): void {
  cacheAnnotationNotes(annotations);
}

export function addLiveFeedback(
  icon: string,
  text: string,
  opts?: {
    quote?: string;
    type?: ArgumentItem["type"];
    replyHeader?: string;
    replyFullNote?: string;
    replyAnchor?: string;
    annotationType?: AnnotationType;
    annotationId?: string;
    contentHash?: string;
  },
): string {
  if (!hostEl) return "";
  const sortKey = `live-${Date.now()}`;
  liveItems.push({
    icon,
    text,
    quote: opts?.quote,
    replyHeader: opts?.replyHeader,
    replyFullNote: opts?.replyFullNote,
    replyAnchor: opts?.replyAnchor,
    sortKey,
    type: opts?.type ?? "reaction",
    annotationType: opts?.annotationType,
    annotationId: opts?.annotationId,
    contentHash: opts?.contentHash,
  });
  renderList();
  return sortKey;
}

/** Update a live item's feedbackId once the server responds. */
export function updateLiveFeedbackId(
  sortKey: string,
  feedbackId: string,
): void {
  const item = liveItems.find((i) => i.sortKey === sortKey);
  if (item) item.feedbackId = feedbackId;
}

/** Mode toggle: always visible when expanded (even if off), hidden when collapsed + off. */
function updateModeToggleVisibility(): void {
  if (!modeToggleWrapperEl) return;
  const wasHidden = modeToggleWrapperEl.style.display === "none";
  // Show when: box visible, signed in, not dimmed, AND (enabled OR expanded)
  const show =
    boxVisible &&
    !dimmed &&
    localAuthState === true &&
    (extensionEnabled || expanded);
  modeToggleWrapperEl.style.display = show ? "" : "none";
  // Mark disabled so click handler can ignore mode switches (but no visual dimming)
  modeToggleWrapperEl.classList.toggle("disabled", !extensionEnabled);
  if (show && wasHidden) {
    requestAnimationFrame(() => {
      syncModeToggleSlider();
      syncModeTogglePosition();
    });
  }
}

export function setArgumentsBoxVisible(visible: boolean): void {
  if (!hostEl) return;
  boxVisible = visible;
  hostEl.style.display = visible ? "" : "none";
  updateModeToggleVisibility();
}

export function setArgumentsBoxEnabled(enabled: boolean): void {
  if (!containerEl) return;
  extensionEnabled = enabled;
  containerEl.classList.toggle("oddity-enabled", enabled);
  if (panelToggleInput) panelToggleInput.checked = enabled;
  if (panelToggleLabelEl)
    panelToggleLabelEl.textContent = enabled ? "On" : "Off";
  if (dashToggleInput) dashToggleInput.checked = enabled;
  if (dashToggleLabelEl) dashToggleLabelEl.textContent = enabled ? "On" : "Off";
  updateModeToggleVisibility();
}

export function setArgumentsBoxDimmed(isDimmed: boolean): void {
  dimmed = isDimmed;
  containerEl?.classList.toggle("oddity-not-enabled", isDimmed);
  if (isDimmed) {
    // Site not enabled → show as OFF (no green stroke, toggle off)
    containerEl?.classList.remove("oddity-enabled");
    if (panelToggleInput) panelToggleInput.checked = false;
    if (panelToggleLabelEl) panelToggleLabelEl.textContent = "Off";
    if (dashToggleInput) dashToggleInput.checked = false;
    if (dashToggleLabelEl) dashToggleLabelEl.textContent = "Off";
    // Hide the enable bubble if snoozed (dismissed within last 3 non-listed sites)
    chrome.storage.local.get("enableBubbleSnoozeRemaining").then((result) => {
      const remaining = result.enableBubbleSnoozeRemaining;
      if (typeof remaining === "number" && remaining > 0) {
        enableBubbleEl?.remove();
        chrome.storage.local.set({ enableBubbleSnoozeRemaining: remaining - 1 });
      }
    });
  }
  updateModeToggleVisibility();
}

export function showEmptyAnnotationsBubble(): void {
  emptyBubbleEl?.classList.add("visible");
}

export function hideEmptyAnnotationsBubble(): void {
  emptyBubbleEl?.classList.remove("visible");
}

export function setArgumentsBoxBlocked(isBlocked: boolean): void {
  blocked = isBlocked;
  containerEl?.classList.toggle("oddity-blocked", isBlocked);
  if (isBlocked) {
    showBlockedOverlay();
  }
}

export function setArgumentsBoxPdf(isPdf: boolean): void {
  pdfDetected = isPdf;
  containerEl?.classList.toggle("oddity-pdf", isPdf);
  if (isPdf) {
    dimmed = true;
    containerEl?.classList.add("oddity-not-enabled");
    showPdfOverlay();
  }
}

export function setDashUserTier(tier: string): void {
  dashUserTier = tier;
}

export function setPdfRunCallback(cb: () => void): void {
  pdfRunCb = cb;
}

export function setManualRunCallback(cb: () => void): void {
  manualRunCb = cb;
}

export function setInputTextProvider(cb: () => string): void {
  inputTextProviderCb = cb;
}

export function appendSketchChunk(text: string, done: boolean): void {
  if (!sketchContentEl) return;
  if (text) {
    sketchBuffer += text;
    sketchContentEl.innerHTML = renderMarkdown(sketchBuffer);
    sketchContentEl.scrollTop = sketchContentEl.scrollHeight;
  }
  if (done) {
    sketchLoading = false;
    if (sketchBtnEl) {
      sketchBtnEl.disabled = false;
      sketchBtnEl.textContent = "Sketch my Argument";
    }
  }
}

export function updateArgumentsBoxStyle(
  font?: AnnotationFont,
  fontSize?: AnnotationFontSize,
): void {
  const host = shadowRoot?.host as HTMLElement;
  if (!host) return;
  host.style.setProperty("--oddity-note-font", FONT_MAP[font ?? "fraunces"]);
  host.style.setProperty("--oddity-note-size", SIZE_MAP[fontSize ?? "default"]);
  lastRenderedKey = ""; // force rebuild with new styles
  renderList(); // re-layout since sizes changed
}

let signOutCb: (() => void) | null = null;

/** Update the dashboard's personality display (avatar, select, buttons, bubble). */
export function updateDashboardPersonality(personality: string): void {
  const display = personality.charAt(0).toUpperCase() + personality.slice(1);
  if (dashPersonaSelect) dashPersonaSelect.textContent = display;
  if (dashPersonaAvatarImgEl) {
    dashPersonaAvatarImgEl.src = chrome.runtime.getURL(`${display}.png`);
    dashPersonaAvatarImgEl.alt = display;
  }
  if (dashPersonaCircleEl)
    dashPersonaCircleEl.style.background =
      display === "Jerry" ? "#FDCB24" : "#fff";
  dashDensityBtns.forEach((b) =>
    b.classList.toggle(
      "args-dash-density-active",
      b.dataset.intensity === personality,
    ),
  );
  if (bubbleLogoImgEl) {
    bubbleLogoImgEl.src = chrome.runtime.getURL(`${display}.png`);
    bubbleLogoImgEl.alt = display;
  }
}

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
  updateModeToggleVisibility();
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
      user.tier === "standard" ? "Standard Plan" : "Free Plan";
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
    // Collapse to button — don't auto-expand the "not enabled" panel
    dimmed = true;
    containerEl?.classList.add("oddity-not-enabled");
    updateModeToggleVisibility();
    if (expanded) {
      expanded = false;
      containerEl?.classList.remove("expanded", "dashboard");
      toggleBarEl?.classList.remove("visible");
      if (containerEl) {
        containerEl.style.height = "";
        containerEl.style.width = "";
      }
    }
  } else {
    updateModeToggleVisibility();
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
  modeToggleWrapperEl = null;
  modeToggleOverviewBtn = null;
  modeToggleDepthBtn = null;
  modeToggleSliderEl = null;
  modeToggleEl = null;
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
  topBarEl = null;
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
  pdfDetected = false;
  pdfPanelEl = null;
  pdfRunCb = null;
  enableBubbleEl = null;
  canonicalItems = [];
  liveItems = [];
}

// ─── Internal ───

function showNotEnabledOverlay(): void {
  if (notEnabledPanelEl) return; // already showing
  dimmed = true;
  containerEl?.classList.add("oddity-not-enabled");
  if (modeToggleWrapperEl) modeToggleWrapperEl.style.display = "none";
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
    containerEl?.classList.remove("oddity-not-enabled");
    dimmed = false;
    toggleBarEl?.classList.add("visible");
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
    // Await addEnabledSite BEFORE enableExtension to avoid a race condition
    // where enableExtension's read-modify-write on preferences overwrites
    // the enabled_sites update from the background script.
    chrome.runtime
      .sendMessage({ action: "addEnabledSite", payload: { domain } })
      .then(() => enableExtension())
      .catch(() => enableExtension());
    sessionSiteEnabled = true;
    removeOverlay();
    manualRunCb?.();
  });

  btnRow.appendChild(alwaysEnableBtn);
  btnRow.appendChild(runOnceBtn);

  // Dismiss close button (floats above box, like dash-close-btn)
  const closeBtn = document.createElement("button");
  closeBtn.className = "args-not-enabled-close";
  const closeIcon = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  closeIcon.setAttribute("width", "11");
  closeIcon.setAttribute("height", "11");
  closeIcon.setAttribute("viewBox", "0 0 12 12");
  closeIcon.setAttribute("fill", "none");
  const line1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line1.setAttribute("x1", "1");
  line1.setAttribute("y1", "1");
  line1.setAttribute("x2", "11");
  line1.setAttribute("y2", "11");
  line1.setAttribute("stroke", "currentColor");
  line1.setAttribute("stroke-width", "2");
  line1.setAttribute("stroke-linecap", "round");
  const line2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line2.setAttribute("x1", "11");
  line2.setAttribute("y1", "1");
  line2.setAttribute("x2", "1");
  line2.setAttribute("y2", "11");
  line2.setAttribute("stroke", "currentColor");
  line2.setAttribute("stroke-width", "2");
  line2.setAttribute("stroke-linecap", "round");
  closeIcon.appendChild(line1);
  closeIcon.appendChild(line2);
  closeBtn.appendChild(closeIcon);
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    containerEl?.classList.remove("oddity-not-enabled");
    dimmed = false;
    closeBtn.remove();
    if (expanded) toggle();
  });
  containerEl?.appendChild(closeBtn);

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
  toggleBarEl?.classList.add("visible");
}

function showPdfOverlay(): void {
  if (pdfPanelEl) return;
  containerEl?.classList.add("oddity-pdf");
  containerEl?.classList.remove("dashboard");
  const contentClip = shadowRoot?.querySelector(".args-content-clip");
  if (!contentClip) return;

  pdfPanelEl = document.createElement("div");
  pdfPanelEl.className = "args-not-enabled-overlay";

  const msg = document.createElement("div");
  msg.className = "args-not-enabled-msg";
  msg.textContent = "This is a PDF";

  const hint = document.createElement("div");
  hint.className = "args-not-enabled-hint";
  hint.style.fontSize = "12px";
  hint.style.marginTop = "4px";

  const btnRow = document.createElement("div");
  btnRow.className = "args-not-enabled-btn-row";

  if (dashUserTier !== "standard") {
    // Free users: show upgrade prompt
    hint.textContent = "Annotations on PDF requires a Standard plan. ";
    const link = document.createElement("a");
    link.href = "https://app.oddity1.com/plans";
    link.target = "_blank";
    link.style.color = "#22c55e";
    link.style.textDecoration = "underline";
    link.textContent = "Get Standard";
    hint.appendChild(link);
  } else {
    // Standard users: show conversion button
    hint.textContent = "Convert to HTML to enable Oddity 1";
    const runBtn = document.createElement("button");
    runBtn.className = "args-run-btn";
    runBtn.textContent = "Run as HTML";
    runBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      runBtn.disabled = true;
      runBtn.textContent = "Converting…";
      pdfRunCb?.();
    });
    btnRow.appendChild(runBtn);
  }

  pdfPanelEl.appendChild(msg);
  pdfPanelEl.appendChild(hint);
  if (btnRow.children.length > 0) pdfPanelEl.appendChild(btnRow);
  pdfPanelEl.addEventListener("click", (e) => e.stopPropagation());
  contentClip.appendChild(pdfPanelEl);

  // Auto-expand so the PDF overlay is visible
  expanded = true;
  containerEl?.classList.add("expanded");
  toggleBarEl?.classList.add("visible");
}

function toggleDimmedPanel(): void {
  enableBubbleEl?.remove();
  expanded = !expanded;
  containerEl?.classList.toggle("expanded", expanded);
  if (!expanded) {
    toggleBarEl?.classList.remove("visible");
    if (containerEl) {
      containerEl.style.height = "";
      containerEl.style.width = "";
    }
    if (closeBtnHideTimer) clearTimeout(closeBtnHideTimer);
    topBarEl?.classList.remove("hovered");
    notEnabledPanelEl?.remove();
    notEnabledPanelEl = null;
    pdfPanelEl?.remove();
    pdfPanelEl = null;
    return;
  } else if (containerEl?.matches(":hover")) {
    showTopBar();
  }
  if (pdfDetected) {
    showPdfOverlay();
  } else {
    showNotEnabledOverlay();
  }
}

function toggle(): void {
  expanded = !expanded;
  containerEl?.classList.toggle("expanded", expanded);
  toggleBarEl?.classList.toggle("visible", expanded);
  updateModeToggleVisibility();
  syncModeTogglePosition();
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
    containerEl?.querySelector(".args-not-enabled-close")?.remove();
    containerEl?.classList.remove("oddity-not-enabled");
    dimmed = false;
    if (closeBtnHideTimer) clearTimeout(closeBtnHideTimer);
    topBarEl?.classList.remove("hovered");
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

function showTopBar(): void {
  if (!expanded) return;
  if (closeBtnHideTimer) {
    clearTimeout(closeBtnHideTimer);
    closeBtnHideTimer = null;
  }
  topBarEl?.classList.add("hovered");
}

function hideTopBar(): void {
  closeBtnHideTimer = setTimeout(() => {
    topBarEl?.classList.remove("hovered");
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
  if (dashForgotLinkEl)
    dashForgotLinkEl.style.display = mode === "signin" ? "block" : "none";
  if (dashAuthTermsEl)
    dashAuthTermsEl.style.display = mode === "signup" ? "block" : "none";
  if (dashSignInStatusEl) {
    dashSignInStatusEl.style.display = "none";
    dashSignInStatusEl.className = "args-dash-feedback-status";
  }
  if (dashSignInViewEl) {
    dashSignInViewEl.style.display = "flex";
  }
  if (containerEl) {
    containerEl.style.width = "240px";
    containerEl.style.height = "370px";
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

  const logo = document.createElement("img");
  logo.className = "args-dash-logo-img";
  logo.src = chrome.runtime.getURL("Oddity1-Logo.png");
  logo.alt = "Oddity 1";
  logo.style.cursor = "pointer";
  logo.addEventListener("click", (e) => {
    e.stopPropagation();
    window.open("https://app.oddity1.com", "_blank");
  });

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
    extensionEnabled = en;
    containerEl?.classList.toggle("oddity-enabled", en);
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

  dashPersonaSelect = document.createElement("span");
  dashPersonaSelect.className = "args-dash-persona-label";
  dashPersonaSelect.textContent = "Jerry";

  avatarArea.appendChild(dashPersonaCircleEl);
  avatarArea.appendChild(dashPersonaSelect);

  const countArea = document.createElement("div");
  countArea.className = "args-dash-count-area";
  dashCountEl = document.createElement("span");
  dashCountEl.className = "args-dash-count-num";
  dashCountEl.textContent = "0";
  const countLabel = document.createElement("span");
  countLabel.className = "args-dash-count-label";
  countLabel.textContent = "annotations created with Oddity 1";
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
  const personaDescs: Record<string, string> = {
    terry: "Sharp & critical",
    jerry: "Creative & curious",
    sally: "Engaging & guiding",
  };
  dashDensityBtns = [];
  for (const [value, label] of [
    ["terry", "Terry"],
    ["jerry", "Jerry"],
    ["sally", "Sally"],
  ] as [string, string][]) {
    const btn = document.createElement("button");
    btn.className =
      "args-dash-density-btn" +
      (value === "jerry" ? " args-dash-density-active" : "");
    btn.dataset.intensity = value;
    btn.textContent = label;
    const tooltip = document.createElement("span");
    tooltip.className = "args-dash-density-tooltip";
    tooltip.textContent = personaDescs[value] ?? "";
    btn.appendChild(tooltip);
    btn.addEventListener("click", () => {
      // Gate: Sally personality requires Standard plan
      if (value === "sally" && dashUserTier !== "standard") {
        showNoticeToast("Sally personality requires a Standard plan");
        return;
      }

      dashDensityBtns.forEach((b) =>
        b.classList.remove("args-dash-density-active"),
      );
      btn.classList.add("args-dash-density-active");

      // Sync the top avatar, persona selector, and bubble logo
      if (dashPersonaSelect) dashPersonaSelect.textContent = label;
      if (dashPersonaAvatarImgEl) {
        dashPersonaAvatarImgEl.src = chrome.runtime.getURL(`${label}.png`);
        dashPersonaAvatarImgEl.alt = label;
      }
      if (dashPersonaCircleEl)
        dashPersonaCircleEl.style.background =
          label === "Jerry" ? "#FDCB24" : "#fff";
      if (bubbleLogoImgEl) {
        bubbleLogoImgEl.src = chrome.runtime.getURL(`${label}.png`);
        bubbleLogoImgEl.alt = label;
      }

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
  dashTierBadgeEl.textContent = "Get Standard";
  dashTierBadgeEl.style.cursor = "pointer";
  dashTierBadgeEl.addEventListener("click", () => {
    if (dashUserTier !== "standard") {
      window.open("https://app.oddity1.com/plans", "_blank");
    }
  });

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
    if (dashTierBadgeEl) {
      dashTierBadgeEl.textContent = "Get Standard";
      dashTierBadgeEl.style.cursor = "pointer";
    }
    if (dashCountEl) dashCountEl.textContent = "0";
    dashUserEmail = "";
    dashUserTier = "free";
    if (dashSignInEmailEl) dashSignInEmailEl.value = "";
    if (dashSignInPasswordEl) dashSignInPasswordEl.value = "";
    if (dashSignInNameEl) dashSignInNameEl.value = "";
    localAuthState = false;
    updateModeToggleVisibility();
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
    window.open("https://app.oddity1.com/settings", "_blank");
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
    fbRoleSelect.value = "";
    fbRoleOther.value = "";
    fbRoleOther.style.display = "none";
    dashFeedbackTextareaEl.value = "";
    dashFeedbackStatusEl.style.display = "none";
    dashFeedbackStatusEl.className = "args-dash-feedback-status";
    dashFeedbackViewEl.style.display = "flex";
    if (containerEl) containerEl.style.height = "330px";
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

  const fbRoleSelect = document.createElement("select");
  fbRoleSelect.className = "args-dash-feedback-role-select";
  const roleOptions = [
    ["", "What's your role? (optional)"],
    ["Student", "Student"],
    ["Researcher", "Researcher"],
    ["Teacher/Professor", "Teacher/Professor"],
    ["Engineer", "Engineer"],
    ["Designer", "Designer"],
    ["Writer", "Writer"],
    ["Product Manager", "Product Manager"],
    ["Other", "Other"],
  ];
  for (const [val, label] of roleOptions) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    fbRoleSelect.appendChild(opt);
  }

  const fbRoleOther = document.createElement("input");
  fbRoleOther.className = "args-dash-feedback-role-other";
  fbRoleOther.type = "text";
  fbRoleOther.placeholder = "Your role...";

  fbRoleSelect.addEventListener("change", () => {
    fbRoleOther.style.display =
      fbRoleSelect.value === "Other" ? "block" : "none";
    if (fbRoleSelect.value !== "Other") fbRoleOther.value = "";
  });

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
    const role =
      fbRoleSelect.value === "Other"
        ? fbRoleOther.value.trim()
        : fbRoleSelect.value;
    dashFeedbackSendBtnEl!.textContent = "Sending...";
    dashFeedbackSendBtnEl!.setAttribute("disabled", "");
    dashFeedbackStatusEl!.style.display = "none";
    try {
      const result = (await chrome.runtime.sendMessage({
        action: "sendUserFeedback",
        payload: { message, role: role || undefined },
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
  dashFeedbackViewEl.appendChild(fbRoleSelect);
  dashFeedbackViewEl.appendChild(fbRoleOther);
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
  dashSignInNameEl.autocomplete = "off";

  dashSignInEmailEl = document.createElement("input");
  dashSignInEmailEl.className = "args-dash-signin-input";
  dashSignInEmailEl.type = "text";
  dashSignInEmailEl.placeholder = "Email";
  dashSignInEmailEl.autocomplete = "off";

  dashSignInPasswordEl = document.createElement("input");
  dashSignInPasswordEl.className = "args-dash-signin-input";
  dashSignInPasswordEl.type = "text";
  dashSignInPasswordEl.placeholder = "Password";
  dashSignInPasswordEl.autocomplete = "off";
  (dashSignInPasswordEl.style as any).webkitTextSecurity = "disc";

  dashSignInStatusEl = document.createElement("div");
  dashSignInStatusEl.className = "args-dash-feedback-status";

  // Google sign-in button (SVG + label built via DOM to avoid innerHTML)
  const dashGoogleBtnEl = document.createElement("button");
  dashGoogleBtnEl.className = "args-dash-google-btn";
  const buildGoogleBtnContent = (): DocumentFragment => {
    const frag = document.createDocumentFragment();
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 48 48");
    svg.style.flexShrink = "0";
    const paths: [string, string][] = [
      [
        "#EA4335",
        "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z",
      ],
      [
        "#4285F4",
        "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z",
      ],
      [
        "#FBBC05",
        "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z",
      ],
      [
        "#34A853",
        "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z",
      ],
    ];
    for (const [fill, d] of paths) {
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("fill", fill);
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    frag.appendChild(svg);
    frag.appendChild(document.createTextNode("Continue with Google"));
    return frag;
  };
  dashGoogleBtnEl.appendChild(buildGoogleBtnContent());
  dashGoogleBtnEl.addEventListener("click", async () => {
    dashGoogleBtnEl.textContent = "Signing in...";
    dashGoogleBtnEl.setAttribute("disabled", "");
    if (dashSignInStatusEl) dashSignInStatusEl.style.display = "none";

    try {
      const result = (await chrome.runtime.sendMessage({
        action: "signInWithGoogle",
        payload: {},
      })) as { success?: boolean; error?: string; user?: unknown };

      if (result?.error) throw new Error(result.error);

      localAuthState = true;
      await chrome.storage.local.set({ hadAccount: true });
      if (dashSignInViewEl) dashSignInViewEl.style.display = "none";

      // Show onboarding slideshow, then continue with normal post-auth flow
      if (containerEl) {
        containerEl.style.width = "340px";
        containerEl.style.height = "520px";
      }
      showOnboardingSlideshow(async () => {
        if (containerEl) {
          containerEl.style.height = "";
          containerEl.style.width = "";
        }
        if (footerTextEl) footerTextEl.textContent = "Go to Dashboard";
        const prefsStored = await chrome.storage.local.get("preferences");
        const enabledSites = (
          prefsStored["preferences"] as Record<string, unknown>
        )?.["enabled_sites"] as string[] | undefined;
        const hostname = window.location.hostname.replace(/^www\./, "");
        const siteEnabled =
          Array.isArray(enabledSites) &&
          enabledSites.some(
            (s) => hostname === s || hostname.endsWith("." + s),
          );
        if (!siteEnabled) {
          showNotEnabledOverlay();
        } else {
          await loadDashboardData();
        }
        updateModeToggleVisibility();
        document.dispatchEvent(new CustomEvent("oddity:localSignIn"));
      });
    } catch (err) {
      const msg = String(
        err instanceof Error ? err.message : "Something went wrong",
      );
      if (
        !msg.includes("cancelled") &&
        !msg.includes("canceled") &&
        !msg.includes("User interaction required")
      ) {
        if (dashSignInStatusEl) {
          dashSignInStatusEl.textContent = msg;
          dashSignInStatusEl.className = "args-dash-feedback-status error";
          dashSignInStatusEl.style.display = "block";
        }
      }
    } finally {
      while (dashGoogleBtnEl.firstChild)
        dashGoogleBtnEl.removeChild(dashGoogleBtnEl.firstChild);
      dashGoogleBtnEl.appendChild(buildGoogleBtnContent());
      dashGoogleBtnEl.removeAttribute("disabled");
    }
  });

  // Auth divider
  const dashAuthDividerEl = document.createElement("div");
  dashAuthDividerEl.className = "args-dash-auth-divider";
  const dashAuthDividerSpan = document.createElement("span");
  dashAuthDividerSpan.textContent = "or";
  dashAuthDividerEl.appendChild(dashAuthDividerSpan);

  // Terms text
  dashAuthTermsEl = document.createElement("div");
  dashAuthTermsEl.className = "args-dash-auth-terms";
  dashAuthTermsEl.appendChild(
    document.createTextNode("By continuing, you agree to our "),
  );
  const dashAuthTermsLink = document.createElement("a");
  dashAuthTermsLink.href = "https://www.oddity1.com/terms";
  dashAuthTermsLink.target = "_blank";
  dashAuthTermsLink.rel = "noopener noreferrer";
  dashAuthTermsLink.textContent = "Terms";
  dashAuthTermsEl.appendChild(dashAuthTermsLink);
  dashAuthTermsEl.appendChild(document.createTextNode(" and "));
  const dashAuthPrivacyLink = document.createElement("a");
  dashAuthPrivacyLink.href = "https://www.oddity1.com/privacy";
  dashAuthPrivacyLink.target = "_blank";
  dashAuthPrivacyLink.rel = "noopener noreferrer";
  dashAuthPrivacyLink.textContent = "Privacy Policy";
  dashAuthTermsEl.appendChild(dashAuthPrivacyLink);
  dashAuthTermsEl.appendChild(document.createTextNode("."));

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
      dashSignInEmailEl!.value = "";
      dashSignInPasswordEl!.value = "";
      dashSignInNameEl!.value = "";

      // Show onboarding slideshow, then continue with normal post-auth flow
      if (containerEl) {
        containerEl.style.width = "340px";
        containerEl.style.height = "520px";
      }
      showOnboardingSlideshow(async () => {
        if (containerEl) {
          containerEl.style.height = "";
          containerEl.style.width = "";
        }
        if (footerTextEl) footerTextEl.textContent = "Go to Dashboard";
        const prefsStored = await chrome.storage.local.get("preferences");
        const enabledSites = (
          prefsStored["preferences"] as Record<string, unknown>
        )?.["enabled_sites"] as string[] | undefined;
        const hostname = window.location.hostname.replace(/^www\./, "");
        const siteEnabled =
          Array.isArray(enabledSites) &&
          enabledSites.some(
            (s) => hostname === s || hostname.endsWith("." + s),
          );
        if (!siteEnabled) {
          showNotEnabledOverlay();
        } else {
          await loadDashboardData();
        }
        updateModeToggleVisibility();
        // Notify index.ts so it can start the annotation pipeline on this tab
        document.dispatchEvent(new CustomEvent("oddity:localSignIn"));
      });
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

  dashForgotLinkEl = document.createElement("span");
  dashForgotLinkEl.className = "args-dash-forgot-link";
  dashForgotLinkEl.textContent = "Forgot password?";
  dashForgotLinkEl.style.display = "none";
  dashForgotLinkEl.addEventListener("click", () => {
    const email = dashSignInEmailEl!.value.trim();
    if (!email) {
      if (dashSignInStatusEl) {
        dashSignInStatusEl.textContent = "Enter your email first.";
        dashSignInStatusEl.className = "args-dash-feedback-status error";
        dashSignInStatusEl.style.display = "block";
      }
      return;
    }
    dashForgotLinkEl!.textContent = "Sending...";
    dashForgotLinkEl!.style.pointerEvents = "none";
    chrome.runtime.sendMessage(
      { action: "resetPassword", payload: { email } },
      (response) => {
        if (response?.error) {
          if (dashSignInStatusEl) {
            dashSignInStatusEl.textContent = response.error;
            dashSignInStatusEl.className = "args-dash-feedback-status error";
            dashSignInStatusEl.style.display = "block";
          }
        } else {
          if (dashSignInStatusEl) {
            dashSignInStatusEl.textContent =
              "Check your email for a reset link.";
            dashSignInStatusEl.style.color = "#22c55e";
            dashSignInStatusEl.style.display = "block";
          }
        }
        dashForgotLinkEl!.textContent = "Forgot password?";
        dashForgotLinkEl!.style.pointerEvents = "";
      },
    );
  });

  dashAuthToggleLinkEl = document.createElement("span");
  dashAuthToggleLinkEl.className = "args-dash-signin-toggle";
  dashAuthToggleLinkEl.textContent = "Already have an account? Sign in";
  dashAuthToggleLinkEl.addEventListener("click", () => {
    showAuthView(dashSignInMode === "signup" ? "signin" : "signup");
  });

  dashSignInViewEl.appendChild(dashAuthTitleEl);
  dashSignInViewEl.appendChild(dashGoogleBtnEl);
  dashSignInViewEl.appendChild(dashAuthDividerEl);
  dashSignInViewEl.appendChild(dashSignInNameEl);
  dashSignInViewEl.appendChild(dashSignInEmailEl);
  dashSignInViewEl.appendChild(dashSignInPasswordEl);
  dashSignInViewEl.appendChild(dashForgotLinkEl);
  dashSignInViewEl.appendChild(dashAuthTermsEl);
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
    dashFontSelect.value = (prefs.annotation_font as string) ?? "fraunces";
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
  // Derive display name from depth_personality (single source of truth)
  const persona = personality.charAt(0).toUpperCase() + personality.slice(1);
  if (dashPersonaSelect) dashPersonaSelect.textContent = persona;
  if (dashPersonaAvatarImgEl) {
    dashPersonaAvatarImgEl.src = chrome.runtime.getURL(`${persona}.png`);
    dashPersonaAvatarImgEl.alt = persona;
  }
  if (bubbleLogoImgEl) {
    bubbleLogoImgEl.src = chrome.runtime.getURL(`${persona}.png`);
    bubbleLogoImgEl.alt = persona;
  }
  if (dashPersonaCircleEl)
    dashPersonaCircleEl.style.background =
      persona === "Jerry" ? "#FDCB24" : "#fff";
  // If the site is not enabled (dimmed), force toggle to OFF
  const enabled = dimmed ? false : prefs.enabled !== false;
  if (dashToggleInput) dashToggleInput.checked = enabled;
  if (dashToggleLabelEl) dashToggleLabelEl.textContent = enabled ? "On" : "Off";
  if (panelToggleInput) panelToggleInput.checked = enabled;
  if (panelToggleLabelEl)
    panelToggleLabelEl.textContent = enabled ? "On" : "Off";
  extensionEnabled = enabled;
  containerEl?.classList.toggle("oddity-enabled", enabled);
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
      if (dashTierBadgeEl) {
        dashTierBadgeEl.textContent =
          dashUserTier === "standard" ? "Standard" : "Get Standard";
        dashTierBadgeEl.style.cursor =
          dashUserTier !== "standard" ? "pointer" : "";
      }
      if (dashSignOutPopoverNameEl) dashSignOutPopoverNameEl.textContent = name;
      if (dashSignOutPopoverEmailEl)
        dashSignOutPopoverEmailEl.textContent = dashUserEmail;
      if (dashSignOutPopoverPlanEl)
        dashSignOutPopoverPlanEl.textContent =
          dashUserTier === "standard" ? "Standard Plan" : "Free Plan";
    } else {
      if (dashProfileNameEl) dashProfileNameEl.textContent = "Not signed in";
      if (dashProfileAvatarEl) dashProfileAvatarEl.textContent = "?";
      if (dashTierBadgeEl) {
        dashTierBadgeEl.textContent = "Get Standard";
        dashTierBadgeEl.style.cursor = "pointer";
      }
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

  // Build annotation ID → content hash lookup
  const annHashMap = new Map<string, string>();
  for (const [hash, anns] of annotations) {
    for (const ann of anns) {
      annHashMap.set(ann.id, hash);
    }
  }

  for (const [hash, anns] of annotations) {
    for (const ann of anns) {
      if (deletedAnnotationIds.has(ann.id)) continue;
      if (ann.id.startsWith("manual-")) {
        items.push({
          icon: "✎",
          text: ann.content.note,
          quote: ann.anchor.exact,
          sortKey: ann.id,
          type: "manual",
          annotationId: ann.id,
          annotation: ann,
          contentHash: hash,
        });
      }
    }
  }

  // Defensive dedup: track emitted feedbackIds to prevent duplicate cards
  // even if the merged feedback map somehow contains the same entry twice.
  const emittedFbIds = new Set<string>();

  for (const [hash, fbs] of feedback) {
    for (const fb of fbs) {
      if (deletedFeedbackIds.has(fb.id)) continue;
      if (fb.id && emittedFbIds.has(fb.id)) continue;
      if (fb.id) emittedFbIds.add(fb.id);
      const fbHash = annHashMap.get(fb.annotation_id) ?? hash;
      const srcAnnotationType = findAnnotationType(
        annotations,
        fb.annotation_id,
      );
      if (fb.feedback_type === "thumbs_up") {
        const note = findAnnotationNote(annotations, fb.annotation_id);
        const anchor = findAnnotationQuote(annotations, fb.annotation_id);
        const excerpt = note.length > 40 ? note.slice(0, 37) + "\u2026" : note;
        items.push({
          icon: "↳",
          text: "I agree",
          sortKey: fb.created_at,
          type: "reply",
          replyHeader: excerpt,
          replyFullNote: note,
          replyAnchor: anchor,
          feedbackId: fb.id,
          annotationId: fb.annotation_id,
          contentHash: fbHash,
          annotationType: srcAnnotationType,
        });
      } else if (fb.feedback_type === "thumbs_down") {
        const note = findAnnotationNote(annotations, fb.annotation_id);
        const anchor = findAnnotationQuote(annotations, fb.annotation_id);
        const excerpt = note.length > 40 ? note.slice(0, 37) + "\u2026" : note;
        items.push({
          icon: "↳",
          text: "I don't think so",
          sortKey: fb.created_at,
          type: "reply",
          replyHeader: excerpt,
          replyFullNote: note,
          replyAnchor: anchor,
          feedbackId: fb.id,
          annotationId: fb.annotation_id,
          contentHash: fbHash,
          annotationType: srcAnnotationType,
        });
      } else if (fb.feedback_type === "reply") {
        const note = findAnnotationNote(annotations, fb.annotation_id);
        const anchor = findAnnotationQuote(annotations, fb.annotation_id);
        const excerpt = note.length > 40 ? note.slice(0, 37) + "\u2026" : note;
        items.push({
          icon: "↳",
          text: fb.reply_text ?? "",
          sortKey: fb.created_at,
          type: "reply",
          replyHeader: excerpt,
          replyFullNote: note,
          replyAnchor: anchor,
          feedbackId: fb.id,
          annotationId: fb.annotation_id,
          contentHash: fbHash,
          annotationType: srcAnnotationType,
        });
      }
    }
  }

  items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return items;
}

// In-memory cache of annotation note texts, keyed by annotation ID.
// Survives annotation cache regeneration (which assigns new UUIDs).
const annotationNoteCache = new Map<string, string>();
// In-memory cache of annotation types, keyed by annotation ID.
const annotationTypeCache = new Map<string, string>();

/** Persist the note cache to chrome.storage.local for cross-session survival. */
function flushNoteCache(): void {
  const obj: Record<string, string> = {};
  for (const [k, v] of annotationNoteCache) obj[k] = v;
  const typeObj: Record<string, string> = {};
  for (const [k, v] of annotationTypeCache) typeObj[k] = v;
  chrome.storage.local
    .set({ _oddity_note_cache: obj, _oddity_type_cache: typeObj })
    .catch(() => {});
}

/** Load persisted note cache on init. */
function loadNoteCache(): void {
  chrome.storage.local
    .get(["_oddity_note_cache", "_oddity_type_cache"])
    .then((result) => {
      const cached = result["_oddity_note_cache"] as
        | Record<string, string>
        | undefined;
      if (cached) {
        for (const [k, v] of Object.entries(cached))
          annotationNoteCache.set(k, v);
      }
      const typeCached = result["_oddity_type_cache"] as
        | Record<string, string>
        | undefined;
      if (typeCached) {
        for (const [k, v] of Object.entries(typeCached))
          annotationTypeCache.set(k, v);
      }
    })
    .catch(() => {});
}
loadNoteCache();

/** Index all annotation notes and types so replies can look them up even after ID changes. */
function cacheAnnotationNotes(annotations: Map<string, Annotation[]>): void {
  let added = false;
  for (const [, anns] of annotations) {
    for (const ann of anns) {
      if (!annotationNoteCache.has(ann.id)) {
        annotationNoteCache.set(ann.id, ann.content.note);
        added = true;
      }
      if (!annotationTypeCache.has(ann.id)) {
        annotationTypeCache.set(ann.id, ann.type);
        added = true;
      }
    }
  }
  if (added) flushNoteCache();
}

function findAnnotationNote(
  annotations: Map<string, Annotation[]>,
  annotationId: string,
): string {
  for (const [, anns] of annotations) {
    const ann = anns.find((a) => a.id === annotationId);
    if (ann) return ann.content.note;
  }
  // Fallback: check the persisted note cache (survives annotation regeneration)
  return annotationNoteCache.get(annotationId) ?? "";
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

function findAnnotationType(
  annotations: Map<string, Annotation[]>,
  annotationId: string,
): AnnotationType | undefined {
  for (const [, anns] of annotations) {
    const ann = anns.find((a) => a.id === annotationId);
    if (ann) return ann.type;
  }
  // Fallback: check the persisted type cache
  return annotationTypeCache.get(annotationId) as AnnotationType | undefined;
}

/** Measure card heights and set absolute top positions. Double rAF ensures layout is settled. */
function scheduleLayout(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!listEl) return;
      const GAP = 10;
      let top = GAP;
      const cards = listEl.querySelectorAll<HTMLDivElement>(".arg-card");
      for (const card of cards) {
        card.style.top = `${top}px`;
        top += card.offsetHeight + GAP;
      }
      listEl.style.height = `${top}px`;
      containerEl?.style.setProperty("--panel-width", "300px");
      // Reveal after positioning to prevent the flash where all cards stack at top:0
      listEl.style.visibility = "";
      layoutPending = false;
    });
  });
}

// ─── Onboarding Slideshow ───

function showOnboardingSlideshow(onComplete: () => void): void {
  const dashFace = shadowRoot?.querySelector(".args-dash-face");
  if (!dashFace) {
    onComplete();
    return;
  }

  let currentSlide = -1;
  const TOTAL_SLIDES = 4;
  let animTimers: ReturnType<typeof setTimeout>[] = [];

  // Utility: schedule a timeout and track it for cleanup
  const delay = (fn: () => void, ms: number) => {
    animTimers.push(setTimeout(fn, ms));
  };

  // Utility: typewriter effect — types text into an element one char at a time
  const typewriter = (
    el: HTMLElement,
    text: string,
    charMs: number,
    startMs: number,
    cb?: () => void,
  ) => {
    let i = 0;
    delay(() => {
      const tick = () => {
        if (i < text.length) {
          el.textContent = text.slice(0, ++i);
          delay(tick, charMs);
        } else if (cb) {
          cb();
        }
      };
      tick();
    }, startMs);
  };

  // Build overlay
  const overlay = document.createElement("div");
  overlay.className = "args-onboarding-overlay";
  onboardingOverlayEl = overlay;

  // Skip button
  const skipBtn = document.createElement("button");
  skipBtn.className = "args-onboarding-skip";
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
  });
  overlay.appendChild(skipBtn);

  // Track
  const track = document.createElement("div");
  track.className = "args-onboarding-track";
  track.style.setProperty("--slide-index", "0");

  // ═══════════════════════════════════════════
  // ── Slide 1: Smart Annotations ──
  // ═══════════════════════════════════════════
  const slide1 = document.createElement("div");
  slide1.className = "args-onboarding-slide";

  const vis1 = document.createElement("div");
  vis1.className = "args-onboarding-slide-visual";

  // Mock article text with inline highlighted phrases (matches real annotation look)
  const mockParagraph = document.createElement("div");
  mockParagraph.className = "args-onboarding-paragraph";

  // Each entry: before = plain text, hl = highlighted phrase, after = plain text
  // overview types get bg only, depth types get bg + underline
  const paraLines = [
    {
      before: "The study found that ",
      hl: "renewable energy has accelerated",
      after: " rapidly.",
      color: "#DCAF16",
      label: "CORE CLAIM",
      isOverview: true,
    },
    {
      before: "However, ",
      hl: "infrastructure costs remain high",
      after: " in many regions.",
      color: "#F5574C",
      label: "COUNTERARGUMENT",
      isOverview: false,
    },
    {
      before: "This reflects ",
      hl: "broader shifts in developing nations",
      after: ".",
      color: "#578E6C",
      label: "INSIGHT",
      isOverview: false,
    },
  ];
  const highlightEls: HTMLElement[] = [];
  const labelEls: HTMLElement[] = [];

  for (const pl of paraLines) {
    const lineWrap = document.createElement("div");
    lineWrap.className = "args-onboarding-pline";

    const beforeSpan = document.createElement("span");
    beforeSpan.textContent = pl.before;

    const hlSpan = document.createElement("span");
    hlSpan.className = "args-onboarding-pline-hl";
    hlSpan.style.setProperty("--hl-color", pl.color);
    if (!pl.isOverview) {
      hlSpan.classList.add("has-underline");
    }
    hlSpan.textContent = pl.hl;
    highlightEls.push(hlSpan);

    const afterSpan = document.createElement("span");
    afterSpan.textContent = pl.after;

    const label = document.createElement("span");
    label.className = "args-onboarding-pline-label";
    label.style.color = pl.color;
    label.textContent = pl.label;
    labelEls.push(label);

    lineWrap.appendChild(beforeSpan);
    lineWrap.appendChild(hlSpan);
    lineWrap.appendChild(afterSpan);
    lineWrap.appendChild(label);
    mockParagraph.appendChild(lineWrap);
  }
  vis1.appendChild(mockParagraph);

  const title1 = document.createElement("div");
  title1.className = "args-onboarding-slide-title";
  title1.textContent = "Smart Annotations";
  const body1 = document.createElement("div");
  body1.className = "args-onboarding-slide-body";
  body1.textContent =
    "AI reads what you read and highlights what matters \u2014 color-coded by type.";

  slide1.appendChild(vis1);
  slide1.appendChild(title1);
  slide1.appendChild(body1);
  track.appendChild(slide1);

  function animateSlide1() {
    // Reset
    highlightEls.forEach((h) => h.classList.remove("active"));
    labelEls.forEach((l) => l.classList.remove("active"));
    // Stagger highlights
    for (let i = 0; i < highlightEls.length; i++) {
      delay(
        () => {
          highlightEls[i]!.classList.add("active");
        },
        400 + i * 800,
      );
      delay(
        () => {
          labelEls[i]!.classList.add("active");
        },
        900 + i * 800,
      );
    }
  }

  function resetSlide1() {
    highlightEls.forEach((h) => h.classList.remove("active"));
    labelEls.forEach((l) => l.classList.remove("active"));
  }

  // ═══════════════════════════════════════════
  // ── Slide 2: Meet Your Readers ──
  // ═══════════════════════════════════════════
  const slide2 = document.createElement("div");
  slide2.className = "args-onboarding-slide";

  const vis2 = document.createElement("div");
  vis2.className = "args-onboarding-slide-visual";

  const personas = document.createElement("div");
  personas.className = "args-onboarding-personas";

  const personaData = [
    {
      name: "Terry",
      desc: "Sharp & critical",
      img: "Terry.png",
      quote: "\u201cClear and well-supported.\u201d",
    },
    {
      name: "Jerry",
      desc: "Creative & curious",
      img: "Jerry.png",
      quote: "\u201cBut what about the counter-evidence?\u201d",
    },
    {
      name: "Sally",
      desc: "Engaging & guiding",
      img: "Sally.png",
      quote: "\u201cThis reminds me of\u2026\u201d",
    },
  ];
  const personaWraps: HTMLElement[] = [];
  const speechBubbles: HTMLElement[] = [];

  for (const p of personaData) {
    const wrap = document.createElement("div");
    wrap.className = "args-onboarding-persona";

    const circle = document.createElement("div");
    circle.className = "args-onboarding-persona-circle";
    const img = document.createElement("img");
    img.src = chrome.runtime.getURL(p.img);
    img.alt = p.name;
    circle.appendChild(img);

    const name = document.createElement("div");
    name.className = "args-onboarding-persona-name";
    name.textContent = p.name;

    const desc = document.createElement("div");
    desc.className = "args-onboarding-persona-desc";
    desc.textContent = p.desc;

    const speech = document.createElement("div");
    speech.className = "args-onboarding-speech";
    speech.textContent = p.quote;
    speechBubbles.push(speech);

    wrap.appendChild(circle);
    wrap.appendChild(name);
    wrap.appendChild(desc);
    wrap.appendChild(speech);
    personas.appendChild(wrap);
    personaWraps.push(wrap);
  }
  vis2.appendChild(personas);

  const title2 = document.createElement("div");
  title2.className = "args-onboarding-slide-title";
  title2.textContent = "Meet Your Readers";
  const body2 = document.createElement("div");
  body2.className = "args-onboarding-slide-body";
  body2.textContent =
    "Three AI personas, each with a unique perspective on what you read.";

  slide2.appendChild(vis2);
  slide2.appendChild(title2);
  slide2.appendChild(body2);
  track.appendChild(slide2);

  function animateSlide2() {
    resetSlide2();
    personaWraps.forEach((w, i) => {
      delay(() => w.classList.add("entered"), 300 + i * 250);
    });
    speechBubbles.forEach((s, i) => {
      delay(() => s.classList.add("active"), 900 + i * 350);
    });
  }

  function resetSlide2() {
    personaWraps.forEach((w) => w.classList.remove("entered"));
    speechBubbles.forEach((s) => s.classList.remove("active"));
  }

  // ═══════════════════════════════════════════
  // ── Slide 3: React & Reply ──
  // ═══════════════════════════════════════════
  const slide3 = document.createElement("div");
  slide3.className = "args-onboarding-slide";

  const vis3 = document.createElement("div");
  vis3.className = "args-onboarding-slide-visual";

  const mockCard = document.createElement("div");
  mockCard.className = "args-onboarding-mock-card";

  const mockLabel = document.createElement("div");
  mockLabel.className = "args-onboarding-mock-label";
  mockLabel.textContent = "CORE CLAIM";

  const mockText = document.createElement("div");
  mockText.className = "args-onboarding-mock-text";
  mockText.textContent =
    "\u201cThe study reveals a significant shift in consumer behavior.\u201d";

  const mockActions = document.createElement("div");
  mockActions.className = "args-onboarding-mock-actions";

  const thumbUp = document.createElement("span");
  thumbUp.className = "args-onboarding-mock-thumb";
  thumbUp.textContent = "\uD83D\uDC4D";
  const thumbDown = document.createElement("span");
  thumbDown.className = "args-onboarding-mock-thumb";
  thumbDown.textContent = "\uD83D\uDC4E";

  mockActions.appendChild(thumbUp);
  mockActions.appendChild(thumbDown);

  // Reply input area
  const replyArea = document.createElement("div");
  replyArea.className = "args-onboarding-reply-area";

  const replyBubble = document.createElement("div");
  replyBubble.className = "args-onboarding-reply-bubble";

  const replyInput = document.createElement("div");
  replyInput.className = "args-onboarding-reply-input";

  const replyInputText = document.createElement("span");
  replyInputText.className = "args-onboarding-reply-input-text";

  const replyInputCursor = document.createElement("span");
  replyInputCursor.className = "args-onboarding-cursor";

  replyInput.appendChild(replyInputText);
  replyInput.appendChild(replyInputCursor);
  replyArea.appendChild(replyBubble);
  replyArea.appendChild(replyInput);

  mockCard.appendChild(mockLabel);
  mockCard.appendChild(mockText);
  mockCard.appendChild(mockActions);
  mockCard.appendChild(replyArea);
  vis3.appendChild(mockCard);

  const title3 = document.createElement("div");
  title3.className = "args-onboarding-slide-title";
  title3.textContent = "React & Reply";
  const body3 = document.createElement("div");
  body3.className = "args-onboarding-slide-body";
  body3.textContent =
    "Agree, disagree, or add your own thoughts to any annotation.";

  slide3.appendChild(vis3);
  slide3.appendChild(title3);
  slide3.appendChild(body3);
  track.appendChild(slide3);

  function animateSlide3() {
    resetSlide3();
    // Card slides up
    delay(() => mockCard.classList.add("entered"), 200);
    // Thumb up gets clicked
    delay(() => {
      thumbUp.classList.add("active");
      thumbUp.classList.add("pulse");
      delay(() => thumbUp.classList.remove("pulse"), 300);
    }, 800);
    // Reply input appears and text types in
    delay(() => {
      replyArea.classList.add("active");
      replyInputCursor.classList.add("active");
    }, 1400);
    typewriter(
      replyInputText,
      "I agree, but the sample size is small...",
      50,
      1600,
      () => {
        // After typing, cursor stops blinking and reply bubble appears
        delay(() => {
          replyInputCursor.classList.remove("active");
          replyBubble.textContent = "I agree, but the sample size is small...";
          replyBubble.classList.add("active");
          replyInputText.textContent = "";
        }, 300);
      },
    );
  }

  function resetSlide3() {
    mockCard.classList.remove("entered");
    thumbUp.classList.remove("active", "pulse");
    thumbDown.classList.remove("active");
    replyArea.classList.remove("active");
    replyBubble.classList.remove("active");
    replyBubble.textContent = "";
    replyInputText.textContent = "";
    replyInputCursor.classList.remove("active");
  }

  // ═══════════════════════════════════════════
  // ── Slide 4: Sketch Your Argument ──
  // ═══════════════════════════════════════════
  const slide4 = document.createElement("div");
  slide4.className = "args-onboarding-slide";

  const vis4 = document.createElement("div");
  vis4.className = "args-onboarding-slide-visual";

  const sketchMock = document.createElement("div");
  sketchMock.className = "args-onboarding-sketch-mock";

  // User's reply/reaction cards (float at top, then collapse into sketch)
  const replyCards = document.createElement("div");
  replyCards.className = "args-onboarding-reply-cards";

  const replyCardData = [
    {
      icon: "\uD83D\uDC4D",
      text: "\u201cRenewable energy has accelerated\u201d",
      color: "#DCAF16",
    },
    {
      icon: "\uD83D\uDC4E",
      text: "\u201cInfrastructure costs remain high\u201d",
      color: "#F5574C",
    },
    {
      icon: "\uD83D\uDCAC",
      text: "Sample size is small\u2026",
      color: "#748DBF",
    },
  ];
  const replyCardEls: HTMLElement[] = [];
  for (const rc of replyCardData) {
    const card = document.createElement("div");
    card.className = "args-onboarding-reply-card";
    card.style.setProperty("--card-color", rc.color);

    const icon = document.createElement("span");
    icon.className = "args-onboarding-reply-card-icon";
    icon.textContent = rc.icon;

    const text = document.createElement("span");
    text.className = "args-onboarding-reply-card-text";
    text.textContent = rc.text;

    card.appendChild(icon);
    card.appendChild(text);
    replyCards.appendChild(card);
    replyCardEls.push(card);
  }

  // Sketch button
  const sketchBtn = document.createElement("div");
  sketchBtn.className = "args-onboarding-sketch-btn";
  sketchBtn.textContent = "Sketch my Argument";

  // Sketch output
  const sketchOutput = document.createElement("div");
  sketchOutput.className = "args-onboarding-sketch-output";

  const sketchLines = [
    "The article argues that renewable energy adoption has accelerated beyond projections.",
    "You agreed with the core claim but flagged that infrastructure costs remain a barrier.",
    "You also noted the small sample size, suggesting cautious optimism over the findings.",
  ];
  const sketchInner = document.createElement("div");
  sketchInner.className = "args-onboarding-sketch-inner";
  const sketchLineEls: HTMLElement[] = [];
  for (let i = 0; i < sketchLines.length; i++) {
    const line = document.createElement("div");
    line.className = "args-onboarding-sketch-line";
    sketchLineEls.push(line);
    sketchInner.appendChild(line);
  }
  sketchOutput.appendChild(sketchInner);

  sketchMock.appendChild(replyCards);
  sketchMock.appendChild(sketchBtn);
  sketchMock.appendChild(sketchOutput);
  vis4.appendChild(sketchMock);

  const title4 = document.createElement("div");
  title4.className = "args-onboarding-slide-title";
  title4.textContent = "Sketch Your Argument";
  const body4 = document.createElement("div");
  body4.className = "args-onboarding-slide-body";
  body4.textContent =
    "Your reactions and replies compile into a coherent argument.";

  slide4.appendChild(vis4);
  slide4.appendChild(title4);
  slide4.appendChild(body4);
  track.appendChild(slide4);

  function animateSlide4() {
    resetSlide4();
    // 1. Reply cards appear staggered
    replyCardEls.forEach((c, i) => {
      delay(() => c.classList.add("entered"), 300 + i * 250);
    });
    // 2. Button pulses (as if clicked)
    delay(() => sketchBtn.classList.add("pulse"), 1200);
    delay(() => sketchBtn.classList.remove("pulse"), 1500);
    // 3. Reply cards collapse/fade out
    delay(() => {
      replyCardEls.forEach((c) => c.classList.add("collapsed"));
    }, 1600);
    // 4. Output area expands
    delay(() => sketchOutput.classList.add("active"), 2000);
    // 5. Stream text line by line
    let startTime = 2400;
    for (let i = 0; i < sketchLines.length; i++) {
      const lineText = sketchLines[i]!;
      const lineEl = sketchLineEls[i]!;
      typewriter(lineEl, lineText, 20, startTime);
      startTime += lineText.length * 20 + 200;
    }
  }

  function resetSlide4() {
    sketchBtn.classList.remove("pulse");
    sketchOutput.classList.remove("active");
    sketchLineEls.forEach((el) => {
      el.textContent = "";
    });
    replyCardEls.forEach((c) => c.classList.remove("entered", "collapsed"));
  }

  overlay.appendChild(track);

  // ═══════════════════════════════════════════
  // ── Navigation ──
  // ═══════════════════════════════════════════
  const nav = document.createElement("div");
  nav.className = "args-onboarding-nav";

  const dots = document.createElement("div");
  dots.className = "args-onboarding-dots";
  const dotEls: HTMLButtonElement[] = [];
  for (let i = 0; i < TOTAL_SLIDES; i++) {
    const dot = document.createElement("button");
    dot.className = `args-onboarding-dot${i === 0 ? " active" : ""}`;
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      goToSlide(i);
    });
    dots.appendChild(dot);
    dotEls.push(dot);
  }
  nav.appendChild(dots);

  const nextBtn = document.createElement("button");
  nextBtn.className = "args-onboarding-next";
  nextBtn.textContent = "Next";
  nextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (currentSlide === TOTAL_SLIDES - 1) {
      dismiss();
    } else {
      goToSlide(currentSlide + 1);
    }
  });
  nav.appendChild(nextBtn);
  overlay.appendChild(nav);

  // ── Animation lifecycle ──
  const animStarters = [
    animateSlide1,
    animateSlide2,
    animateSlide3,
    animateSlide4,
  ];
  const animResetters = [resetSlide1, resetSlide2, resetSlide3, resetSlide4];

  function clearAnimTimers() {
    animTimers.forEach((t) => clearTimeout(t));
    animTimers = [];
  }

  function goToSlide(index: number): void {
    if (index < 0 || index >= TOTAL_SLIDES) return;
    // Stop current animation
    clearAnimTimers();
    if (currentSlide >= 0) animResetters[currentSlide]!();
    // Move to new slide
    currentSlide = index;
    track.style.setProperty("--slide-index", String(index));
    dotEls.forEach((d, i) => d.classList.toggle("active", i === index));
    nextBtn.textContent = index === TOTAL_SLIDES - 1 ? "Start Thinking" : "Next";
    // Start animation for new slide (slight delay to let slide transition finish)
    delay(() => animStarters[index]!(), 350);
  }

  function dismiss(): void {
    clearAnimTimers();
    overlay.style.opacity = "0";
    overlay.addEventListener(
      "transitionend",
      () => {
        overlay.remove();
        onboardingOverlayEl = null;
        onComplete();
      },
      { once: true },
    );
  }

  // ── Keyboard nav ──
  overlay.tabIndex = 0;
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "Enter") {
      e.stopPropagation();
      if (currentSlide === TOTAL_SLIDES - 1) dismiss();
      else goToSlide(currentSlide + 1);
    } else if (e.key === "ArrowLeft") {
      e.stopPropagation();
      goToSlide(currentSlide - 1);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      dismiss();
    }
  });

  // Click on overlay shouldn't toggle the container
  overlay.addEventListener("click", (e) => e.stopPropagation());

  // Append, fade in, and start first slide animation
  dashFace.appendChild(overlay);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.classList.add("visible");
      overlay.focus();
      goToSlide(0);
    });
  });
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

/** Fingerprint of the last rendered item set — skip no-op rebuilds. */
let lastRenderedKey = "";

function renderList(): void {
  if (!listEl) return;

  const allItems = [...canonicalItems, ...liveItems];

  // Skip rebuild if the item set hasn't changed (avoids glitchy DOM teardown/rebuild)
  const itemKey = allItems
    .map((i) => i.sortKey + (i.feedbackId ?? ""))
    .join("|");
  if (itemKey === lastRenderedKey) return;
  lastRenderedKey = itemKey;

  // Hide list during rebuild to prevent the flash where cards stack at top:0
  // before scheduleLayout positions them. Visibility is restored in scheduleLayout.
  listEl.style.visibility = "hidden";

  listEl.innerHTML = "";
  expandedCardId = null;

  if (allItems.length === 0) {
    listEl.style.visibility = "";
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

    // Apply annotation-specific color for non-manual items
    if (item.annotationType && item.type !== "manual") {
      const theme = getThemeMode();
      const color = getAnnotationColor(item.annotationType, theme);
      card.style.setProperty("--arg-card-color", color);
      card.classList.add("arg-card--colored");
      // Yellow notes need dark text for readability
      if (color === "#FFDD69" || color === "#DCAF16") {
        card.classList.add("arg-card--yellow");
      }
    }

    // Label (1 line max, like note-label)
    const header = document.createElement("div");
    header.className = "arg-card-header";
    if (item.type === "reply") {
      header.textContent = item.replyHeader
        ? `Reply to \u201c${item.replyHeader}\u201d`
        : "Reply";
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

    // Reply input bar ("Add a note...")
    const replyBar = document.createElement("div");
    replyBar.className = "note-reply-bar";
    const replyInput = document.createElement("input");
    replyInput.type = "text";
    replyInput.placeholder = "Add a note...";
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
        chrome.runtime
          .sendMessage({
            action: "saveFeedback",
            payload: {
              annotationId: item.annotationId,
              contentHash: item.contentHash ?? "",
              url: getPageUrl(),
              feedbackType: "reply",
              replyText: text,
              pageTitle: document.title,
            },
          })
          .then((fb: any) => {
            if (fb?.id) {
              bubble.dataset.feedbackId = fb.id;
              window.dispatchEvent(
                new CustomEvent("oddity:feedback-added", {
                  detail: { feedback: fb, contentHash: item.contentHash ?? "" },
                }),
              );
            }
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
    sendBtn.innerHTML = `<span class="arrow-light"><svg width="10" height="13" viewBox="0 0 12 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.05377 0.219671C5.76087 -0.0732222 5.286 -0.0732222 4.99311 0.219671L0.220136 4.99264C-0.0727572 5.28553 -0.0727572 5.76041 0.220136 6.0533C0.51303 6.3462 0.987903 6.3462 1.2808 6.0533L5.52344 1.81066L9.76608 6.0533C10.059 6.3462 10.5338 6.3462 10.8267 6.0533C11.1196 5.76041 11.1196 5.28553 10.8267 4.99264L6.05377 0.219671ZM5.52344 15.75H6.27344L6.27344 0.750001H5.52344H4.77344L4.77344 15.75H5.52344Z" fill="white"/></svg></span><span class="arrow-dark"><svg width="10" height="13" viewBox="0 0 12 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.05377 0.219671C5.76087 -0.0732222 5.286 -0.0732222 4.99311 0.219671L0.220136 4.99264C-0.0727572 5.28553 -0.0727572 5.76041 0.220136 6.0533C0.51303 6.3462 0.987903 6.3462 1.2808 6.0533L5.52344 1.81066L9.76608 6.0533C10.059 6.3462 10.5338 6.3462 10.8267 6.0533C11.1196 5.76041 11.1196 5.28553 10.8267 4.99264L6.05377 0.219671ZM5.52344 15.75H6.27344L6.27344 0.750001H5.52344H4.77344L4.77344 15.75H5.52344Z" fill="#293038"/></svg></span>`;
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
    const goToBtn = document.createElement("button");
    goToBtn.className = "note-feedback-pill note-goto-pill";
    goToBtn.textContent = "Go to highlight ↗";
    goToBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.annotationId) {
        document.dispatchEvent(
          new CustomEvent("oddity:scroll-to-annotation", {
            detail: { annotationId: item.annotationId, itemType: item.type },
          }),
        );
      }
    });
    pillGroup.appendChild(goToBtn);

    const iconGroup = document.createElement("div");
    iconGroup.className = "note-icon-group";
    const editBtn = document.createElement("button");
    editBtn.className = "note-icon-btn note-edit-btn";
    editBtn.title = "Edit";
    editBtn.innerHTML = `<span class="icon-dark"><svg width="18" height="18" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18.1641 1.33105C19.7393 -0.243794 22.2929 -0.243751 23.8682 1.33105C25.4435 2.90636 25.4435 5.46083 23.8682 7.03613L8.41699 22.4883C7.76597 23.1393 6.94983 23.6009 6.05664 23.8242L1.26465 25.0225C0.608468 25.1865 0.0136891 24.5917 0.177734 23.9355L1.37598 19.1436C1.59927 18.2504 2.0609 17.4342 2.71191 16.7832L18.1641 1.33105ZM16.4727 5.55664L3.97949 18.0508C3.55812 18.4722 3.25879 19 3.11426 19.5781L2.33887 22.6787L2.27832 22.9219L5.62207 22.0859C6.20018 21.9414 6.72804 21.6421 7.14941 21.2207L13.3965 14.9736L19.6426 8.72656L19.748 8.62109L19.6426 8.51465L16.5781 5.4502L16.4727 5.55664ZM22.6016 2.59863C21.726 1.72311 20.3062 1.72311 19.4307 2.59863L17.8457 4.18359L17.9512 4.29004L20.9092 7.24805L21.0156 7.35352L21.1211 7.24805L22.6016 5.76953C23.4771 4.89404 23.477 3.47416 22.6016 2.59863Z" fill="white" stroke="#363636" stroke-width="0.3"/></svg></span><span class="icon-light"><svg width="18" height="18" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18.1641 1.33105C19.7393 -0.243794 22.2929 -0.243751 23.8682 1.33105C25.4435 2.90636 25.4435 5.46083 23.8682 7.03613L8.41699 22.4883C7.76597 23.1393 6.94983 23.6009 6.05664 23.8242L1.26465 25.0225C0.608468 25.1865 0.0136891 24.5917 0.177734 23.9355L1.37598 19.1436C1.59927 18.2504 2.0609 17.4342 2.71191 16.7832L18.1641 1.33105ZM16.4727 5.55664L3.97949 18.0508C3.55812 18.4722 3.25879 19 3.11426 19.5781L2.33887 22.6787L2.27832 22.9219L5.62207 22.0859C6.20018 21.9414 6.72804 21.6421 7.14941 21.2207L13.3965 14.9736L19.6426 8.72656L19.748 8.62109L19.6426 8.51465L16.5781 5.4502L16.4727 5.55664ZM22.6016 2.59863C21.726 1.72311 20.3062 1.72311 19.4307 2.59863L17.8457 4.18359L17.9512 4.29004L20.9092 7.24805L21.0156 7.35352L21.1211 7.24805L22.6016 5.76953C23.4771 4.89404 23.477 3.47416 22.6016 2.59863Z" fill="#293038" stroke="white" stroke-width="0.3"/></svg></span>`;
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
              payload: {
                feedbackId: item.feedbackId,
                replyText: newText,
                contentHash: item.contentHash,
                url: getPageUrl(),
              },
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
          chrome.runtime
            .sendMessage({
              action: "updateAnnotation",
              payload: {
                annotationId: item.annotationId,
                annotation: updatedAnnotation,
                url: getPageUrl(),
                contentHash: item.contentHash ?? "",
                pageTitle: document.title,
              },
            })
            .catch(() => {});
          item.text = newText;
          item.annotation = updatedAnnotation;
          body.textContent = newText;
          document.dispatchEvent(
            new CustomEvent("oddity:annotation-edited", {
              detail: {
                annotationId: item.annotationId,
                note: newText,
                contentHash: item.contentHash,
              },
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
    deleteBtn.innerHTML = `<span class="icon-dark"><svg width="15" height="19" viewBox="0 0 22 27" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18.9219 7.43945C19.5106 7.28746 20.0695 7.65114 20.1689 8.25781C20.1871 8.36904 20.1904 8.48758 20.1904 8.61621C20.1916 12.9442 20.1921 17.2726 20.1914 21.6006C20.191 23.8874 18.6924 25.7032 16.4473 26.127C16.1796 26.1775 15.898 26.1959 15.6172 26.1963C12.4044 26.2013 9.19156 26.2003 5.97852 26.1992C3.69159 26.1985 1.85256 24.6628 1.45312 22.418C1.41441 22.2002 1.39474 21.976 1.39453 21.7549C1.39094 17.3332 1.39019 12.9109 1.39355 8.48926C1.3939 8.11363 1.54191 7.815 1.7627 7.62891C1.98301 7.44332 2.28797 7.35899 2.62695 7.43457C3.04346 7.52748 3.36132 7.89535 3.39258 8.32715C3.39929 8.42013 3.3955 8.50965 3.39551 8.62207C3.39566 12.6316 3.39648 16.6411 3.39648 20.6787H3.39551L3.39648 20.6855C3.41225 21.17 3.37743 21.7036 3.45996 22.1953C3.65247 23.341 4.68451 24.1899 5.83789 24.1924C9.13566 24.1995 12.4336 24.1998 15.7314 24.1924C17.1037 24.1893 18.1861 23.0585 18.1865 21.6758C18.188 17.2823 18.1867 12.8885 18.1875 8.49512C18.1876 7.94499 18.484 7.55251 18.9219 7.43945Z" fill="white" stroke="#363636" stroke-width="0.4"/><path d="M7.26953 0.203125C9.62027 0.198508 11.9716 0.199014 14.3223 0.204102C14.6616 0.204899 14.922 0.314719 15.0977 0.492188C15.2735 0.670059 15.3822 0.934127 15.3848 1.27637C15.3898 1.9497 15.3867 2.62192 15.3867 3.29785V3.7998H15.9141C17.3757 3.79981 18.8361 3.79648 20.2969 3.80078C20.9586 3.80273 21.3942 4.24054 21.3867 4.82031C21.3799 5.3401 20.9666 5.77238 20.4453 5.80176C20.3502 5.8071 20.2583 5.80371 20.1475 5.80371H1.2666C0.639678 5.80015 0.20525 5.37415 0.200195 4.81543C0.195178 4.24231 0.62806 3.8045 1.26758 3.80176C2.72789 3.7955 4.1877 3.79982 5.64941 3.7998H6.1709L6.18359 3.61328C6.18866 3.53651 6.20002 3.43702 6.2002 3.34961C6.20145 2.65408 6.19707 1.96406 6.20215 1.27148C6.20465 0.931308 6.31364 0.668386 6.49023 0.491211C6.66684 0.314264 6.92879 0.203859 7.26953 0.203125ZM8.20312 3.7998H13.3838V2.21973H8.20312V3.7998Z" fill="white" stroke="#363636" stroke-width="0.4"/><path d="M8.31055 9.80664C8.83083 9.76813 9.2791 10.1133 9.37012 10.627C9.39137 10.7472 9.3973 10.8761 9.39746 11.0117C9.39941 12.7069 9.39844 14.4024 9.39844 16.126C9.39842 17.149 9.40636 18.1395 9.39648 19.1309C9.38809 19.9463 8.64467 20.4191 7.97754 20.1025C7.76977 20.0039 7.62709 19.8731 7.53516 19.7178C7.44262 19.5613 7.39442 19.3667 7.39453 19.1309C7.39576 16.499 7.39446 13.8671 7.39453 11.2354C7.39454 11.0691 7.39044 10.9185 7.39648 10.7646C7.41659 10.2586 7.81791 9.84333 8.31055 9.80664Z" fill="white" stroke="#363636" stroke-width="0.4"/><path d="M13.0742 9.80664C13.5841 9.74797 14.0478 10.0748 14.165 10.5918C14.1862 10.6852 14.1894 10.7898 14.1895 10.9092C14.1911 13.6331 14.189 16.3586 14.1934 19.083C14.1937 19.3328 14.1473 19.5393 14.0547 19.7041C13.9635 19.8663 13.8198 20.0013 13.6016 20.1006C13.3815 20.2006 13.1833 20.2215 13.001 20.1826C12.8191 20.1437 12.6362 20.0418 12.4521 19.8672C12.2593 19.6446 12.1865 19.3976 12.1865 19.1094C12.1869 16.3662 12.1849 13.6236 12.1885 10.8809C12.1893 10.2842 12.5612 9.86575 13.0742 9.80664Z" fill="white" stroke="#363636" stroke-width="0.4"/></svg></span><span class="icon-light"><svg width="15" height="19" viewBox="0 0 22 27" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18.9219 7.43945C19.5106 7.28746 20.0695 7.65114 20.1689 8.25781C20.1871 8.36904 20.1904 8.48758 20.1904 8.61621C20.1916 12.9442 20.1921 17.2726 20.1914 21.6006C20.191 23.8874 18.6924 25.7032 16.4473 26.127C16.1796 26.1775 15.898 26.1959 15.6172 26.1963C12.4044 26.2013 9.19156 26.2003 5.97852 26.1992C3.69159 26.1985 1.85256 24.6628 1.45312 22.418C1.41441 22.2002 1.39474 21.976 1.39453 21.7549C1.39094 17.3332 1.39019 12.9109 1.39355 8.48926C1.3939 8.11363 1.54191 7.815 1.7627 7.62891C1.98301 7.44332 2.28797 7.35899 2.62695 7.43457C3.04346 7.52748 3.36132 7.89535 3.39258 8.32715C3.39929 8.42013 3.3955 8.50965 3.39551 8.62207C3.39566 12.6316 3.39648 16.6411 3.39648 20.6787H3.39551L3.39648 20.6855C3.41225 21.17 3.37743 21.7036 3.45996 22.1953C3.65247 23.341 4.68451 24.1899 5.83789 24.1924C9.13566 24.1995 12.4336 24.1998 15.7314 24.1924C17.1037 24.1893 18.1861 23.0585 18.1865 21.6758C18.188 17.2823 18.1867 12.8885 18.1875 8.49512C18.1876 7.94499 18.484 7.55251 18.9219 7.43945Z" fill="#293038" stroke="white" stroke-width="0.4"/><path d="M7.26953 0.203125C9.62027 0.198508 11.9716 0.199014 14.3223 0.204102C14.6616 0.204899 14.922 0.314719 15.0977 0.492188C15.2735 0.670059 15.3822 0.934127 15.3848 1.27637C15.3898 1.9497 15.3867 2.62192 15.3867 3.29785V3.7998H15.9141C17.3757 3.79981 18.8361 3.79648 20.2969 3.80078C20.9586 3.80273 21.3942 4.24054 21.3867 4.82031C21.3799 5.3401 20.9666 5.77238 20.4453 5.80176C20.3502 5.8071 20.2583 5.80371 20.1475 5.80371H1.2666C0.639678 5.80015 0.20525 5.37415 0.200195 4.81543C0.195178 4.24231 0.62806 3.8045 1.26758 3.80176C2.72789 3.7955 4.1877 3.79982 5.64941 3.7998H6.1709L6.18359 3.61328C6.18866 3.53651 6.20002 3.43702 6.2002 3.34961C6.20145 2.65408 6.19707 1.96406 6.20215 1.27148C6.20465 0.931308 6.31364 0.668386 6.49023 0.491211C6.66684 0.314264 6.92879 0.203859 7.26953 0.203125ZM8.20312 3.7998H13.3838V2.21973H8.20312V3.7998Z" fill="#293038" stroke="white" stroke-width="0.4"/><path d="M8.31055 9.80664C8.83083 9.76813 9.2791 10.1133 9.37012 10.627C9.39137 10.7472 9.3973 10.8761 9.39746 11.0117C9.39941 12.7069 9.39844 14.4024 9.39844 16.126C9.39842 17.149 9.40636 18.1395 9.39648 19.1309C9.38809 19.9463 8.64467 20.4191 7.97754 20.1025C7.76977 20.0039 7.62709 19.8731 7.53516 19.7178C7.44262 19.5613 7.39442 19.3667 7.39453 19.1309C7.39576 16.499 7.39446 13.8671 7.39453 11.2354C7.39454 11.0691 7.39044 10.9185 7.39648 10.7646C7.41659 10.2586 7.81791 9.84333 8.31055 9.80664Z" fill="#293038" stroke="white" stroke-width="0.4"/><path d="M13.0742 9.80664C13.5841 9.74797 14.0478 10.0748 14.165 10.5918C14.1862 10.6852 14.1894 10.7898 14.1895 10.9092C14.1911 13.6331 14.189 16.3586 14.1934 19.083C14.1937 19.3328 14.1473 19.5393 14.0547 19.7041C13.9635 19.8663 13.8198 20.0013 13.6016 20.1006C13.3815 20.2006 13.1833 20.2215 13.001 20.1826C12.8191 20.1437 12.6362 20.0418 12.4521 19.8672C12.2593 19.6446 12.1865 19.3976 12.1865 19.1094C12.1869 16.3662 12.1849 13.6236 12.1885 10.8809C12.1893 10.2842 12.5612 9.86575 13.0742 9.80664Z" fill="#293038" stroke="white" stroke-width="0.4"/></svg></span>`;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const removeBySortKey = () => {
        canonicalItems = canonicalItems.filter(
          (i) => i.sortKey !== item.sortKey,
        );
        liveItems = liveItems.filter((i) => i.sortKey !== item.sortKey);
      };
      if (item.feedbackId) {
        deletedFeedbackIds.add(item.feedbackId);
        chrome.runtime
          .sendMessage({
            action: "deleteFeedback",
            payload: {
              feedbackId: item.feedbackId,
              contentHash: item.contentHash,
              url: getPageUrl(),
            },
          })
          .catch(() => {});
        canonicalItems = canonicalItems.filter(
          (i) => i.feedbackId !== item.feedbackId,
        );
        liveItems = liveItems.filter((i) => i.feedbackId !== item.feedbackId);
        document.dispatchEvent(
          new CustomEvent("oddity:feedback-deleted", {
            detail: {
              feedbackId: item.feedbackId,
              annotationId: item.annotationId,
            },
          }),
        );
      } else if (item.annotationId) {
        deletedAnnotationIds.add(item.annotationId);
        chrome.runtime
          .sendMessage({
            action: "deleteAnnotation",
            payload: {
              annotationId: item.annotationId,
              url: getPageUrl(),
              contentHash: item.contentHash ?? "",
            },
          })
          .catch(() => {});
        canonicalItems = canonicalItems.filter(
          (i) => i.annotationId !== item.annotationId,
        );
        liveItems = liveItems.filter(
          (i) => i.annotationId !== item.annotationId,
        );
        document.dispatchEvent(
          new CustomEvent("oddity:annotation-deleted", {
            detail: { annotationId: item.annotationId },
          }),
        );
      } else {
        // Live items without feedbackId/annotationId — remove by sortKey
        removeBySortKey();
      }
      renderList();
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

    // Double-click: scroll to the linked highlight in the text
    card.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if ((e.target as HTMLElement).closest("button, input, textarea")) return;
      if (item.annotationId) {
        document.dispatchEvent(
          new CustomEvent("oddity:scroll-to-annotation", {
            detail: { annotationId: item.annotationId },
          }),
        );
      }
    });

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
  // Only layout if the container is expanded; otherwise defer until it opens
  // (measuring at 56px collapsed width produces incorrect tall card heights).
  if (expanded) {
    scheduleLayout();
  } else {
    layoutPending = true;
  }
}

// ─── Tab Switching ───

function switchTab(tab: "notes" | "sketch"): void {
  activeTab = tab;
  if (notesTabBtn)
    notesTabBtn.className = tab === "notes" ? "args-tab active" : "args-tab";
  if (sketchTabBtn)
    sketchTabBtn.className = tab === "sketch" ? "args-tab active" : "args-tab";
  if (listEl) listEl.style.display = tab === "notes" ? "" : "none";
  if (footerEl) footerEl.style.display = tab === "notes" ? "" : "none";
  if (sketchContentEl)
    sketchContentEl.style.display = tab === "sketch" ? "" : "none";
}

// ─── Sketch Handler ───

function handleSketch(): void {
  if (sketchLoading) return;

  // Gate: Sketch Pad requires Standard plan
  if (dashUserTier !== "standard") {
    if (sketchContentEl) {
      switchTab("sketch");
      const errorDiv = document.createElement("div");
      errorDiv.className = "args-sketch-error";
      const msg = document.createTextNode(
        "Sketch Pad requires a Standard plan. ",
      );
      const link = document.createElement("a");
      link.href = "https://app.oddity1.com/plans";
      link.target = "_blank";
      link.style.color = "#22c55e";
      link.style.textDecoration = "underline";
      link.textContent = "Get Standard";
      errorDiv.appendChild(msg);
      errorDiv.appendChild(link);
      sketchContentEl.replaceChildren(errorDiv);
    }
    return;
  }

  // Validate purpose
  const purpose = purposeInputEl?.value.trim() ?? "";
  if (!purpose) {
    if (purposeInputEl) {
      purposeInputEl.classList.add("args-purpose-error");
      purposeInputEl.placeholder = "Please fill in your purpose first";
      purposeInputEl.focus();
    }
    return;
  }

  // Get input text
  const inputText = inputTextProviderCb?.() ?? "";
  if (!inputText) return;

  // Compile user reactions with full context (same format as copy button)
  const allItems = [...canonicalItems, ...liveItems];
  const userReactions = allItems.map((i) => formatItemPlain(i)).join("\n\n");

  // Disable button, switch to sketch tab, show loading
  sketchLoading = true;
  sketchBuffer = "";
  if (sketchBtnEl) {
    sketchBtnEl.disabled = true;
    sketchBtnEl.textContent = "Sketching...";
  }
  if (sketchContentEl) {
    sketchContentEl.innerHTML =
      '<div class="args-sketch-loading"><span></span><span></span><span></span></div>';
  }
  switchTab("sketch");

  // Send request to background
  chrome.runtime
    .sendMessage({
      action: "requestSketch",
      payload: { inputText, purpose, userReactions },
    })
    .catch(() => {
      sketchLoading = false;
      if (sketchBtnEl) {
        sketchBtnEl.disabled = false;
        sketchBtnEl.textContent = "Sketch my Argument";
      }
      if (sketchContentEl) {
        sketchContentEl.innerHTML =
          '<div class="args-sketch-error">Failed to generate sketch. Please try again.</div>';
      }
    });
}

// ─── Copy & Label Helpers ───

/** Short display label for an argument item (used in the UI list). */
function getLabel(item: ArgumentItem): string {
  if (item.type === "reply") {
    return item.replyHeader
      ? `Reply to \u201c${item.replyHeader}\u201d`
      : "Reply";
  }
  const src = item.quote || item.text;
  const MAX = 60;
  return src.length > MAX
    ? `\u201c${src.slice(0, MAX)}\u2026\u201d`
    : `\u201c${src}\u201d`;
}

/**
 * Format a single item as rich plain text for copy / sketch export.
 * Includes the full annotation note and anchor text for context.
 */
function formatItemPlain(item: ArgumentItem): string {
  if (item.type === "reply") {
    const lines: string[] = [];
    // Header: what annotation the user replied to
    lines.push(
      `Reply to annotation: \u201c${item.replyFullNote || item.replyHeader || ""}\u201d`,
    );
    if (item.replyAnchor) {
      lines.push(`Anchor (highlighted text): \u201c${item.replyAnchor}\u201d`);
    }
    lines.push(`User's response: ${item.text}`);
    return lines.join("\n");
  }
  // manual (user-written note)
  const lines: string[] = [];
  lines.push("User-written note");
  if (item.quote) {
    lines.push(`Anchor (highlighted text): \u201c${item.quote}\u201d`);
  }
  lines.push(`Note: ${item.text}`);
  return lines.join("\n");
}

/**
 * Format a single item as HTML for rich clipboard copy.
 */
function formatItemHtml(item: ArgumentItem): string {
  if (item.type === "reply") {
    const parts: string[] = [];
    parts.push(
      `<b>Reply to annotation:</b> \u201c${escapeHtml(item.replyFullNote || item.replyHeader || "")}\u201d`,
    );
    if (item.replyAnchor) {
      parts.push(`<i>Anchor:</i> \u201c${escapeHtml(item.replyAnchor)}\u201d`);
    }
    parts.push(`<b>User\u2019s response:</b> ${escapeHtml(item.text)}`);
    return parts.join("<br>");
  }
  const parts: string[] = [];
  parts.push("<b>User-written note</b>");
  if (item.quote) {
    parts.push(`<i>Anchor:</i> \u201c${escapeHtml(item.quote)}\u201d`);
  }
  parts.push(`<b>Note:</b> ${escapeHtml(item.text)}`);
  return parts.join("<br>");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal markdown → HTML renderer (bold, bullets, line breaks). */
function renderMarkdown(md: string): string {
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return (
    escaped
      // Bold: **text**
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      // Bullet lines: - item or * item
      .replace(/^[\-\*]\s+(.+)$/gm, "<li>$1</li>")
      // Wrap consecutive <li> in <ul>
      .replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
      // Line breaks
      .replace(/\n/g, "<br>")
  );
}

function handleCopy(btn: HTMLButtonElement): void {
  let plainText: string;
  let html: string;

  if (activeTab === "sketch" && sketchBuffer) {
    plainText = sketchBuffer;
    html = renderMarkdown(sketchBuffer);
  } else {
    const allItems = [...canonicalItems, ...liveItems];
    plainText = allItems.map((i) => formatItemPlain(i)).join("\n\n");
    html = allItems.map((i) => formatItemHtml(i)).join("<br><br>");
  }

  const blob = new Blob([html], { type: "text/html" });
  const textBlob = new Blob([plainText], { type: "text/plain" });
  navigator.clipboard
    .write([new ClipboardItem({ "text/html": blob, "text/plain": textBlob })])
    .then(() => {
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 1500);
    });
}

// ─── Mode Toggle (inside FAB) ───

/** Position the mode toggle: next to FAB when collapsed, inside the top bar when expanded. */
function syncModeTogglePosition(): void {
  if (!modeToggleWrapperEl || !containerEl || !modeToggleEl) return;
  if (expanded && topBarEl) {
    // Move toggle into the top bar
    if (modeToggleWrapperEl.parentElement !== topBarEl) {
      topBarEl.insertBefore(modeToggleWrapperEl, topBarEl.firstChild);
    }
    modeToggleEl.classList.add("with-close");
    modeToggleWrapperEl.style.top = "";
    modeToggleWrapperEl.style.left = "";
    modeToggleWrapperEl.style.transform = "";
    modeToggleWrapperEl.style.transformOrigin = "";
    modeToggleWrapperEl.style.position = "static";
  } else if (outerWrapperEl) {
    // Move toggle back to outerWrapper (next to FAB)
    if (modeToggleWrapperEl.parentElement !== outerWrapperEl) {
      outerWrapperEl.insertBefore(modeToggleWrapperEl, containerEl);
    }
    modeToggleEl.classList.remove("with-close");
    modeToggleWrapperEl.style.position = "absolute";
    const toggleH =
      modeToggleWrapperEl.offsetHeight > 0
        ? modeToggleWrapperEl.offsetHeight
        : 34;
    const toggleW =
      modeToggleWrapperEl.offsetWidth > 0
        ? modeToggleWrapperEl.offsetWidth
        : 150;
    const fabH = 56;
    const topOffset = (fabH - toggleH) / 2 + 4;
    modeToggleWrapperEl.style.top = `${topOffset}px`;
    modeToggleWrapperEl.style.left = `${-(toggleW + 10)}px`;
  }
}

/** Size and position the slider highlight to match the active button.
 *  Uses offsetLeft/offsetWidth which are immune to CSS transforms. */
function syncModeToggleSlider(): void {
  if (
    !modeToggleEl ||
    !modeToggleSliderEl ||
    !modeToggleOverviewBtn ||
    !modeToggleDepthBtn
  )
    return;
  const activeBtn =
    modeToggleEl.dataset.active === "depth"
      ? modeToggleDepthBtn
      : modeToggleOverviewBtn;
  if (activeBtn.offsetWidth === 0) return; // not laid out yet
  modeToggleSliderEl.style.left = `${activeBtn.offsetLeft}px`;
  modeToggleSliderEl.style.width = `${activeBtn.offsetWidth}px`;
}

function initModeToggleOverlay(): void {
  if (modeToggleWrapperEl || !outerWrapperEl || !shadowRoot) return;

  modeToggleWrapperEl = document.createElement("div");
  modeToggleWrapperEl.className = "args-mode-toggle-wrapper";
  modeToggleWrapperEl.style.display = "none";

  modeToggleEl = document.createElement("div");
  modeToggleEl.className = "mode-toggle";
  modeToggleEl.dataset.active = "overview";

  modeToggleSliderEl = document.createElement("div");
  modeToggleSliderEl.className = "mode-slider";

  modeToggleOverviewBtn = document.createElement("button");
  modeToggleOverviewBtn.className = "mode-btn mode-active";
  modeToggleOverviewBtn.textContent = "Overview";
  modeToggleOverviewBtn.dataset.mode = "overview";

  modeToggleDepthBtn = document.createElement("button");
  modeToggleDepthBtn.className = "mode-btn";
  modeToggleDepthBtn.textContent = "Depth";
  modeToggleDepthBtn.dataset.mode = "depth";

  modeToggleEl.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    if (!extensionEnabled) return; // Do nothing when Oddity 1 is off
    const target = (e.target as HTMLElement).closest(
      "[data-mode]",
    ) as HTMLElement | null;
    if (!target || !modeToggleEl) return;
    const mode = target.dataset.mode as string;
    if (mode === modeToggleEl.dataset.active) return;
    modeToggleOverviewBtn!.classList.toggle("mode-active", mode === "overview");
    modeToggleDepthBtn!.classList.toggle("mode-active", mode === "depth");
    modeToggleEl.dataset.active = mode;
    syncModeToggleSlider();
    document.dispatchEvent(
      new CustomEvent("oddity:modeChange", { detail: { mode } }),
    );
  });

  // Close button lives inside the toggle as a third grid column (visible only when expanded)
  const modeCloseBtnEl = document.createElement("button");
  modeCloseBtnEl.className = "mode-close-btn";
  modeCloseBtnEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 12 12" fill="none"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  modeCloseBtnEl.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    if (expanded) {
      if (dimmed) {
        toggleDimmedPanel();
      } else {
        toggle();
      }
    }
  });

  modeToggleEl.appendChild(modeToggleSliderEl);
  modeToggleEl.appendChild(modeToggleOverviewBtn);
  modeToggleEl.appendChild(modeToggleDepthBtn);
  modeToggleEl.appendChild(modeCloseBtnEl);
  modeToggleWrapperEl.appendChild(modeToggleEl);

  // Insert before containerEl so it appears to its left when collapsed
  outerWrapperEl.insertBefore(modeToggleWrapperEl, containerEl);
}

// ─── CSS ───

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
    overflow: visible;
  }

  /* ── Toggle bar (top-right, outside the panel) ── */

  .args-toggle-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
    position: absolute;
    top: 0px;
    right: 11px;
    z-index: 3;
    transform: scale(0.81);
    transform-origin: right center;
  }

  .args-toggle-bar.visible {
    opacity: 1;
    pointer-events: auto;
  }

  .args-outer-wrapper:has(.args-container.dashboard) .args-toggle-bar,
  .args-outer-wrapper:has(.args-container.oddity-not-enabled) .args-toggle-bar {
    opacity: 0;
    pointer-events: none;
  }

  /* ── Mode toggle (moves with the FAB) ── */

  .args-mode-toggle-wrapper {
    pointer-events: auto;
    position: absolute;
    z-index: 3;
  }

  .args-outer-wrapper:has(.args-container.dashboard) .args-mode-toggle-wrapper {
    opacity: 0;
    pointer-events: none;
  }

  .args-mode-toggle-wrapper.disabled .mode-btn,
  .args-mode-toggle-wrapper.disabled .mode-close-btn {
    cursor: default;
  }

  .mode-toggle {
    display: grid;
    grid-template-columns: auto auto;
    padding: 3px;
    background: #E6E6E6;
    border-radius: 10px;
    position: relative;
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(0,0,0,0.10), 0 0 1px rgba(0,0,0,0.08);
  }

  .mode-toggle.with-close {
    grid-template-columns: auto auto auto;
  }

  .mode-slider {
    position: absolute;
    top: 3px;
    height: calc(100% - 6px);
    background: #FFFFFF;
    border-radius: 8px;
    transition: left 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
                width 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
    pointer-events: none;
    z-index: 0;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 0 1px rgba(0,0,0,0.08);
  }

  .mode-btn {
    all: unset;
    padding: 5px 14px;
    text-align: center;
    font-size: 12.5px;
    font-weight: 400;
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
    color: #858E97;
    background: transparent;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.25s ease;
    white-space: nowrap;
    position: relative;
    z-index: 1;
  }

  .mode-active {
    color: #696F77;
  }

  .mode-btn:hover:not(.mode-active) {
    color: #696F77;
  }

  .mode-close-btn {
    all: unset;
    display: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    cursor: pointer;
    color: #858E97;
    background: transparent;
    position: relative;
    z-index: 1;
    transition: color 0.2s ease, background 0.2s ease;
  }

  .mode-close-btn:hover {
    color: #696F77;
    background: rgba(0, 0, 0, 0.06);
  }

  .mode-toggle.with-close .mode-close-btn {
    display: flex;
  }

  /* Dark mode overrides when expanded (with-close) */
  .mode-toggle.with-close {
    background: #292929;
    box-shadow: 0 1px 4px rgba(0,0,0,0.25), 0 0 1px rgba(0,0,0,0.15);
  }
  .mode-toggle.with-close .mode-slider {
    background: #434343;
    box-shadow: 0 1px 3px rgba(0,0,0,0.25), 0 0 1px rgba(0,0,0,0.15);
  }
  .mode-toggle.with-close .mode-btn { color: #787A7D; }
  .mode-toggle.with-close .mode-active { color: #FFFFFF; }
  .mode-toggle.with-close .mode-btn:hover:not(.mode-active) { color: #FFFFFF; }
  .mode-toggle.with-close .mode-close-btn { color: #787A7D; }
  .mode-toggle.with-close .mode-close-btn:hover { color: #FFFFFF; background: rgba(255,255,255,0.08); }

  /* Light mode: expanded toggle uses light colors */
  :host([data-theme="light"]) .mode-toggle.with-close {
    background: #E6E6E6;
    box-shadow: 0 1px 4px rgba(0,0,0,0.10), 0 0 1px rgba(0,0,0,0.08);
  }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-slider {
    background: #FFFFFF;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 0 1px rgba(0,0,0,0.08);
  }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-btn { color: #858E97; }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-active { color: #696F77; }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-btn:hover:not(.mode-active) { color: #696F77; }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-close-btn { color: #858E97; }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-close-btn:hover { color: #696F77; background: rgba(0,0,0,0.06); }

  /* ── Morphing container ── */

  .args-container {
    all: unset;
    display: block;
    pointer-events: auto;
    overflow: visible;
    position: relative;
    background: rgba(255, 255, 255, 0.03);
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
    background: rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    z-index: 0;
    pointer-events: none;
  }

  .args-container:not(.expanded):not(.oddity-not-enabled):hover {
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
    border: 1px solid #363636;
    cursor: default;
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    transform: translateY(32px);
  }

  /* ── Resize handle (top-left corner) ── */

  .args-resize-handle {
    display: none;
    position: absolute;
    top: 0;
    left: 0;
    width: 18px;
    height: 18px;
    cursor: nw-resize;
    z-index: 10;
    border-radius: 16px 0 0 0;
  }

  .args-resize-handle::after {
    content: '';
    position: absolute;
    top: 4px;
    left: 4px;
    width: 8px;
    height: 8px;
    border-top: 2px solid rgba(255, 255, 255, 0.45);
    border-left: 2px solid rgba(255, 255, 255, 0.45);
    border-radius: 2px 0 0 0;
    pointer-events: none;
  }

  .args-container.expanded .args-resize-handle {
    display: block;
  }

  .args-container.oddity-not-enabled .args-resize-handle,
  .args-container.dashboard .args-resize-handle {
    display: none;
  }

  :host([data-theme="light"]) .args-resize-handle::after {
    border-top-color: rgba(0, 0, 0, 0.3);
    border-left-color: rgba(0, 0, 0, 0.3);
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

  /* ── Plus-button tooltip ── */
  .add-tooltip {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    width: 200px;
    padding: 10px 12px;
    background: #1a1a1a;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    opacity: 0;
    transform: translateY(-4px);
    pointer-events: none;
    transition: opacity 0.18s, transform 0.18s;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .add-tooltip.visible {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
  .add-tooltip-title {
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .add-tooltip-desc {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.6);
    line-height: 1.4;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .add-tooltip-desc b {
    color: rgba(255, 255, 255, 0.85);
    font-weight: 600;
  }

  /* ── Toggle bar ── */

  .args-enabled-label {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
    font-family: system-ui, -apple-system, sans-serif;
  }

  .args-panel-toggle-input {
    display: none;
  }

  .args-panel-toggle-slider {
    display: inline-block;
    position: relative;
    width: 32px;
    height: 19px;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }

  .args-panel-toggle-slider::after {
    content: '';
    position: absolute;
    top: 2.5px;
    left: 2.5px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .args-panel-toggle-input:checked + .args-panel-toggle-slider {
    background: #22c55e;
  }

  .args-panel-toggle-input:checked + .args-panel-toggle-slider::after {
    transform: translateX(13px);
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
    font-size: 9.5px;
    font-weight: 500;
    color: #E6E6E6;
    font-family: system-ui, -apple-system, sans-serif;
    letter-spacing: 0.04em;
  }

  .args-purpose-input {
    all: unset;
    font-size: 11px;
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
    width: calc(100% - 32px);
    background: rgba(255, 255, 255, 0.07);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-radius: 6.5px;
    padding: 10px 12px;
    font-family: var(--oddity-note-font);
    font-size: var(--oddity-note-size);
    line-height: 1.45;
    color: #FFFFFF;
    cursor: pointer;
    box-shadow: 0 1.5px 6px rgba(0,0,0,0.09), 0 0.5px 1.5px rgba(0,0,0,0.06);
    transition: box-shadow 0.2s;
    box-sizing: border-box;
    flex-shrink: 0;
  }

  .arg-card:hover {
    box-shadow: 0 2px 6px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06);
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

  /* Colored card overrides moved after default styles — see below */

  /* Header = note-label (max 1 line) */
  .arg-card-header {
    display: block;
    font-family: var(--oddity-note-font);
    font-style: normal;
    font-size: var(--oddity-note-size);
    font-weight: 900;
    letter-spacing: normal;
    color: #748DBF;
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
    background: #FFFFFF;
    border: 1px solid #DFE7EF;
    border-radius: 100px;
    padding: 5px 12px;
    font-size: var(--oddity-note-size);
    font-weight: 450;
    color: #293038;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    line-height: 1;
    box-sizing: border-box;
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
    background: #748DBF;
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
    background: #748DBF;
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

  /* Colored cards (LLM-generated annotation feedback) — must come after default styles */
  .arg-card--colored .arg-card-header {
    color: var(--arg-card-color);
  }
  .arg-card--colored .note-reply-send {
    background: var(--arg-card-color);
  }
  .arg-card--colored .note-feedback-pill {
    background: var(--arg-card-color);
  }

  /* Yellow note cards: dark text for readability */
  .arg-card--yellow .arg-card-header {
    color: var(--arg-card-color);
  }
  .arg-card--yellow .note-reply-send .arrow-light { display: none; }
  .arg-card--yellow .note-reply-send .arrow-dark { display: inline-flex; }
  .arg-card--yellow .note-feedback-pill {
    color: #293038;
  }

  /* ── Icon theme switching for argument cards ── */
  .icon-light { display: none; }
  .icon-dark { display: inline-flex; }
  :host([data-theme="light"]) .icon-light { display: inline-flex; }
  :host([data-theme="light"]) .icon-dark { display: none; }

  /* ── Arrow theme switching for send button ── */
  .note-reply-send .arrow-dark { display: none; }
  .note-reply-send .arrow-light { display: inline-flex; }
  :host([data-theme="light"]) .note-reply-send .arrow-dark { display: inline-flex; }
  :host([data-theme="light"]) .note-reply-send .arrow-light { display: none; }

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
    background: #748DBF;
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
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 4px;
    margin: 8px 14px;
    flex-shrink: 0;
    background: #2a2a2a;
    border-radius: 12px;
    position: relative;
    cursor: pointer;
  }

  .args-mode-slider {
    position: absolute;
    top: 4px;
    left: 4px;
    width: calc(50% - 4px);
    height: calc(100% - 8px);
    background: #404040;
    border-radius: 9px;
    transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
    pointer-events: none;
    z-index: 0;
  }

  .args-mode-toggle[data-active="depth"] .args-mode-slider {
    transform: translateX(100%);
  }

  .args-mode-btn {
    all: unset;
    padding: 7px 0;
    text-align: center;
    font-size: 13px;
    font-weight: 500;
    color: #888;
    background: transparent;
    border: none;
    border-radius: 9px;
    cursor: pointer;
    transition: color 0.25s ease;
    position: relative;
    z-index: 1;
  }

  .args-mode-active {
    color: #fff;
  }

  .args-mode-btn:hover:not(.args-mode-active) {
    color: #bbb;
  }

  :host([data-theme="light"]) .args-mode-toggle {
    background: #e8e8e8;
  }

  :host([data-theme="light"]) .args-mode-slider {
    background: #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  :host([data-theme="light"]) .args-mode-btn {
    color: #888;
  }

  :host([data-theme="light"]) .args-mode-active {
    color: #333;
  }

  :host([data-theme="light"]) .args-mode-btn:hover:not(.args-mode-active) {
    color: #555;
  }

  /* ── Footer ── */

  .args-footer {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 0px 14px 14px;
    padding-top: 10px;
    flex-shrink: 0;
  }

  .args-sketch-btn {
    all: unset;
    display: block;
    padding: 13px 16px;
    background: #363636;
    color: #fff;
    font-size: 14px;
    font-weight: 400;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    text-align: center;
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.15s, box-shadow 0.15s;
    box-sizing: border-box;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15), 0 1px 3px rgba(0,0,0,0.1);
  }

  .args-sketch-btn:hover {
    background: #484848;
  }

  .args-sketch-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Tab Bar ── */
  .args-tab-bar {
    display: flex;
    gap: 0;
    padding: 0 14px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    flex-shrink: 0;
  }

  .args-tab {
    all: unset;
    padding: 8px 14px;
    font-size: 12px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: rgba(255,255,255,0.45);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
  }

  .args-tab:hover {
    color: rgba(255,255,255,0.7);
  }

  .args-tab.active {
    color: #fff;
    border-bottom-color: #748DBF;
  }

  /* ── Sketch Content ── */
  .args-sketch-content {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    font-family: var(--oddity-note-font, "Helvetica Neue", Helvetica, Arial, sans-serif);
    font-size: var(--oddity-note-size, 14px);
    color: #e0e0e0;
    line-height: 1.55;
    min-height: 0;
  }

  .args-sketch-content strong {
    color: #fff;
    font-weight: 600;
  }

  .args-sketch-content ul {
    margin: 6px 0;
    padding-left: 18px;
  }

  .args-sketch-content li {
    margin-bottom: 4px;
  }

  .args-sketch-loading {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
    padding: 32px 0;
  }

  .args-sketch-loading span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: rgba(255,255,255,0.4);
    animation: sketchPulse 1.2s ease-in-out infinite;
  }

  .args-sketch-loading span:nth-child(2) { animation-delay: 0.2s; }
  .args-sketch-loading span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes sketchPulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1.2); }
  }

  .args-sketch-error {
    padding: 16px;
    color: rgba(255,100,100,0.8);
    font-size: 13px;
    text-align: center;
  }

  /* ── Purpose Error ── */
  .args-purpose-input.args-purpose-error {
    border-color: rgba(255,120,80,0.6) !important;
    animation: purposeShake 0.4s ease;
  }

  @keyframes purposeShake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-4px); }
    40% { transform: translateX(4px); }
    60% { transform: translateX(-2px); }
    80% { transform: translateX(2px); }
  }

  .args-footer-text {
    font-size: 13px;
    color: #FFFFFF;
    cursor: pointer;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-weight: 400;
    text-align: center;
    text-decoration: underline;
  }

  .args-footer-text:hover {
    color: rgba(255, 255, 255, 0.7);
  }

  /* ── Top bar (toggle + close, slides in on hover) ── */

  .args-top-bar-hover {
    position: absolute;
    top: -44px;
    left: 0;
    pointer-events: none;
    opacity: 0;
    transform: translateY(8px) scale(0.95);
    transform-origin: left center;
    transition: opacity 0.18s ease, transform 0.22s ease;
    z-index: 3;
  }

  .args-top-bar-hover.hovered {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0) scale(0.95);
  }

  .args-container.dashboard .args-top-bar-hover {
    display: none;
  }

  /* ── Light mode overrides ── */

  :host([data-theme="light"]) .args-container {
    background: rgba(255, 255, 255, 0.4);
  }

  :host([data-theme="light"]) .args-container.expanded {
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-color: #E7E7E7;
  }

  :host([data-theme="light"]) .args-container.expanded::after {
    background: rgba(255, 255, 255, 0.3);
  }

  :host([data-theme="light"]) .args-main-title {
    color: #748DBF;
  }

  :host([data-theme="light"]) .args-header-icon-btn {
    color: rgba(0, 0, 0, 0.5);
  }

  :host([data-theme="light"]) .args-header-icon-btn:hover {
    background: rgba(0, 0, 0, 0.07);
    color: #1a1a1a;
  }

  :host([data-theme="light"]) .add-tooltip {
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  }
  :host([data-theme="light"]) .add-tooltip-title {
    color: #1a1a1a;
  }
  :host([data-theme="light"]) .add-tooltip-desc {
    color: rgba(0, 0, 0, 0.5);
  }
  :host([data-theme="light"]) .add-tooltip-desc b {
    color: rgba(0, 0, 0, 0.75);
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
    color: #748DBF;
  }
  :host([data-theme="light"]) .arg-card--colored .arg-card-header {
    color: var(--arg-card-color);
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
    color: #363636;
  }

  :host([data-theme="light"]) .args-footer-text:hover {
    color: #1a1a1a;
  }

  :host([data-theme="light"]) .args-sketch-btn {
    background: #748DBF;
    color: #fff;
  }

  :host([data-theme="light"]) .args-sketch-btn:hover {
    background: #6580B0;
  }

  :host([data-theme="light"]) .args-tab-bar {
    border-bottom-color: rgba(0,0,0,0.08);
  }

  :host([data-theme="light"]) .args-tab {
    color: rgba(0,0,0,0.4);
  }

  :host([data-theme="light"]) .args-tab:hover {
    color: rgba(0,0,0,0.65);
  }

  :host([data-theme="light"]) .args-tab.active {
    color: #111;
  }

  :host([data-theme="light"]) .args-sketch-content {
    color: #333;
  }

  :host([data-theme="light"]) .args-sketch-content strong {
    color: #111;
  }

  :host([data-theme="light"]) .args-sketch-loading span {
    background: rgba(0,0,0,0.3);
  }

  :host([data-theme="light"]) .args-purpose-input.args-purpose-error {
    border-color: rgba(220,80,40,0.6) !important;
  }

  /* ── Not-enabled state (no colored stroke) ── */

  .args-container.oddity-not-enabled.expanded {
    height: calc((100vh - 58px) * 0.5 + 32px);
    width: 225px;
  }

  /* ── Enable-site bubble (speech bubble to the left of collapsed button) ── */

  .args-enable-bubble {
    display: none;
    position: absolute;
    right: 20px;
    bottom: calc(100% + 8px);
    white-space: nowrap;
    padding: 14px 22px;
    background: #fff;
    color: #393939;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.4;
    font-family: system-ui, -apple-system, sans-serif;
    border-radius: 16px;
    pointer-events: auto;
    z-index: 3;
    text-align: center;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  }

  .args-enable-bubble-close {
    all: unset;
    position: absolute;
    top: -5px;
    left: -5px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.35);
    color: #fff;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .args-enable-bubble-close:hover {
    background: rgba(0, 0, 0, 0.5);
    color: #fff;
  }

  .args-enable-bubble-text {
    color: #393939;
  }

  .args-enable-bubble-link {
    color: #393939;
    text-decoration: underline;
    cursor: pointer;
  }

  .args-enable-bubble-link:hover {
    color: #000;
  }

  .args-container.oddity-not-enabled:not(.expanded) .args-enable-bubble {
    display: block;
  }

  /* ── Empty-annotations bubble ── */

  .args-empty-bubble {
    display: none;
    position: absolute;
    right: 20px;
    bottom: calc(100% + 8px);
    min-width: 260px;
    max-width: 360px;
    white-space: normal;
    padding: 12px 20px;
    background: #fff;
    color: #393939;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.4;
    font-family: system-ui, -apple-system, sans-serif;
    border-radius: 16px;
    pointer-events: auto;
    z-index: 3;
    text-align: center;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  }

  .args-empty-bubble.visible {
    display: block;
  }

  .args-container.expanded .args-empty-bubble {
    display: none;
  }

  .args-empty-bubble-text {
    color: #393939;
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
    background: #363636;
    color: #ffffff;
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
    background: #4a4a4a;
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

  .args-not-enabled-close {
    all: unset;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    cursor: pointer;
    color: #858E97;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 1px 4px rgba(0,0,0,0.10), 0 0 1px rgba(0,0,0,0.08);
    position: absolute;
    top: -36px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
    pointer-events: auto;
    transition: color 0.2s ease, background 0.2s ease;
  }

  .args-not-enabled-close:hover {
    color: #696F77;
    background: rgba(255, 255, 255, 1);
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
    height: min(440px, calc(100vh - 60px));
  }

  /* ── Dashboard state ── */

  .args-container.dashboard {
    width: 290px;
    height: min(440px, calc(100vh - 60px));
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    background: #fff;
  }

  /* ── Dashboard close button (floats above mid-sized panel) ── */

  .dash-close-btn {
    all: unset;
    display: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    cursor: pointer;
    color: #858E97;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 1px 4px rgba(0,0,0,0.10), 0 0 1px rgba(0,0,0,0.08);
    position: absolute;
    top: -36px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
    pointer-events: auto;
    transition: color 0.2s ease, background 0.2s ease, opacity 0.18s ease;
  }

  .dash-close-btn:hover {
    color: #696F77;
    background: rgba(255, 255, 255, 1);
  }

  .args-container.dashboard .dash-close-btn {
    display: flex;
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

  .args-dash-logo-img {
    width: 78px;
    height: auto;
    display: block;
    flex-shrink: 0;
    object-fit: contain;
    margin-right: auto;
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

  .args-dash-persona-label {
    font-family: "Fraunces", Georgia, serif;
    font-size: 12px;
    font-weight: 500;
    color: #111;
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
    position: relative;
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

  .args-dash-density-tooltip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: #1a1a1a;
    color: #fff;
    font-size: 10px;
    white-space: nowrap;
    padding: 3px 7px;
    border-radius: 4px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 10;
  }

  .args-dash-density-btn:hover .args-dash-density-tooltip { opacity: 1; }

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

  .args-dash-feedback-role-select {
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
    margin-bottom: 8px;
    box-sizing: border-box;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%238a8a80' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    padding-right: 32px;
  }
  .args-dash-feedback-role-select:focus { border-color: #111; }

  .args-dash-feedback-role-other {
    display: none;
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
    margin-bottom: 8px;
    box-sizing: border-box;
  }
  .args-dash-feedback-role-other:focus { border-color: #111; }

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
    overflow-y: auto;
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

  .args-dash-forgot-link {
    font-size: 11px;
    color: #8a8a80;
    cursor: pointer;
    text-align: right;
    margin-top: -2px;
  }
  .args-dash-forgot-link:hover { color: #111; }

  .args-dash-google-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 9px 10px;
    border: 0.5px solid #e8e8e2;
    border-radius: 100px;
    background: #fff;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    color: #3a3a36;
    font-family: -apple-system, "Helvetica Neue", Helvetica, sans-serif;
    transition: all 0.15s;
  }
  .args-dash-google-btn:hover {
    background: #f5f4f0;
    border-color: #d4d4ca;
  }
  .args-dash-google-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .args-dash-auth-divider {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 2px 0;
    font-size: 11px;
    color: #8a8a80;
    font-family: -apple-system, "Helvetica Neue", Helvetica, sans-serif;
  }
  .args-dash-auth-divider::before,
  .args-dash-auth-divider::after {
    content: "";
    flex: 1;
    border-top: 0.5px solid #e8e8e2;
  }
  .args-dash-auth-terms {
    font-size: 11px;
    color: #8a8a80;
    text-align: center;
    line-height: 1.4;
    font-family: -apple-system, "Helvetica Neue", Helvetica, sans-serif;
  }
  .args-dash-auth-terms a {
    color: #6b6b63;
    text-decoration: underline;
  }
  .args-dash-auth-terms a:hover {
    color: #111;
  }

  /* ── Onboarding slideshow ── */

  @keyframes onboarding-pulse {
    0% { transform: scale(1); }
    50% { transform: scale(0.93); }
    100% { transform: scale(1); }
  }

  @keyframes onboarding-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .args-onboarding-overlay {
    position: absolute;
    inset: 0;
    background: #fff;
    border-radius: inherit;
    z-index: 3;
    display: flex;
    flex-direction: column;
    opacity: 0;
    transition: opacity 0.3s ease;
    overflow: hidden;
  }

  .args-onboarding-overlay.visible {
    opacity: 1;
  }

  .args-onboarding-skip {
    all: unset;
    position: absolute;
    top: 14px;
    right: 14px;
    font-size: 12px;
    color: #8a8a80;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    cursor: pointer;
    z-index: 1;
  }

  .args-onboarding-skip:hover {
    color: #111;
  }

  .args-onboarding-track {
    flex: 1;
    display: flex;
    min-height: 0;
    transform: translateX(calc(-100% * var(--slide-index, 0)));
    transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .args-onboarding-slide {
    flex: 0 0 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 24px 16px;
    box-sizing: border-box;
    text-align: center;
    gap: 14px;
  }

  .args-onboarding-slide-title {
    font-family: "Fraunces", Georgia, serif;
    font-size: 18px;
    font-weight: 700;
    color: #1a1a1a;
    letter-spacing: 0.01em;
    line-height: 1.3;
  }

  .args-onboarding-slide-body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 12.5px;
    color: #606060;
    line-height: 1.5;
    max-width: 280px;
  }

  .args-onboarding-slide-visual {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin-bottom: 4px;
  }

  /* ── Slide 1: mock article with inline highlights ── */

  .args-onboarding-paragraph {
    width: 100%;
    max-width: 280px;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .args-onboarding-pline {
    font-family: Georgia, serif;
    font-size: 12px;
    line-height: 1.6;
    color: #3a3a36;
  }

  /* Inline highlighted phrase — matches real annotation spans */
  .args-onboarding-pline-hl {
    background-color: transparent;
    border-bottom: 1.5px solid transparent;
    transition: background-color 0.5s ease, border-bottom-color 0.5s ease;
  }

  .args-onboarding-pline-hl.active {
    background-color: color-mix(in srgb, var(--hl-color) 15%, transparent);
  }

  .args-onboarding-pline-hl.has-underline.active {
    border-bottom-color: var(--hl-color);
  }

  .args-onboarding-pline-label {
    display: inline-block;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 8px;
    font-weight: 800;
    letter-spacing: 0.08em;
    margin-left: 6px;
    opacity: 0;
    transform: translateY(3px);
    transition: opacity 0.35s ease, transform 0.35s ease;
    vertical-align: middle;
  }

  .args-onboarding-pline-label.active {
    opacity: 1;
    transform: translateY(0);
  }

  /* ── Slide 2: persona circles with entrances + speech bubbles ── */

  .args-onboarding-personas {
    display: flex;
    gap: 14px;
    justify-content: center;
    align-items: flex-start;
  }

  .args-onboarding-persona {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    width: 80px;
    opacity: 0;
    transform: scale(0.7);
    transition: opacity 0.4s ease, transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .args-onboarding-persona.entered {
    opacity: 1;
    transform: scale(1);
  }

  .args-onboarding-persona-circle {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .args-onboarding-persona-circle img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .args-onboarding-persona-name {
    font-family: "Fraunces", Georgia, serif;
    font-size: 12px;
    font-weight: 600;
    color: #1a1a1a;
  }

  .args-onboarding-persona-desc {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10px;
    color: #8a8a80;
    line-height: 1.35;
  }

  .args-onboarding-speech {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 9.5px;
    font-style: italic;
    color: #606060;
    background: #f4f4f2;
    border-radius: 8px;
    padding: 5px 8px;
    margin-top: 4px;
    line-height: 1.35;
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.35s ease, transform 0.35s ease;
    text-align: center;
  }

  .args-onboarding-speech.active {
    opacity: 1;
    transform: translateY(0);
  }

  /* ── Slide 3: animated annotation card with reactions ── */

  .args-onboarding-mock-card {
    width: 100%;
    max-width: 280px;
    background: #f7f7f5;
    border-radius: 10px;
    padding: 12px 14px;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 6px;
    opacity: 0;
    transform: translateY(24px);
    transition: opacity 0.45s ease, transform 0.45s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .args-onboarding-mock-card.entered {
    opacity: 1;
    transform: translateY(0);
  }

  .args-onboarding-mock-label {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10px;
    font-weight: 700;
    color: #DCAF16;
    letter-spacing: 0.05em;
  }

  .args-onboarding-mock-text {
    font-family: Georgia, serif;
    font-size: 12px;
    color: #3a3a36;
    line-height: 1.45;
  }

  .args-onboarding-mock-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }

  .args-onboarding-mock-thumb {
    font-size: 16px;
    opacity: 0.35;
    transition: opacity 0.2s, transform 0.2s;
    cursor: default;
  }

  .args-onboarding-mock-thumb.active {
    opacity: 1;
  }

  .args-onboarding-mock-thumb.pulse {
    animation: onboarding-pulse 0.3s ease;
  }

  /* Reply area */
  .args-onboarding-reply-area {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
    opacity: 0;
    max-height: 0;
    overflow: hidden;
    transition: opacity 0.3s ease, max-height 0.4s ease;
  }

  .args-onboarding-reply-area.active {
    opacity: 1;
    max-height: 100px;
  }

  .args-onboarding-reply-bubble {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 11px;
    color: #748DBF;
    background: rgba(116,141,191,0.1);
    border-radius: 10px;
    padding: 5px 10px;
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.3s ease, transform 0.3s ease;
  }

  .args-onboarding-reply-bubble.active {
    opacity: 1;
    transform: translateY(0);
  }

  .args-onboarding-reply-input {
    display: flex;
    align-items: center;
    background: #fff;
    border: 1px solid #dfe7ef;
    border-radius: 100px;
    padding: 5px 12px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 11px;
    color: #3a3a36;
    min-height: 16px;
  }

  .args-onboarding-reply-input-text {
    /* typewriter target */
  }

  .args-onboarding-cursor {
    display: inline-block;
    width: 1px;
    height: 13px;
    background: #3a3a36;
    margin-left: 1px;
    opacity: 0;
    vertical-align: text-bottom;
  }

  .args-onboarding-cursor.active {
    animation: onboarding-blink 0.8s step-end infinite;
  }

  /* ── Slide 4: replies → sketch compilation ── */

  .args-onboarding-sketch-mock {
    width: 100%;
    max-width: 280px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Mini reply/reaction cards that collapse into the sketch */
  .args-onboarding-reply-cards {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .args-onboarding-reply-card {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 10px;
    background: #f7f7f5;
    border-radius: 8px;
    border-left: 3px solid var(--card-color, #ccc);
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 11px;
    color: #3a3a36;
    opacity: 0;
    transform: translateX(-12px);
    max-height: 32px;
    overflow: hidden;
    transition: opacity 0.35s ease, transform 0.35s ease, max-height 0.4s ease, padding 0.4s ease, margin 0.4s ease, border-width 0.4s ease;
  }

  .args-onboarding-reply-card.entered {
    opacity: 1;
    transform: translateX(0);
  }

  .args-onboarding-reply-card.collapsed {
    opacity: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    margin: 0;
    border-width: 0;
    transform: translateY(-4px) scale(0.95);
  }

  .args-onboarding-reply-card-icon {
    font-size: 12px;
    flex-shrink: 0;
  }

  .args-onboarding-reply-card-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.3;
  }

  .args-onboarding-sketch-btn {
    all: unset;
    display: block;
    padding: 10px 16px;
    background: #748DBF;
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    text-align: center;
    border-radius: 100px;
    letter-spacing: 0.02em;
    cursor: default;
  }

  .args-onboarding-sketch-btn.pulse {
    animation: onboarding-pulse 0.3s ease;
  }

  .args-onboarding-sketch-output {
    background: #f7f7f5;
    border-radius: 10px;
    padding: 12px 14px;
    text-align: left;
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition: grid-template-rows 0.4s ease, opacity 0.3s ease;
    overflow: hidden;
  }

  .args-onboarding-sketch-output.active {
    grid-template-rows: 1fr;
    opacity: 1;
  }

  .args-onboarding-sketch-inner {
    overflow: hidden;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .args-onboarding-sketch-line {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 11px;
    color: #3a3a36;
    line-height: 1.55;
    min-height: 1.55em;
  }

  .args-onboarding-sketch-line:empty {
    min-height: 0;
  }

  /* ── Navigation ── */

  .args-onboarding-nav {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 12px 24px 20px;
    flex-shrink: 0;
  }

  .args-onboarding-dots {
    display: flex;
    gap: 6px;
  }

  .args-onboarding-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: rgba(0,0,0,0.12);
    cursor: pointer;
    transition: background 0.2s, transform 0.2s;
    border: none;
    padding: 0;
  }

  .args-onboarding-dot.active {
    background: #1a1a1a;
    transform: scale(1.2);
  }

  .args-onboarding-next {
    all: unset;
    display: block;
    width: 100%;
    padding: 10px 12px;
    background: #1a1a1a;
    color: #ffffff;
    font-size: 13px;
    font-weight: 500;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    text-align: center;
    border-radius: 100px;
    cursor: pointer;
    transition: background 0.15s;
    box-sizing: border-box;
  }

  .args-onboarding-next:hover {
    background: #333;
  }

  /* ── Toast notification ── */
  .args-toast {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%) translateY(8px);
    background: #262626;
    color: #bbb;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11px;
    line-height: 1.4;
    padding: 8px 14px;
    border-radius: 6px;
    border: 1px solid #333;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.25s, transform 0.25s;
    z-index: 100;
    margin-bottom: 8px;
  }

  .args-toast.visible {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  :host([data-theme="light"]) .args-toast {
    background: #f5f5f5;
    color: #444;
    border-color: #ddd;
    box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  }
`;
