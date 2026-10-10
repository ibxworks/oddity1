import type {
  Annotation,
  AnnotationFeedback,
  AnnotationFont,
  AnnotationFontSize,
  AnnotationType,
  LlmKeyStatus,
  LlmProvider,
  LlmStatusResponse,
  SaveLlmKeyBody,
} from "@oddity/shared";
import {
  getAnnotationColor,
  LLM_PROVIDER_META,
  modelSupportsEffort,
} from "@oddity/shared";

import {
  getChatbotBuildPromptLabel,
  getChatbotOnboardingBody,
  getChatbotOnboardingTitle,
  getChatbotPromptEmptyStateBody,
  getChatbotPromptEmptyStateTitle,
  getChatbotPromptErrorText,
  getChatbotPromptGoalHelper,
  getChatbotPromptGoalPlaceholder,
  getChatbotPromptLoadingLabel,
} from "../chatbot-ui.js";
import { showNoticeToast } from "../notice-toast.js";
import { getPageUrl } from "../page-url.js";
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

export type PdfSummaryCardItem = {
  pageNo: string;
  pageLabel: string;
  summary: string | null;
  loading: boolean;
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
let activeTab: "notes" | "sketch" | "summaries" = "notes";
let tabBarEl: HTMLDivElement | null = null;
let notesTabBtn: HTMLButtonElement | null = null;
let sketchTabBtn: HTMLButtonElement | null = null;
let pdfSummaryTabBtn: HTMLButtonElement | null = null;
let sketchContentEl: HTMLDivElement | null = null;
let pdfSummaryListEl: HTMLDivElement | null = null;
let sketchBuffer = "";
let sketchLoading = false;
let sketchBtnEl: HTMLButtonElement | null = null;
let footerEl: HTMLDivElement | null = null;
let purposeInputEl: HTMLTextAreaElement | null = null;
let purposeLabelEl: HTMLSpanElement | null = null;
let purposeHelperEl: HTMLDivElement | null = null;
let isChatbotMode = false;
let chatbotDisplayName: string | null = null;
let chatbotInputSelector: string | null = null;
let sketchViewState: "idle" | "loading" | "ready" | "error" = "idle";
let notEnabledPanelEl: HTMLDivElement | null = null;
let enableBubbleEl: HTMLDivElement | null = null;
let emptyBubbleEl: HTMLDivElement | null = null;
let blockedPanelEl: HTMLDivElement | null = null;

// ─── Google Docs mode ───
function isGDocs(): boolean {
  return location.hostname === "docs.google.com";
}
function getGDocsTitle(): string {
  const raw = document.title.replace(/\s*-\s*Google Docs\s*$/i, "").trim();
  return raw || "My Document";
}
let gdocsPersonaName = "Terry";
let gdocsChatMode: "auto" | "fast" | "plan" = "auto";
let gdocsMemoMode: "memo" | "resource" = "memo";
let gdocsActiveTab: "memo" | "resource" | "outline" = "memo";
let gdocsExpandedCardId: string | null = null;
let gdocsMemoEditMode = false;
const gdocsMemoSelected = new Set<string>(); // sortKeys of selected memos
let gdocsMemoPillEl: HTMLDivElement | null = null;
let gdocsPersonaSubtitleEl: HTMLSpanElement | null = null;
let gdocsTitleEl: HTMLSpanElement | null = null;
let gdocsTitleObs: MutationObserver | null = null;
let gdocsMemoTabBtn: HTMLButtonElement | null = null;
let gdocsResourceTabBtn: HTMLButtonElement | null = null;
let gdocsOutlineTabBtn: HTMLButtonElement | null = null;
let gdocsChatTextarea: HTMLTextAreaElement | null = null;
let gdocsMemoModeBtn: HTMLButtonElement | null = null;
let gdocsResourceModeBtn: HTMLButtonElement | null = null;
let gdocsModeDropdownBtn: HTMLButtonElement | null = null;
let gdocsModeDropdownMenu: HTMLDivElement | null = null;
let gdocsResourcePanelEl: HTMLDivElement | null = null;
let gdocsOutlinePanelEl: HTMLDivElement | null = null;
let gdocsOutlineTextEl: HTMLDivElement | null = null;
let gdocsCurrentOutlineText = "";
let gdocsOutlineContinueBtn: HTMLButtonElement | null = null;
let gdocsOutlineRejectBtn: HTMLButtonElement | null = null;
let gdocsOutlineOtherBtn: HTMLButtonElement | null = null;
let gdocsChatInputAreaEl: HTMLDivElement | null = null;
let gdocsArgBoxLoadingTimeout: ReturnType<typeof setTimeout> | null = null;
let gdocsArgBoxLoadingActive = false;
let gdocsArgBoxSpinnerEl: HTMLElement | null = null;

const ARG_BOX_LOADING_QUESTIONS = [
  'What shapes your core beliefs?',
  'How does language affect thought?',
  'Why do patterns repeat in history?',
  'What defines a just society?',
  'When does change become necessary?',
  'How do ideas spread and evolve?',
  'What makes an argument compelling?',
  'Why does art outlast empires?',
  'How does power shape narrative?',
  'What is the cost of certainty?',
  'Why do humans need stories?',
  'How does context change meaning?',
];

// Renders plain text with **bold** markdown into an element safely (no XSS).
function setOutlineText(el: HTMLDivElement, text: string): void {
  el.innerHTML = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function startArgBoxLoading(textarea: HTMLTextAreaElement): void {
  stopArgBoxLoading(textarea);
  textarea.disabled = true;
  textarea.value = '';
  textarea.style.color = '#ABABAB';
  if (gdocsArgBoxSpinnerEl) gdocsArgBoxSpinnerEl.classList.add('visible');
  gdocsArgBoxLoadingActive = true;

  let idx = Math.floor(Math.random() * ARG_BOX_LOADING_QUESTIONS.length);

  function schedule(fn: () => void, ms: number): void {
    gdocsArgBoxLoadingTimeout = setTimeout(fn, ms);
  }

  function typeOut(text: string, charIdx: number, onDone: () => void): void {
    if (!gdocsArgBoxLoadingActive) return;
    textarea.value = text.slice(0, charIdx);
    if (charIdx < text.length) {
      schedule(() => typeOut(text, charIdx + 1, onDone), 32);
    } else {
      schedule(onDone, 120);
    }
  }

  function showDots(dotCount: number, cycles: number, onDone: () => void): void {
    if (!gdocsArgBoxLoadingActive) return;
    const base = ARG_BOX_LOADING_QUESTIONS[idx]!;
    textarea.value = base + '.'.repeat(dotCount);
    const nextDots = (dotCount % 3) + 1;
    const nextCycles = nextDots === 1 ? cycles - 1 : cycles;
    if (nextCycles < 0) {
      schedule(onDone, 350);
    } else {
      schedule(() => showDots(nextDots, nextCycles, onDone), 380);
    }
  }

  function runNext(): void {
    if (!gdocsArgBoxLoadingActive) return;
    idx = (idx + 1) % ARG_BOX_LOADING_QUESTIONS.length;
    textarea.value = '';
    schedule(() => typeOut(ARG_BOX_LOADING_QUESTIONS[idx]!, 0, () => showDots(1, 1, runNext)), 200);
  }

  typeOut(ARG_BOX_LOADING_QUESTIONS[idx]!, 0, () => showDots(1, 1, runNext));
}

function stopArgBoxLoading(textarea: HTMLTextAreaElement): void {
  gdocsArgBoxLoadingActive = false;
  if (gdocsArgBoxLoadingTimeout) { clearTimeout(gdocsArgBoxLoadingTimeout); gdocsArgBoxLoadingTimeout = null; }
  textarea.disabled = false;
  textarea.value = '';
  textarea.style.color = '';
  textarea.placeholder = 'Rewrite my essay into ...';
  if (gdocsArgBoxSpinnerEl) gdocsArgBoxSpinnerEl.classList.remove('visible');
}

type GDocsResource = { name: string; size: string; type: "PDF" | "TXT" | "PNG" | "Text"; content: string };
const gdocsResources: GDocsResource[] = [];
const gdocsResourceSelected = new Set<GDocsResource>();

function formatGDocsTimestamp(sortKey: string): string {
  let ms: number;
  if (sortKey.startsWith("live-")) {
    ms = parseInt(sortKey.slice(5), 10);
  } else {
    ms = new Date(sortKey).getTime();
  }
  if (isNaN(ms)) return "";
  const d = new Date(ms);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const hour = d.getHours();
  const min = d.getMinutes().toString().padStart(2, "0");
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 || 12;
  return `${month} ${day}, ${h12}:${min} ${ampm}`;
}
let pdfDetected = false;
let pdfPanelEl: HTMLDivElement | null = null;
let pdfRunCb: (() => void) | null = null;
let pdfCachedLabel = false;
let pdfSummaryTabVisible = false;
let pdfSummaryCards: PdfSummaryCardItem[] = [];
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
let dashPublicFigureSelect: HTMLSelectElement | null = null;
let dashPublicFigureRow: HTMLDivElement | null = null;
let dashFontSelect: HTMLSelectElement | null = null;
let dashFontSizeSelect: HTMLSelectElement | null = null;
let dashLlmSelect: HTMLSelectElement | null = null;
let dashLlmNote: HTMLDivElement | null = null;
let dashLlmForm: HTMLDivElement | null = null;
let dashLlmKeyInput: HTMLInputElement | null = null;
let dashLlmModelInput: HTMLInputElement | null = null;
let dashLlmEffortSelect: HTMLSelectElement | null = null;
let dashLlmBaseUrlInput: HTMLInputElement | null = null;
let dashLlmSaveBtn: HTMLButtonElement | null = null;
let dashLlmDeleteBtn: HTMLButtonElement | null = null;
let dashLlmStatus: HTMLDivElement | null = null;
let dashLlmState: LlmStatusResponse | null = null;
let dashLlmStoredProvider: LlmProvider | null = null;
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
const pfDisplayNames = new Map<string, string>();
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
  const logoName = personality.startsWith("pf:") ? "Terry" : personality.charAt(0).toUpperCase() + personality.slice(1);
  if (bubbleLogoImgEl) {
    bubbleLogoImgEl.src = chrome.runtime.getURL(`${logoName}.png`);
    bubbleLogoImgEl.alt = logoName;
  }
  // A provider switch in the popup must refresh an already-open dashboard.
  // Skip self-writes: our own change handler already updated in-memory state.
  const oldPrefs = (changes.preferences.oldValue ?? {}) as Record<string, unknown>;
  if (
    prefs.llm_provider !== oldPrefs.llm_provider &&
    prefs.llm_provider !== (dashLlmState?.active_provider ?? dashLlmStoredProvider)
  ) {
    void loadDashLlmStatus();
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
      const logoName = personality.startsWith("pf:") ? "Terry" : personality.charAt(0).toUpperCase() + personality.slice(1);
      if (bubbleLogoImgEl) {
        bubbleLogoImgEl.src = chrome.runtime.getURL(`${logoName}.png`);
        bubbleLogoImgEl.alt = logoName;
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

  // ── Panel header ──
  const panelHeader = document.createElement("div");
  panelHeader.className = "args-panel-header";

  const mainTitle = document.createElement("span");
  mainTitle.className = "args-main-title";

  if (isGDocs()) {
    // Back arrow + doc title
    const backArrow = document.createElement("span");
    backArrow.className = "args-gdocs-back";
    backArrow.textContent = "←";
    backArrow.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    mainTitle.appendChild(backArrow);
    const titleText = document.createElement("span");
    titleText.className = "args-gdocs-title-text";
    titleText.textContent = getGDocsTitle();
    gdocsTitleEl = titleText;
    mainTitle.appendChild(titleText);
    // Keep title in sync if doc title changes
    gdocsTitleObs?.disconnect();
    gdocsTitleObs = new MutationObserver(() => {
      if (gdocsTitleEl) gdocsTitleEl.textContent = getGDocsTitle();
    });
    gdocsTitleObs.observe(document.querySelector("title") ?? document.head, { subtree: true, childList: true, characterData: true });
  } else {
    mainTitle.textContent = "Argument Box";
  }

  const headerIcons = document.createElement("div");
  headerIcons.className = "args-header-icons";

  // Dashboard (sliders) button — replaces old + button
  const dashboardBtn = document.createElement("button");
  dashboardBtn.className = "args-header-icon-btn";
  dashboardBtn.title = "Dashboard";
  dashboardBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="1" y1="5" x2="19" y2="5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="5" r="2.2" fill="currentColor"/><line x1="1" y1="10" x2="19" y2="10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="13" cy="10" r="2.2" fill="currentColor"/><line x1="1" y1="15" x2="19" y2="15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="15" r="2.2" fill="currentColor"/></svg>`;
  dashboardBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!expanded) toggle();
    showDashboard();
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

  const copyIconBtn = document.createElement("button");
  copyIconBtn.className = "args-header-icon-btn";
  copyIconBtn.title = "Copy";
  copyIconBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.4883 5.5H7.94922C6.59655 5.5 5.5 6.59655 5.5 7.94922V17.4883C5.5 18.8409 6.59655 19.9375 7.94922 19.9375H17.4883C18.8409 19.9375 19.9375 18.8409 19.9375 17.4883V7.94922C19.9375 6.59655 18.8409 5.5 17.4883 5.5Z" stroke="currentColor" stroke-width="1.375" stroke-linejoin="round"/><path d="M16.4785 5.5L16.5 4.46875C16.4982 3.83113 16.2441 3.22014 15.7932 2.76928C15.3424 2.31841 14.7314 2.06431 14.0938 2.0625H4.8125C4.08382 2.06465 3.38559 2.35508 2.87034 2.87034C2.35508 3.38559 2.06465 4.08382 2.0625 4.8125V14.0938C2.06431 14.7314 2.31841 15.3424 2.76928 15.7932C3.22014 16.2441 3.83113 16.4982 4.46875 16.5H5.5" stroke="currentColor" stroke-width="1.375" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  copyIconBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handleCopy(copyIconBtn);
  });

  headerIcons.appendChild(dashboardBtn);
  headerIcons.appendChild(exportIconBtn);
  headerIcons.appendChild(copyIconBtn);

  panelHeader.appendChild(mainTitle);
  panelHeader.appendChild(headerIcons);
  panelFace.appendChild(panelHeader);

  // ── GDocs persona subtitle ──
  if (isGDocs()) {
    const personaSubtitle = document.createElement("div");
    personaSubtitle.className = "args-gdocs-persona";
    const personaText = document.createElement("span");
    personaText.className = "args-gdocs-persona-text";
    personaText.textContent = `Writing with ${gdocsPersonaName}`;
    gdocsPersonaSubtitleEl = personaText;
    personaSubtitle.appendChild(personaText);
    panelFace.appendChild(personaSubtitle);
    // Load persona name from storage
    chrome.storage.local.get("preferences", (result) => {
      const prefs = result["preferences"] as Record<string, unknown> | undefined;
      const personality = (prefs?.depth_personality as string) ?? "terry";
      gdocsPersonaName = personality.charAt(0).toUpperCase() + personality.slice(1);
      if (gdocsPersonaSubtitleEl) {
        gdocsPersonaSubtitleEl.textContent = `Writing with ${gdocsPersonaName}`;
      }
    });
  }

  // ── Purpose section ──
  const purposeSection = document.createElement("div");
  purposeSection.className = "args-purpose-section";
  if (isGDocs()) purposeSection.style.display = "none";

  const purposeLabel = document.createElement("span");
  purposeLabel.className = "args-purpose-label";
  purposeLabel.textContent = getPurposeLabelText();
  purposeLabelEl = purposeLabel;

  const purposeInput = document.createElement("textarea");
  purposeInput.className = "args-purpose-input";
  purposeInput.placeholder = getPurposePlaceholderText();
  purposeInput.rows = 2;
  purposeInput.addEventListener("click", (e) => e.stopPropagation());
  purposeInput.addEventListener("input", () => {
    purposeInput.classList.remove("args-purpose-error");
    purposeInput.placeholder = getPurposePlaceholderText();
  });
  purposeInputEl = purposeInput;

  const purposeHelper = document.createElement("div");
  purposeHelper.className = "args-purpose-helper";
  purposeHelper.style.display = "none";
  purposeHelperEl = purposeHelper;

  purposeSection.appendChild(purposeLabel);
  purposeSection.appendChild(purposeInput);
  purposeSection.appendChild(purposeHelper);
  panelFace.appendChild(purposeSection);

  // ── Tab Bar ──
  tabBarEl = document.createElement("div");
  tabBarEl.className = isGDocs() ? "args-tab-bar args-tab-bar--gdocs" : "args-tab-bar";

  if (isGDocs()) {
    // GDocs tabs: Memo | Resource | Outline
    gdocsMemoTabBtn = document.createElement("button");
    gdocsMemoTabBtn.className = "args-gdocs-tab active";
    gdocsMemoTabBtn.textContent = "Memo";
    gdocsMemoTabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      gdocsActiveTab = "memo";
      gdocsMemoTabBtn!.classList.add("active");
      gdocsResourceTabBtn!.classList.remove("active");
      gdocsOutlineTabBtn!.classList.remove("active");
      if (listEl) listEl.style.display = "";
      if (gdocsResourcePanelEl) gdocsResourcePanelEl.style.display = "none";
      if (gdocsOutlinePanelEl) gdocsOutlinePanelEl.style.display = "none";
    });

    gdocsResourceTabBtn = document.createElement("button");
    gdocsResourceTabBtn.className = "args-gdocs-tab";
    gdocsResourceTabBtn.textContent = "Context";
    gdocsResourceTabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      gdocsActiveTab = "resource";
      gdocsMemoTabBtn!.classList.remove("active");
      gdocsResourceTabBtn!.classList.add("active");
      gdocsOutlineTabBtn!.classList.remove("active");
      if (listEl) listEl.style.display = "none";
      if (gdocsResourcePanelEl) gdocsResourcePanelEl.style.display = "";
      if (gdocsOutlinePanelEl) gdocsOutlinePanelEl.style.display = "none";
    });

    gdocsOutlineTabBtn = document.createElement("button");
    gdocsOutlineTabBtn.className = "args-gdocs-tab";
    gdocsOutlineTabBtn.textContent = "Outline";
    gdocsOutlineTabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      gdocsActiveTab = "outline";
      gdocsMemoTabBtn!.classList.remove("active");
      gdocsResourceTabBtn!.classList.remove("active");
      gdocsOutlineTabBtn!.classList.add("active");
      if (listEl) listEl.style.display = "none";
      if (gdocsResourcePanelEl) gdocsResourcePanelEl.style.display = "none";
      if (gdocsOutlinePanelEl) gdocsOutlinePanelEl.style.display = "";
    });

    tabBarEl.appendChild(gdocsMemoTabBtn);
    tabBarEl.appendChild(gdocsResourceTabBtn);
    tabBarEl.appendChild(gdocsOutlineTabBtn);
  } else {
    notesTabBtn = document.createElement("button");
    notesTabBtn.className = "args-tab active";
    notesTabBtn.textContent = "Notes";
    notesTabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      switchTab("notes");
    });

    sketchTabBtn = document.createElement("button");
    sketchTabBtn.className = "args-tab";
    sketchTabBtn.textContent = isChatbotMode ? "Prompt" : "Sketch";
    sketchTabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      switchTab("sketch");
    });

    tabBarEl.appendChild(notesTabBtn);
    tabBarEl.appendChild(sketchTabBtn);
    pdfSummaryTabBtn = document.createElement("button");
    pdfSummaryTabBtn.className = "args-tab";
    pdfSummaryTabBtn.textContent = "Summaries";
    pdfSummaryTabBtn.style.display = "none";
    pdfSummaryTabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      switchTab("summaries");
    });
    tabBarEl.appendChild(pdfSummaryTabBtn);
  }
  panelFace.appendChild(tabBarEl);

  // ── List ──
  listEl = document.createElement("div");
  listEl.className = "args-list";
  panelFace.appendChild(listEl);
  renderList();

  // ── GDocs Resource Panel ──
  if (isGDocs()) {
    gdocsResourcePanelEl = document.createElement("div");
    gdocsResourcePanelEl.className = "args-gdocs-resource-panel";
    gdocsResourcePanelEl.style.display = "none";

    const saveResources = () => {
      const key = `gdocsResources_${getPageUrl()}`;
      chrome.storage.local.set({ [key]: gdocsResources }).catch(() => {});
    };

    const renderResourceList = () => {
      gdocsResourcePanelEl!.innerHTML = "";

      // Ensure all newly-added resources start selected
      for (const res of gdocsResources) {
        if (!gdocsResourceSelected.has(res)) gdocsResourceSelected.add(res);
      }

      // Existing resources
      const resourceList = document.createElement("div");
      resourceList.className = "args-gdocs-resource-list";

      // ── Select All row ──
      const selectAllRow = document.createElement("div");
      selectAllRow.className = "args-gdocs-select-all-row";
      selectAllRow.style.cursor = "pointer";

      const selectAllChk = document.createElement("input");
      selectAllChk.type = "checkbox";
      selectAllChk.className = "args-gdocs-checkbox";
      selectAllChk.style.pointerEvents = "none";
      const allSelected = gdocsResources.length > 0 && gdocsResources.every(r => gdocsResourceSelected.has(r));
      selectAllChk.checked = allSelected;
      selectAllChk.indeterminate = !allSelected && gdocsResources.some(r => gdocsResourceSelected.has(r));

      const selectAllLabel = document.createElement("span");
      selectAllLabel.className = "args-gdocs-select-all-label";
      selectAllLabel.textContent = "Select All";

      selectAllRow.addEventListener("click", (e) => {
        e.stopPropagation();
        const shouldSelect = !selectAllChk.checked || selectAllChk.indeterminate;
        if (shouldSelect) {
          gdocsResources.forEach(r => gdocsResourceSelected.add(r));
          selectAllChk.checked = true;
          selectAllChk.indeterminate = false;
        } else {
          gdocsResources.forEach(r => gdocsResourceSelected.delete(r));
          selectAllChk.checked = false;
          selectAllChk.indeterminate = false;
        }
        // Update individual checkboxes in-place
        resourceList.querySelectorAll<HTMLInputElement>(".args-gdocs-resource-item .args-gdocs-checkbox").forEach((chk) => {
          chk.checked = shouldSelect;
        });
      });

      selectAllRow.appendChild(selectAllChk);
      selectAllRow.appendChild(selectAllLabel);
      resourceList.appendChild(selectAllRow);

      // Divider after select all
      const selectAllDivider = document.createElement("div");
      selectAllDivider.className = "args-gdocs-resource-divider";
      resourceList.appendChild(selectAllDivider);

      // ── Individual resource items ──
      for (const res of gdocsResources) {
        const item = document.createElement("div");
        item.className = "args-gdocs-resource-item";

        // Checkbox
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.className = "args-gdocs-checkbox";
        chk.checked = gdocsResourceSelected.has(res);
        chk.addEventListener("change", (e) => {
          e.stopPropagation();
          if (chk.checked) gdocsResourceSelected.add(res);
          else gdocsResourceSelected.delete(res);
          // Update select-all state without full re-render
          const allNow = gdocsResources.every(r => gdocsResourceSelected.has(r));
          const someNow = gdocsResources.some(r => gdocsResourceSelected.has(r));
          selectAllChk.checked = allNow;
          selectAllChk.indeterminate = !allNow && someNow;
        });

        // Text content
        const textCol = document.createElement("div");
        textCol.className = "args-gdocs-resource-text-col";
        const name = document.createElement("div");
        name.className = "args-gdocs-resource-name";
        name.textContent = res.name;
        const meta = document.createElement("div");
        meta.className = "args-gdocs-resource-meta";
        if (res.type === "Text") {
          textCol.appendChild(name);
          if (res.content) {
            const preview = document.createElement("div");
            preview.className = "args-gdocs-resource-preview";
            preview.textContent = res.content;
            textCol.appendChild(preview);
          }
        } else {
          meta.textContent = `${res.size} · ${res.type}`;
          textCol.appendChild(name);
          textCol.appendChild(meta);
        }

        // Three-dot menu
        const menuBtn = document.createElement("button");
        menuBtn.className = "args-gdocs-resource-menu-btn";
        menuBtn.textContent = "⋮";
        menuBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          // Remove existing open menus
          document.querySelectorAll(".args-gdocs-resource-dropdown").forEach(el => el.remove());
          const dropdown = document.createElement("div");
          dropdown.className = "args-gdocs-resource-dropdown";
          const deleteOpt = document.createElement("button");
          deleteOpt.className = "args-gdocs-resource-dropdown-item args-gdocs-resource-dropdown-item--delete";
          deleteOpt.textContent = "Delete";
          deleteOpt.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const idx = gdocsResources.indexOf(res);
            if (idx !== -1) {
              gdocsResources.splice(idx, 1);
              gdocsResourceSelected.delete(res);
            }
            dropdown.remove();
            saveResources();
            renderResourceList();
          });
          dropdown.appendChild(deleteOpt);
          menuBtn.style.position = "relative";
          menuBtn.appendChild(dropdown);
          const closeMenu = (ev: MouseEvent) => {
            if (!dropdown.contains(ev.target as Node)) {
              dropdown.remove();
              document.removeEventListener("click", closeMenu);
            }
          };
          setTimeout(() => document.addEventListener("click", closeMenu), 0);
        });

        item.appendChild(chk);
        item.appendChild(textCol);
        item.appendChild(menuBtn);

        const divider = document.createElement("div");
        divider.className = "args-gdocs-resource-divider";
        resourceList.appendChild(item);
        resourceList.appendChild(divider);
      }
      gdocsResourcePanelEl!.appendChild(resourceList);

      // New Resource form
      const newSection = document.createElement("div");
      newSection.className = "args-gdocs-new-resource";

      const newTitle = document.createElement("div");
      newTitle.className = "args-gdocs-new-resource-title";
      newTitle.textContent = "New Context";
      newSection.appendChild(newTitle);

      // Name input
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "args-gdocs-resource-name-input";
      nameInput.placeholder = "Name";
      nameInput.addEventListener("click", (e) => e.stopPropagation());
      nameInput.addEventListener("keydown", (e) => e.stopPropagation());
      newSection.appendChild(nameInput);

      // Radio row
      const radioRow = document.createElement("div");
      radioRow.className = "args-gdocs-radio-row";
      const uid = `res-${Date.now()}`;

      const pasteRadio = document.createElement("input");
      pasteRadio.type = "radio"; pasteRadio.name = uid; pasteRadio.id = `${uid}-paste`; pasteRadio.checked = true;
      const pasteLabel = document.createElement("label");
      pasteLabel.htmlFor = `${uid}-paste`; pasteLabel.textContent = "Paste text";

      const fileRadio = document.createElement("input");
      fileRadio.type = "radio"; fileRadio.name = uid; fileRadio.id = `${uid}-file`;
      const fileLabel = document.createElement("label");
      fileLabel.htmlFor = `${uid}-file`; fileLabel.textContent = "File upload";

      radioRow.appendChild(pasteRadio);
      radioRow.appendChild(pasteLabel);
      radioRow.appendChild(fileRadio);
      radioRow.appendChild(fileLabel);
      newSection.appendChild(radioRow);

      // Text area (always visible, used for paste text or file preview)
      const textInput = document.createElement("textarea");
      textInput.className = "args-gdocs-resource-textarea";
      textInput.placeholder = "Write here...";
      textInput.addEventListener("click", (e) => e.stopPropagation());
      textInput.addEventListener("keydown", (e) => e.stopPropagation());
      newSection.appendChild(textInput);

      // File input (hidden trigger)
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".txt,.md,.pdf,.doc,.docx,.png,.jpg";
      fileInput.style.display = "none";
      newSection.appendChild(fileInput);

      // Track pending file for preview
      let pendingFile: File | null = null;

      pasteRadio.addEventListener("change", () => {
        pendingFile = null;
        textInput.value = "";
        textInput.disabled = false;
        textInput.placeholder = "Write here...";
        textInput.style.color = "";
      });
      fileRadio.addEventListener("change", () => {
        fileInput.value = "";
        fileInput.click();
      });
      fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (!file) {
          // User cancelled picker — revert to paste
          pasteRadio.checked = true;
          pendingFile = null;
          textInput.disabled = false;
          textInput.placeholder = "Write here...";
          textInput.style.color = "";
          return;
        }
        const size = file.size > 1024 * 1024
          ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
          : `${(file.size / 1024).toFixed(0)} KB`;
        pendingFile = file;
        textInput.disabled = true;
        textInput.value = `${file.name}  (${size})`;
        textInput.style.color = "#9A9DA3";
      });

      // Save row
      const saveRow = document.createElement("div");
      saveRow.className = "args-gdocs-resource-save-row";
      const saveBtn = document.createElement("button");
      saveBtn.className = "args-gdocs-resource-save-btn";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pendingFile) {
          const file = pendingFile;
          const ext = file.name.split(".").pop()?.toUpperCase() ?? "FILE";
          const size = file.size > 1024 * 1024
            ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
            : `${(file.size / 1024).toFixed(0)} KB`;
          const reader = new FileReader();
          reader.onload = () => {
            const content = ((reader.result as string) ?? "").slice(0, 8000);
            gdocsResources.push({ name: file.name, size, type: ext as GDocsResource["type"], content });
            saveResources();
            renderResourceList();
          };
          reader.onerror = () => {
            gdocsResources.push({ name: file.name, size, type: ext as GDocsResource["type"], content: "" });
            saveResources();
            renderResourceList();
          };
          reader.readAsText(file);
        } else {
          const text = textInput.value.trim();
          if (!text) return;
          const name = nameInput.value.trim() || "Untitled";
          gdocsResources.push({ name, size: "", type: "Text", content: text });
          saveResources();
          renderResourceList();
        }
      });
      saveRow.appendChild(saveBtn);
      newSection.appendChild(saveRow);

      gdocsResourcePanelEl!.appendChild(newSection);
    };

    // Load persisted resources for this page
    const storageKey = `gdocsResources_${getPageUrl()}`;
    chrome.storage.local.get(storageKey).then((stored) => {
      const saved = stored[storageKey];
      if (Array.isArray(saved)) {
        gdocsResources.push(...saved);
      }
      renderResourceList();
    }).catch(() => renderResourceList());
    panelFace.appendChild(gdocsResourcePanelEl);

    // ── GDocs Outline Panel ──
    gdocsOutlinePanelEl = document.createElement("div");
    gdocsOutlinePanelEl.className = "args-gdocs-outline-panel";
    gdocsOutlinePanelEl.style.display = "none";


    gdocsOutlineTextEl = document.createElement("div");
    gdocsOutlineTextEl.className = "args-gdocs-outline-text";
    setOutlineText(gdocsOutlineTextEl, "No outline yet. Submit a request in Plan mode to generate one.");
    gdocsOutlinePanelEl.appendChild(gdocsOutlineTextEl);

    // ── Continue / Reject / Other buttons ──
    const outlineActions = document.createElement("div");
    outlineActions.className = "args-gdocs-outline-actions";

    const continueBtn = document.createElement("button");
    gdocsOutlineContinueBtn = continueBtn;
    continueBtn.className = "args-gdocs-outline-btn args-gdocs-outline-btn-continue";
    continueBtn.textContent = "Continue";
    continueBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent("oddity:gdocs:outline:continue"));
    });

    const rejectBtn = document.createElement("button");
    gdocsOutlineRejectBtn = rejectBtn;
    rejectBtn.className = "args-gdocs-outline-btn args-gdocs-outline-btn-secondary";
    rejectBtn.textContent = "Reject";
    rejectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent("oddity:gdocs:outline:reject"));
      // Reset outline panel to empty state
      if (gdocsOutlineTextEl) setOutlineText(gdocsOutlineTextEl, "No outline yet. Submit a request in Plan mode to generate one.");
      outlineOtherArea.style.display = "none";
      outlineActions.style.display = "";
    });

    const otherBtn = document.createElement("button");
    gdocsOutlineOtherBtn = otherBtn;
    otherBtn.className = "args-gdocs-outline-btn args-gdocs-outline-btn-secondary";
    otherBtn.textContent = "Other";
    otherBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      outlineActions.style.display = "none";
      outlineOtherArea.style.display = "";
      outlineFeedbackInput.focus();
    });

    outlineActions.appendChild(continueBtn);
    outlineActions.appendChild(rejectBtn);
    outlineActions.appendChild(otherBtn);
    gdocsOutlinePanelEl.appendChild(outlineActions);

    // ── "Other" feedback area ──
    const outlineOtherArea = document.createElement("div");
    outlineOtherArea.className = "args-gdocs-outline-other";
    outlineOtherArea.style.display = "none";

    const outlineFeedbackInput = document.createElement("textarea");
    outlineFeedbackInput.className = "args-gdocs-outline-feedback";
    outlineFeedbackInput.placeholder = "What would you like to change about this plan?";
    outlineFeedbackInput.rows = 3;
    outlineFeedbackInput.addEventListener("click", (e) => e.stopPropagation());
    outlineFeedbackInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitFeedback();
      }
      e.stopPropagation();
    });

    const submitFeedbackBtn = document.createElement("button");
    submitFeedbackBtn.className = "args-gdocs-outline-btn args-gdocs-outline-btn-continue";
    submitFeedbackBtn.textContent = "Regenerate →";

    const cancelFeedbackBtn = document.createElement("button");
    cancelFeedbackBtn.className = "args-gdocs-outline-btn args-gdocs-outline-btn-secondary";
    cancelFeedbackBtn.textContent = "Back";
    cancelFeedbackBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      outlineOtherArea.style.display = "none";
      outlineActions.style.display = "";
    });

    const submitFeedback = () => {
      const feedback = outlineFeedbackInput.value.trim();
      if (!feedback) return;
      outlineFeedbackInput.value = "";
      outlineOtherArea.style.display = "none";
      outlineActions.style.display = "";
      document.dispatchEvent(new CustomEvent("oddity:gdocs:outline:other", { detail: { feedback } }));
    };

    submitFeedbackBtn.addEventListener("click", (e) => { e.stopPropagation(); submitFeedback(); });

    const outlineFeedbackRow = document.createElement("div");
    outlineFeedbackRow.className = "args-gdocs-outline-feedback-row";
    outlineFeedbackRow.appendChild(cancelFeedbackBtn);
    outlineFeedbackRow.appendChild(submitFeedbackBtn);

    outlineOtherArea.appendChild(outlineFeedbackInput);
    outlineOtherArea.appendChild(outlineFeedbackRow);
    gdocsOutlinePanelEl.appendChild(outlineOtherArea);

    panelFace.appendChild(gdocsOutlinePanelEl);
  }

  // ── Sketch Content ──
  sketchContentEl = document.createElement("div");
  sketchContentEl.className = "args-sketch-content";
  sketchContentEl.style.display = "none";
  panelFace.appendChild(sketchContentEl);

  pdfSummaryListEl = document.createElement("div");
  pdfSummaryListEl.className = "args-pdf-summary-list";
  pdfSummaryListEl.style.display = "none";
  panelFace.appendChild(pdfSummaryListEl);
  renderPdfSummaryList();

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

  // Collapse GDocs expanded card when clicking outside
  document.addEventListener("click", (e) => {
    if (!gdocsExpandedCardId) return;
    const expandedCard = listEl?.querySelector<HTMLDivElement>(`.gdocs-arg-card--expanded`);
    if (expandedCard && !expandedCard.contains(e.target as Node)) {
      expandedCard.classList.remove("gdocs-arg-card--expanded");
      const nextDivider = expandedCard.nextElementSibling;
      if (nextDivider?.classList.contains("gdocs-arg-divider")) {
        (nextDivider as HTMLElement).style.display = "";
      }
      gdocsExpandedCardId = null;
      if (listEl) listEl.style.overflow = "";
    }
  });

  if (isGDocs()) {
    // ── GDocs chat section (replaces footer) ──
    const chatSection = document.createElement("div");
    chatSection.className = "args-gdocs-chat-section";
    chatSection.addEventListener("click", (e) => e.stopPropagation());

    // ── Input area (textarea + bar) ──
    const chatInputArea = document.createElement("div");
    chatInputArea.className = "args-gdocs-chat-input-area";
    gdocsChatInputAreaEl = chatInputArea;

    const chatBox = document.createElement("div");
    chatBox.className = "args-gdocs-chat-box";

    const spinner = document.createElement("div");
    spinner.className = "args-gdocs-spinner";
    chatBox.appendChild(spinner);
    gdocsArgBoxSpinnerEl = spinner;

    // "Memo ×" pill (shown when memo edit mode is active)
    const memoPill = document.createElement("div");
    memoPill.className = "args-gdocs-memo-pill";
    memoPill.style.display = "none";
    const memoPillText = document.createElement("span");
    memoPillText.textContent = "Memo";
    const memoPillX = document.createElement("button");
    memoPillX.className = "args-gdocs-memo-pill-x";
    memoPillX.textContent = "×";
    memoPillX.addEventListener("click", (e) => {
      e.stopPropagation();
      gdocsMemoEditMode = false;
      gdocsMemoSelected.clear();
      memoPill.style.display = "none";
      lastRenderedKey = "";
      renderList();
    });
    memoPill.appendChild(memoPillText);
    memoPill.appendChild(memoPillX);
    gdocsMemoPillEl = memoPill;
    chatBox.appendChild(memoPill);

    const chatTextarea = document.createElement("textarea");
    chatTextarea.className = "args-gdocs-chat-textarea";
    chatTextarea.placeholder = "Rewrite my essay into ...";
    chatTextarea.rows = 3;
    chatTextarea.addEventListener("click", (e) => e.stopPropagation());
    chatTextarea.addEventListener("keydown", (e) => e.stopPropagation());
    gdocsChatTextarea = chatTextarea;
    chatBox.appendChild(chatTextarea);

    const chatBar = document.createElement("div");
    chatBar.className = "args-gdocs-chat-bar";

    // "Use Memo for edit" toggle button
    const modePills = document.createElement("div");
    modePills.className = "args-gdocs-mode-pills";

    const memoPillBtn = document.createElement("button");
    memoPillBtn.className = "args-gdocs-pill-btn active";
    memoPillBtn.textContent = "Use Memo for edit";
    gdocsMemoModeBtn = memoPillBtn;

    memoPillBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Switch to Memo tab
      gdocsActiveTab = "memo";
      gdocsMemoTabBtn!.classList.add("active");
      gdocsResourceTabBtn!.classList.remove("active");
      gdocsOutlineTabBtn!.classList.remove("active");
      if (listEl) listEl.style.display = "";
      if (gdocsResourcePanelEl) gdocsResourcePanelEl.style.display = "none";
      if (gdocsOutlinePanelEl) gdocsOutlinePanelEl.style.display = "none";
      // Enable memo edit mode — select all memos
      gdocsMemoEditMode = true;
      gdocsMemoSelected.clear();
      const allItems = [...canonicalItems, ...liveItems].filter(i => i.type === "reply" || i.type === "manual");
      allItems.forEach(i => gdocsMemoSelected.add(i.sortKey));
      if (gdocsMemoPillEl) gdocsMemoPillEl.style.display = "";
      renderList();
    });

    modePills.appendChild(memoPillBtn);

    // Auto / Plan dropdown
    const dropdownWrap = document.createElement("div");
    dropdownWrap.className = "args-gdocs-dropdown-wrap";

    const dropdownBtn = document.createElement("button");
    dropdownBtn.className = "args-gdocs-dropdown-btn";
    dropdownBtn.textContent = "Auto ↓";
    gdocsModeDropdownBtn = dropdownBtn;

    const dropdownMenu = document.createElement("div");
    dropdownMenu.className = "args-gdocs-dropdown-menu";
    dropdownMenu.style.display = "none";
    gdocsModeDropdownMenu = dropdownMenu;

    const modes: Array<{ key: "auto" | "fast" | "plan"; label: string }> = [
      { key: "auto", label: "Auto" },
      { key: "fast", label: "Fast" },
      { key: "plan", label: "Plan" },
    ];

    const optionEls: HTMLButtonElement[] = [];

    const setMode = (key: "auto" | "fast" | "plan") => {
      gdocsChatMode = key;
      const chosen = modes.find(m => m.key === key)!;
      dropdownBtn.textContent = `${chosen.label} ↓`;
      optionEls.forEach((el, i) => el.classList.toggle("active", modes[i]!.key === key));
      dropdownMenu.style.display = "none";
    };

    for (const m of modes) {
      const opt = document.createElement("button");
      opt.className = "args-gdocs-dropdown-option" + (m.key === "auto" ? " active" : "");
      opt.textContent = m.label;
      opt.addEventListener("click", (e) => { e.stopPropagation(); setMode(m.key); });
      optionEls.push(opt);
      dropdownMenu.appendChild(opt);
    }

    dropdownBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdownMenu.style.display = dropdownMenu.style.display === "none" ? "" : "none";
    });
    document.addEventListener("click", () => { if (gdocsModeDropdownMenu) gdocsModeDropdownMenu.style.display = "none"; });

    dropdownWrap.appendChild(dropdownBtn);
    dropdownWrap.appendChild(dropdownMenu);

    // Send button
    const sendBtn = document.createElement("button");
    sendBtn.className = "args-gdocs-send-btn";
    sendBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 12 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.05377 0.219671C5.76087 -0.0732222 5.286 -0.0732222 4.99311 0.219671L0.220136 4.99264C-0.0727572 5.28553 -0.0727572 5.76041 0.220136 6.0533C0.51303 6.3462 0.987903 6.3462 1.2808 6.0533L5.52344 1.81066L9.76608 6.0533C10.059 6.3462 10.5338 6.3462 10.8267 6.0533C11.1196 5.76041 11.1196 5.28553 10.8267 4.99264L6.05377 0.219671ZM5.52344 15.75H6.27344L6.27344 0.750001H5.52344H4.77344L4.77344 15.75H5.52344Z" fill="white"/></svg>`;
    sendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const text = chatTextarea.value.trim();
      if (!text) return;
      chatTextarea.value = "";

      const serializedResources = gdocsResources
        .filter(r => r.content && gdocsResourceSelected.has(r))
        .map(r => ({ name: r.name, content: r.content }));
      const allMemoItems = [...canonicalItems, ...liveItems].filter(i => i.type === "reply" || i.type === "manual");
      const serializedMemos = (gdocsMemoEditMode
        ? allMemoItems.filter(i => gdocsMemoSelected.has(i.sortKey))
        : allMemoItems
      ).map(i => ({ note: i.replyFullNote ?? i.replyHeader ?? "", reply: i.text }));

      startArgBoxLoading(chatTextarea);
      if (gdocsChatMode === "plan") {
        document.dispatchEvent(new CustomEvent("oddity:gdocs:planmode", {
          detail: { topic: text, resources: serializedResources, memos: serializedMemos, fastMode: false }
        }));
      } else {
        document.dispatchEvent(new CustomEvent("oddity:gdocs:chat", {
          detail: { text, memoMode: gdocsMemoMode, resources: serializedResources, memos: serializedMemos, fastMode: gdocsChatMode === "fast" }
        }));
      }
    });

    chatBar.appendChild(modePills);
    chatBar.appendChild(sendBtn);
    chatBox.appendChild(chatBar);
    chatInputArea.appendChild(chatBox);
    chatSection.appendChild(chatInputArea);

    panelFace.appendChild(chatSection);

    // ── MCQ event listeners (MCQ renders centered on screen; these manage loading state) ──
    document.addEventListener("oddity:gdocs:mcq:question", () => {
      stopArgBoxLoading(chatTextarea);
    });

    document.addEventListener("oddity:gdocs:mcq:done", () => {
      stopArgBoxLoading(chatTextarea);
    });

    document.addEventListener("oddity:gdocs:loading", () => {
      startArgBoxLoading(chatTextarea);
      if (gdocsOutlineContinueBtn) gdocsOutlineContinueBtn.disabled = true;
      if (gdocsOutlineRejectBtn) gdocsOutlineRejectBtn.disabled = true;
      if (gdocsOutlineOtherBtn) gdocsOutlineOtherBtn.disabled = true;
    });

    document.addEventListener("oddity:gdocs:loading:done", () => {
      stopArgBoxLoading(chatTextarea);
      if (gdocsOutlineContinueBtn) gdocsOutlineContinueBtn.disabled = false;
      if (gdocsOutlineRejectBtn) gdocsOutlineRejectBtn.disabled = false;
      if (gdocsOutlineOtherBtn) gdocsOutlineOtherBtn.disabled = false;
    });

    // ── Outline ready: switch to Outline tab and display content ──
    document.addEventListener("oddity:gdocs:outline:ready", (e: Event) => {
      const { outline } = (e as CustomEvent<{ outline: string }>).detail;
      gdocsCurrentOutlineText = outline;
      if (gdocsOutlineTextEl) setOutlineText(gdocsOutlineTextEl, outline);
      stopArgBoxLoading(chatTextarea);
      // Switch to Outline tab
      gdocsActiveTab = "outline";
      gdocsMemoTabBtn?.classList.remove("active");
      gdocsResourceTabBtn?.classList.remove("active");
      gdocsOutlineTabBtn?.classList.add("active");
      if (listEl) listEl.style.display = "none";
      if (gdocsResourcePanelEl) gdocsResourcePanelEl.style.display = "none";
      if (gdocsOutlinePanelEl) gdocsOutlinePanelEl.style.display = "";
    });

    // Auto-expand when a Google Doc is activated
    document.addEventListener("oddity:gdocs:activated", () => {
      if (!expanded) toggle();
    });
  } else {
    // ── Standard footer ──
    footerEl = document.createElement("div");
    const footer = footerEl;
    footer.className = "args-footer";

    const sketchBtn = document.createElement("button");
    sketchBtn.className = "args-sketch-btn";
    sketchBtn.textContent = getSketchActionLabel();
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
  }

  contentClip.appendChild(panelFace);
  contentClip.appendChild(buildDashboardFace());
  containerEl.appendChild(contentClip);

  // Track mouse position — show controls only when near the top header zone
  containerEl.addEventListener("mousemove", (e) => {
    if (!expanded) return;
    const rect = containerEl!.getBoundingClientRect();
    const inTopZone = e.clientY < rect.top + 70;
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
        // Skip dimming on PDF-converted pages — the meta tag marks them as
        // already converted and the annotation pipeline runs regardless of whitelist.
        const isPdfConverted = !!document.querySelector(
          'meta[name="oddity-source-pdf"]',
        );
        if (!siteEnabled && !isPdfConverted) {
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
    !isGDocs() &&
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
        chrome.storage.local.set({
          enableBubbleSnoozeRemaining: remaining - 1,
        });
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

export function setPdfSummaryTabVisible(visible: boolean): void {
  pdfSummaryTabVisible = visible;
  if (pdfSummaryTabBtn) {
    pdfSummaryTabBtn.style.display = visible ? "" : "none";
  }
  renderPdfSummaryList();
  if (!visible && activeTab === "summaries") {
    switchTab("notes");
  }
}

export function updatePdfSummaryCards(cards: PdfSummaryCardItem[]): void {
  pdfSummaryCards = cards;
  renderPdfSummaryList();
}

export function scrollPdfSummaryToPage(pageNo: string): void {
  if (!pdfSummaryListEl) return;
  const cards = pdfSummaryListEl.querySelectorAll<HTMLElement>(".args-pdf-summary-card");
  for (const card of cards) {
    const isTarget = card.dataset.pageNo === pageNo;
    card.classList.toggle("args-pdf-summary-card--active", isTarget);
    if (isTarget) {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}


export function setPdfCachedLabel(cached: boolean): void {
  pdfCachedLabel = cached;
}

/** Reset the PDF overlay button to its initial state (e.g. after an error). */
export function resetPdfButton(errorMsg?: string): void {
  if (!pdfPanelEl) return;
  const btn = pdfPanelEl.querySelector<HTMLButtonElement>(".args-run-btn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = pdfCachedLabel ? "See annotations" : "Run Oddity1";
  }
  if (errorMsg) {
    const hint = pdfPanelEl.querySelector<HTMLDivElement>(
      ".args-not-enabled-hint",
    );
    if (hint) {
      hint.textContent = errorMsg;
      hint.style.color = "#E3474C";
    }
  }
}

export function setManualRunCallback(cb: () => void): void {
  manualRunCb = cb;
}

export function setInputTextProvider(cb: () => string): void {
  inputTextProviderCb = cb;
}

function getPurposeLabelText(): string {
  return isChatbotMode ? "Prompt goal" : "Purpose:";
}

function getPurposePlaceholderText(): string {
  return isChatbotMode
    ? getChatbotPromptGoalPlaceholder(chatbotDisplayName)
    : "Why are you reading this?";
}

function getPurposeValidationPlaceholderText(): string {
  return isChatbotMode
    ? "Please enter your prompt goal"
    : "Please fill in your purpose first";
}

function getSketchActionLabel(): string {
  return isChatbotMode
    ? getChatbotBuildPromptLabel(chatbotDisplayName)
    : "Sketch my Argument";
}

function getSketchLoadingLabel(): string {
  return isChatbotMode
    ? getChatbotPromptLoadingLabel(chatbotDisplayName)
    : "Sketching...";
}

function getSketchErrorText(): string {
  return isChatbotMode
    ? getChatbotPromptErrorText(chatbotDisplayName)
    : "Failed to generate sketch. Please try again.";
}

function renderPromptEmptyState(): void {
  if (!sketchContentEl || !isChatbotMode || sketchViewState !== "idle") return;

  const wrapper = document.createElement("div");
  wrapper.className = "args-prompt-empty";

  const title = document.createElement("div");
  title.className = "args-prompt-empty-title";
  title.textContent = getChatbotPromptEmptyStateTitle(chatbotDisplayName);

  const body = document.createElement("div");
  body.className = "args-prompt-empty-body";
  body.textContent = getChatbotPromptEmptyStateBody(chatbotDisplayName);

  wrapper.appendChild(title);
  wrapper.appendChild(body);
  sketchContentEl.replaceChildren(wrapper);
}

function syncChatbotUi(): void {
  if (purposeLabelEl) {
    purposeLabelEl.textContent = getPurposeLabelText();
  }
  if (purposeInputEl) {
    purposeInputEl.placeholder = getPurposePlaceholderText();
  }
  if (purposeHelperEl) {
    if (isChatbotMode) {
      purposeHelperEl.textContent =
        getChatbotPromptGoalHelper(chatbotDisplayName);
      purposeHelperEl.style.display = "";
    } else {
      purposeHelperEl.textContent = "";
      purposeHelperEl.style.display = "none";
    }
  }
  if (sketchBtnEl) {
    sketchBtnEl.textContent = getSketchActionLabel();
  }
  if (sketchTabBtn) {
    sketchTabBtn.textContent = isChatbotMode ? "Prompt" : "Sketch";
  }
  if (isChatbotMode && sketchViewState === "idle" && !sketchBuffer) {
    renderPromptEmptyState();
  }
}

export function appendSketchChunk(text: string, done: boolean): void {
  if (!sketchContentEl) return;
  if (text) {
    sketchViewState = "ready";
    sketchBuffer += text;
    sketchContentEl.innerHTML = renderMarkdown(sketchBuffer);
    sketchContentEl.scrollTop = sketchContentEl.scrollHeight;
  }
  if (done) {
    sketchViewState = "ready";
    sketchLoading = false;
    if (sketchBtnEl) {
      sketchBtnEl.disabled = false;
      sketchBtnEl.textContent = getSketchActionLabel();
    }
    if (isChatbotMode && chatbotInputSelector && sketchBuffer) {
      pasteIntoChatbot(chatbotInputSelector, sketchBuffer);
      document.dispatchEvent(new CustomEvent("oddity:optimizePromptDone", { detail: { success: true } }));
    }
  }
}


export function setChatbotMode(
  inputSelector: string,
  displayName: string | null = null,
): void {
  isChatbotMode = true;
  chatbotInputSelector = inputSelector;
  chatbotDisplayName = displayName;
  if (!sketchBuffer) {
    sketchViewState = "idle";
  }
  syncChatbotUi();
}

export function pasteIntoChatbot(selector: string, text: string): void {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return;

  el.focus();

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (el.isContentEditable) {
    // Clear via execCommand (not textContent) so the editor's Parchment/internal
    // model stays in sync with the DOM.
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    // Insert as a single insertHTML call — one atomic DOM operation.
    // The loop-based approach (insertText + insertParagraph per line) is
    // unreliable with Quill: its MutationObserver fires between each execCommand
    // call and desynchronises the internal Selection, silently dropping lines 2+.
    // insertHTML delivers the entire content at once; Quill processes it in one
    // MutationObserver batch and normalises correctly.
    const html = text
      .split("\n")
      .map((line) => {
        const escaped = line
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `<p>${escaped || "<br>"}</p>`;
      })
      .join("");
    document.execCommand("insertHTML", false, html);
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
  if (personality.startsWith("pf:")) {
    // Public figure: deactivate core buttons, select in dropdown, use Terry avatar
    dashDensityBtns.forEach((b) => b.classList.remove("args-dash-density-active"));
    if (dashPublicFigureSelect) {
      dashPublicFigureSelect.value = personality;
      const pfDisplayName = pfDisplayNames.get(personality) ?? "Public Figure";
      if (dashPersonaSelect) dashPersonaSelect.textContent = pfDisplayName;
    }
    if (dashPersonaAvatarImgEl) {
      dashPersonaAvatarImgEl.src = chrome.runtime.getURL("Terry.png");
      dashPersonaAvatarImgEl.alt = "Terry";
    }
    if (dashPersonaCircleEl) dashPersonaCircleEl.style.background = "#fff";
    if (bubbleLogoImgEl) {
      bubbleLogoImgEl.src = chrome.runtime.getURL("Terry.png");
      bubbleLogoImgEl.alt = "Terry";
    }
    return;
  }

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
  if (dashPublicFigureSelect) dashPublicFigureSelect.value = "";
  if (bubbleLogoImgEl) {
    bubbleLogoImgEl.src = chrome.runtime.getURL(`${display}.png`);
    bubbleLogoImgEl.alt = display;
  }
}

export function setSignOutCallback(cb: () => void): void {
  signOutCb = cb;
}

/** Populate the public figure dropdown from the personas list. */
export function setPublicFigurePersonas(
  personas: Array<{ slug: string; displayName: string }>,
): void {
  // Always populate display name map (used even before dropdown is built)
  pfDisplayNames.clear();
  for (const p of personas) {
    pfDisplayNames.set(`pf:${p.slug}`, p.displayName);
  }

  if (!dashPublicFigureSelect || !dashPublicFigureRow) return;

  // Clear existing options except "None"
  while (dashPublicFigureSelect.options.length > 1) {
    dashPublicFigureSelect.remove(1);
  }

  for (const p of personas) {
    const opt = document.createElement("option");
    opt.value = `pf:${p.slug}`;
    opt.textContent = p.displayName;
    dashPublicFigureSelect.appendChild(opt);
  }

  dashPublicFigureRow.style.display = personas.length > 0 ? "" : "none";
}

export function handleRemoteSignOut(): void {
  localAuthState = false;
  clearDashLlmState();
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
  const isPdfConverted = !!document.querySelector('meta[name="oddity-source-pdf"]');
  if (!siteEnabled && !isPdfConverted) {
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
  // A different user may have signed in elsewhere: reload their LLM state.
  void loadDashLlmStatus();
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
  gdocsTitleObs?.disconnect();
  gdocsTitleObs = null;
  hostEl?.remove();
  hostEl = null;
  shadowRoot = null;
  containerEl = null;
  topBarEl = null;
  listEl = null;
  pdfSummaryListEl = null;
  pdfSummaryTabBtn = null;
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
  dashPublicFigureSelect = null;
  dashPublicFigureRow = null;
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
  activeTab = "notes";
  dimmed = false;
  blocked = false;
  manualRunCb = null;
  notEnabledPanelEl = null;
  blockedPanelEl = null;
  pdfDetected = false;
  pdfPanelEl = null;
  pdfRunCb = null;
  pdfCachedLabel = false;
  pdfSummaryTabVisible = false;
  pdfSummaryCards = [];
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
    link.style.color = "#199A4D";
    link.style.textDecoration = "underline";
    link.textContent = "Get Standard";
    hint.appendChild(link);
  } else {
    // Standard users: show conversion button
    hint.textContent = "Convert to HTML to enable Oddity 1";
    const runBtn = document.createElement("button");
    runBtn.className = "args-run-btn";
    runBtn.textContent = pdfCachedLabel ? "See annotations" : "Run Oddity1";
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
  } else if (dimmed) {
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
        const isPdfConverted = !!document.querySelector(
          'meta[name="oddity-source-pdf"]',
        );
        if (!siteEnabled && !isPdfConverted) {
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
  containerEl?.classList.add("top-proximity");
}

function hideTopBar(): void {
  closeBtnHideTimer = setTimeout(() => {
    topBarEl?.classList.remove("hovered");
    containerEl?.classList.remove("top-proximity");
    closeBtnHideTimer = null;
  }, 80);
}

function fitDashboardHeight(): void {
  if (!dashFaceEl || !containerEl) return;
  if (!containerEl.classList.contains("dashboard")) return;
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

function dashLlmMakeRow(label: string, control: HTMLElement): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "args-dash-row";
  const span = document.createElement("span");
  span.className = "args-dash-label";
  span.textContent = label;
  row.appendChild(span);
  row.appendChild(control);
  return row;
}

function dashLlmMakeInput(
  type: string,
  placeholder: string,
): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "args-dash-input";
  input.type = type;
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  return input;
}

function buildDashLlmSection(): HTMLDivElement {
  const llmSection = document.createElement("div");
  llmSection.className = "args-dash-section";
  const llmTitle = document.createElement("div");
  llmTitle.className = "args-dash-section-title";
  llmTitle.textContent = "AI Provider";
  llmSection.appendChild(llmTitle);

  dashLlmSelect = document.createElement("select");
  dashLlmSelect.className = "args-dash-select";
  for (const [value, text] of [
    ["", "Oddity (default)"],
    ["oddity-free", "Oddity Free"],
    ["openrouter", "OpenRouter"],
    ["openai", "OpenAI"],
    ["anthropic", "Anthropic"],
    ["gemini", "Gemini"],
    ["muse", "Meta Muse"],
  ] as [string, string][]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    dashLlmSelect.appendChild(opt);
  }
  dashLlmSelect.addEventListener("change", () => {
    void onDashLlmProviderChange();
  });
  llmSection.appendChild(dashLlmMakeRow("Provider", dashLlmSelect));

  dashLlmNote = document.createElement("div");
  dashLlmNote.className = "args-dash-llm-note";
  dashLlmNote.style.display = "none";
  llmSection.appendChild(dashLlmNote);

  dashLlmForm = document.createElement("div");
  dashLlmForm.style.display = "none";

  dashLlmKeyInput = dashLlmMakeInput("password", "Paste API key");
  dashLlmForm.appendChild(dashLlmMakeRow("API key", dashLlmKeyInput));

  dashLlmModelInput = dashLlmMakeInput("text", "Default model");
  dashLlmModelInput.addEventListener("input", () => updateDashLlmEffortState());
  dashLlmForm.appendChild(dashLlmMakeRow("Model", dashLlmModelInput));

  dashLlmEffortSelect = document.createElement("select");
  dashLlmEffortSelect.className = "args-dash-select";
  for (const [value, text] of [
    ["default", "Default"],
    ["none", "None"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
  ] as [string, string][]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    dashLlmEffortSelect.appendChild(opt);
  }
  dashLlmForm.appendChild(dashLlmMakeRow("Effort", dashLlmEffortSelect));

  dashLlmBaseUrlInput = dashLlmMakeInput("text", "Default endpoint");
  dashLlmForm.appendChild(dashLlmMakeRow("Base URL", dashLlmBaseUrlInput));

  const actions = document.createElement("div");
  actions.className = "args-dash-llm-actions";
  dashLlmSaveBtn = document.createElement("button");
  dashLlmSaveBtn.className = "args-dash-llm-btn args-dash-llm-btn-primary";
  dashLlmSaveBtn.textContent = "Save";
  dashLlmSaveBtn.addEventListener("click", () => {
    void onDashLlmSave();
  });
  dashLlmDeleteBtn = document.createElement("button");
  dashLlmDeleteBtn.className = "args-dash-llm-btn args-dash-llm-btn-ghost";
  dashLlmDeleteBtn.textContent = "Remove";
  dashLlmDeleteBtn.addEventListener("click", () => {
    void onDashLlmDelete();
  });
  actions.appendChild(dashLlmSaveBtn);
  actions.appendChild(dashLlmDeleteBtn);
  dashLlmForm.appendChild(actions);

  dashLlmStatus = document.createElement("div");
  dashLlmStatus.className = "args-dash-llm-status";
  dashLlmForm.appendChild(dashLlmStatus);

  llmSection.appendChild(dashLlmForm);
  return llmSection;
}

function dashLlmStatusFor(provider: LlmProvider): LlmKeyStatus | undefined {
  return dashLlmState?.keys?.find((key) => key.provider === provider);
}

/** Background resolves `{ error }` instead of rejecting — surface it as a throw. */
function throwIfDashLlmError(
  result: { error?: string } | null | undefined,
  fallback: string,
): asserts result {
  if (!result || typeof result.error === "string") {
    throw new Error(
      result && typeof result.error === "string" ? result.error : fallback,
    );
  }
}

function setDashLlmStatus(message: string, kind: "" | "ok" | "err"): void {
  if (!dashLlmStatus) return;
  dashLlmStatus.textContent = message;
  dashLlmStatus.className =
    kind === "" ? "args-dash-llm-status" : `args-dash-llm-status ${kind}`;
}

async function loadDashLlmStatus(): Promise<void> {
  let storedPrefs: Record<string, unknown> = {};
  try {
    const stored = await chrome.storage.local.get("preferences");
    storedPrefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
    const saved = storedPrefs["llm_provider"];
    dashLlmStoredProvider =
      typeof saved === "string" ? (saved as LlmProvider) : null;
  } catch {
    // Keep the previous stored provider on read failure.
  }
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "getLlmStatus",
      payload: {},
    })) as (LlmStatusResponse & { error?: string }) | null | undefined;
    throwIfDashLlmError(result, "Couldn't load AI provider status.");
    if (!result || !Array.isArray(result.keys)) {
      throw new Error("Bad LLM status shape.");
    }
    dashLlmState = result;
    // Mirror the server's active provider into the stored fallback so a
    // later offline render (e.g. after deleting the active key) doesn't
    // resurrect a stale selection.
    if (dashLlmStoredProvider !== result.active_provider) {
      dashLlmStoredProvider = result.active_provider;
      try {
        // Re-read: storedPrefs predates the network round-trip and may have
        // gone stale while getLlmStatus was pending.
        const fresh = await chrome.storage.local.get("preferences");
        const freshPrefs = (fresh["preferences"] ?? {}) as Record<
          string,
          unknown
        >;
        await chrome.storage.local.set({
          preferences: { ...freshPrefs, llm_provider: result.active_provider },
        });
      } catch {
        // Keep the in-memory fallback; storage stays stale.
      }
    }
  } catch {
    dashLlmState = null;
  }
  renderDashLlmSection();
}

// Drops user-specific LLM state (keys, hints, selection) on sign-out so an
// open dashboard never shows the previous account's provider settings.
function clearDashLlmState(): void {
  dashLlmState = null;
  dashLlmStoredProvider = null;
  renderDashLlmSection();
}

// The effort control is only meaningful when the transport honors it, which
// for OpenAI depends on the model being edited — not just the provider.
function updateDashLlmEffortState(): void {
  if (!dashLlmEffortSelect) return;
  const selected = (dashLlmSelect?.value || null) as LlmProvider | null;
  const meta = selected ? LLM_PROVIDER_META[selected] : null;
  const model =
    dashLlmModelInput?.value.trim() || meta?.modelPlaceholder || "";
  const supported = selected !== null && modelSupportsEffort(selected, model);
  dashLlmEffortSelect.disabled = !supported;
  dashLlmEffortSelect.title = supported
    ? ""
    : selected === "openai"
      ? "Reasoning effort applies to OpenAI o-series and gpt-5 models only."
      : "Reasoning effort is not supported for this provider.";
}

function renderDashLlmSection(): void {
  if (!dashLlmSelect || !dashLlmNote || !dashLlmForm) return;
  const active =
    dashLlmState?.active_provider ?? dashLlmStoredProvider ?? null;
  dashLlmSelect.value = active ?? "";

  const selected = (dashLlmSelect.value || null) as LlmProvider | null;
  const status = selected ? dashLlmStatusFor(selected) : undefined;

  if (selected === null) {
    dashLlmNote.className = "args-dash-llm-note";
    dashLlmNote.textContent =
      "Oddity-managed model included with your plan. No setup needed.";
    dashLlmNote.style.display = "";
    dashLlmForm.style.display = "none";
    fitDashboardHeight();
    return;
  }

  const meta = LLM_PROVIDER_META[selected];
  if (selected === "oddity-free") {
    dashLlmNote.className = "args-dash-llm-note warn";
    dashLlmNote.textContent = meta.note;
    dashLlmNote.style.display = "";
    dashLlmForm.style.display = "none";
    fitDashboardHeight();
    return;
  }

  dashLlmNote.className = "args-dash-llm-note";
  dashLlmNote.innerHTML = "";
  dashLlmNote.append(document.createTextNode(`${meta.note} `));
  if (meta.keyUrl) {
    const link = document.createElement("a");
    link.href = meta.keyUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Get a key";
    dashLlmNote.append(link);
    dashLlmNote.append(document.createTextNode("."));
  }
  dashLlmNote.style.display = "";

  dashLlmForm.style.display = "flex";
  dashLlmForm.style.flexDirection = "column";
  dashLlmForm.style.gap = "8px";
  dashLlmForm.style.marginTop = "8px";
  if (dashLlmKeyInput) {
    dashLlmKeyInput.value = "";
    dashLlmKeyInput.placeholder = status?.configured
      ? `Saved (${status.key_hint ?? "****"})`
      : "Paste API key";
  }
  if (dashLlmModelInput) {
    dashLlmModelInput.value = status?.model ?? "";
    dashLlmModelInput.placeholder = meta.modelPlaceholder || "Default model";
  }
  if (dashLlmEffortSelect) {
    dashLlmEffortSelect.value = status?.reasoning_effort ?? "default";
    updateDashLlmEffortState();
  }
  if (dashLlmBaseUrlInput) {
    dashLlmBaseUrlInput.value = status?.base_url ?? "";
  }
  if (dashLlmDeleteBtn) {
    dashLlmDeleteBtn.disabled = !status?.configured;
  }
  if (status && !status.configured) {
    setDashLlmStatus(`Add your ${meta.label} API key to use this provider.`, "");
  } else {
    setDashLlmStatus("", "");
  }
  // The form shows/hides here, after the dashboard height was measured.
  fitDashboardHeight();
}

async function onDashLlmProviderChange(): Promise<void> {
  const provider = ((dashLlmSelect?.value || null) as LlmProvider | null) ?? null;
  setDashLlmStatus("Saving…", "");
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "setLlmProvider",
      payload: { provider },
    })) as { success: boolean; error?: string } | null | undefined;
    throwIfDashLlmError(result, "Couldn't save provider.");
    const stored = await chrome.storage.local.get("preferences");
    const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
    await chrome.storage.local.set({
      preferences: { ...prefs, llm_provider: provider },
    });
    dashLlmStoredProvider = provider;
    if (dashLlmState) {
      dashLlmState.active_provider = provider;
    } else {
      dashLlmState = { active_provider: provider, keys: [] };
    }
    renderDashLlmSection();
  } catch {
    renderDashLlmSection();
    setDashLlmStatus("Couldn't save provider.", "err");
  }
}

async function onDashLlmSave(): Promise<void> {
  const provider = (dashLlmSelect?.value || null) as LlmProvider | null;
  if (!provider || provider === "oddity-free" || !dashLlmSaveBtn) return;
  const body: SaveLlmKeyBody = {
    model: dashLlmModelInput?.value.trim() ?? "",
    base_url: dashLlmBaseUrlInput?.value.trim() ?? "",
    reasoning_effort: (dashLlmEffortSelect?.value ?? "default") as SaveLlmKeyBody["reasoning_effort"],
  };
  const apiKey = dashLlmKeyInput?.value.trim() ?? "";
  if (apiKey) body.api_key = apiKey;

  dashLlmSaveBtn.disabled = true;
  setDashLlmStatus("Saving…", "");
  try {
    const updated = (await chrome.runtime.sendMessage({
      action: "saveLlmKey",
      payload: { provider, body },
    })) as (LlmKeyStatus & { error?: string }) | null | undefined;
    throwIfDashLlmError(updated, "Couldn't save key.");
    if (dashLlmState && updated) {
      const index = dashLlmState.keys.findIndex(
        (key) => key.provider === provider,
      );
      if (index >= 0) dashLlmState.keys[index] = updated;
      else dashLlmState.keys.push(updated);
    } else if (updated) {
      // Status load failed or raced the save: seed local state from the
      // save response so the saved settings stay visible.
      dashLlmState = { active_provider: provider, keys: [updated] };
    }
    renderDashLlmSection();
    setDashLlmStatus("Saved.", "ok");
  } catch (err) {
    setDashLlmStatus(
      err instanceof Error ? err.message : "Couldn't save key.",
      "err",
    );
  } finally {
    if (dashLlmSaveBtn) dashLlmSaveBtn.disabled = false;
  }
}

async function onDashLlmDelete(): Promise<void> {
  const provider = (dashLlmSelect?.value || null) as LlmProvider | null;
  if (!provider || provider === "oddity-free" || !dashLlmDeleteBtn) return;
  if (
    !window.confirm(
      `Remove your saved ${LLM_PROVIDER_META[provider].label} key?`,
    )
  ) {
    return;
  }
  dashLlmDeleteBtn.disabled = true;
  setDashLlmStatus("Removing…", "");
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "deleteLlmKey",
      payload: { provider },
    })) as { deleted: boolean; error?: string } | null | undefined;
    throwIfDashLlmError(result, "Couldn't remove key.");
    await loadDashLlmStatus();
    setDashLlmStatus("Removed.", "ok");
  } catch (err) {
    setDashLlmStatus(
      err instanceof Error ? err.message : "Couldn't remove key.",
      "err",
    );
    // No re-render here: renderDashLlmSection would wipe the message above.
    // (The success path already rendered via loadDashLlmStatus.)
    if (dashLlmDeleteBtn) dashLlmDeleteBtn.disabled = false;
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

  // Public Figure dropdown row (hidden until personas loaded)
  dashPublicFigureRow = document.createElement("div");
  dashPublicFigureRow.className = "args-dash-row";
  dashPublicFigureRow.style.display = "none";
  const pfLabel = document.createElement("span");
  pfLabel.className = "args-dash-label";
  pfLabel.textContent = "Public Figure";
  dashPublicFigureSelect = document.createElement("select");
  dashPublicFigureSelect.className = "args-dash-select";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "None";
  dashPublicFigureSelect.appendChild(noneOpt);
  dashPublicFigureSelect.addEventListener("change", () => {
    const value = dashPublicFigureSelect!.value;
    if (value && dashUserTier !== "standard") {
      // Gate: requires Standard plan
      showNoticeToast("Public figure personas require a Standard plan");
      dashPublicFigureSelect!.value = "";
      return;
    }
    chrome.storage.local.get("preferences").then((stored) => {
      const prefs = (stored["preferences"] ?? {}) as Record<string, unknown>;
      if (!value) {
        // Revert to terry
        chrome.storage.local.set({ preferences: { ...prefs, depth_personality: "terry" } });
      } else {
        // Deactivate core buttons
        dashDensityBtns.forEach((b) => b.classList.remove("args-dash-density-active"));
        chrome.storage.local.set({ preferences: { ...prefs, depth_personality: value } });
      }
    });
  });
  dashPublicFigureRow.appendChild(pfLabel);
  dashPublicFigureRow.appendChild(dashPublicFigureSelect);
  section.appendChild(dashPublicFigureRow);

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

  // ── AI Provider ──
  face.appendChild(buildDashLlmSection());

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
    clearDashLlmState();
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
  const roleOptions: Array<[string, string]> = [
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
        await loadDashboardData();
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
        const isPdfConverted = !!document.querySelector(
          'meta[name="oddity-source-pdf"]',
        );
        if (!siteEnabled && !isPdfConverted) {
          showNotEnabledOverlay();
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
        await loadDashboardData();
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
        const isPdfConverted = !!document.querySelector(
          'meta[name="oddity-source-pdf"]',
        );
        if (!siteEnabled && !isPdfConverted) {
          showNotEnabledOverlay();
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
            dashSignInStatusEl.style.color = "#199A4D";
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
  if (personality.startsWith("pf:")) {
    const pfName = pfDisplayNames.get(personality) ?? "Public Figure";
    if (dashPersonaSelect) dashPersonaSelect.textContent = pfName;
    if (dashPersonaAvatarImgEl) {
      dashPersonaAvatarImgEl.src = chrome.runtime.getURL("Terry.png");
      dashPersonaAvatarImgEl.alt = "Terry";
    }
    if (bubbleLogoImgEl) {
      bubbleLogoImgEl.src = chrome.runtime.getURL("Terry.png");
      bubbleLogoImgEl.alt = "Terry";
    }
    if (dashPersonaCircleEl) dashPersonaCircleEl.style.background = "#fff";
    dashDensityBtns.forEach((btn) => btn.classList.remove("args-dash-density-active"));
    if (dashPublicFigureSelect) dashPublicFigureSelect.value = personality;
  } else {
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
  }
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
      void loadDashLlmStatus();
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
  sketchBtn.textContent = getSketchActionLabel();

  // Sketch output
  const sketchOutput = document.createElement("div");
  sketchOutput.className = "args-onboarding-sketch-output";

  const sketchLines = isChatbotMode
    ? [
        "Help me evaluate the article's main claim using the reading below.",
        "Use my notes and replies to identify the strongest evidence and the biggest limitation.",
        "Ground every point in the text and say when the evidence is uncertain.",
      ]
    : [
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
  title4.textContent = isChatbotMode
    ? getChatbotOnboardingTitle(chatbotDisplayName)
    : "Sketch Your Argument";
  const body4 = document.createElement("div");
  body4.className = "args-onboarding-slide-body";
  body4.textContent = isChatbotMode
    ? getChatbotOnboardingBody(chatbotDisplayName)
    : "Your reactions and replies compile into a coherent argument.";

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
    nextBtn.textContent =
      index === TOTAL_SLIDES - 1 ? "Start Thinking" : "Next";
    // Start animation for new slide (slight delay to let slide transition finish)
    delay(() => animStarters[index]!(), 350);
  }

  let dismissed = false;
  function dismiss(): void {
    if (dismissed) return;
    dismissed = true;
    clearAnimTimers();
    const finish = () => {
      overlay.remove();
      onboardingOverlayEl = null;
      onComplete();
    };
    overlay.style.opacity = "0";
    let done = false;
    overlay.addEventListener(
      "transitionend",
      () => {
        if (!done) {
          done = true;
          finish();
        }
      },
      { once: true },
    );
    // Fallback: if transitionend never fires (e.g., overlay not yet visible), force finish
    setTimeout(() => {
      if (!done) {
        done = true;
        finish();
      }
    }, 400);
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
  gdocsExpandedCardId = null;
  listEl.style.overflow = "";

  // GDocs memo edit mode: inject "Select All" row at top
  if (isGDocs() && gdocsMemoEditMode && allItems.length > 0) {
    const selectAllRow = document.createElement("div");
    selectAllRow.className = "args-gdocs-select-all-row";
    selectAllRow.style.cursor = "pointer";
    const selectAllChk = document.createElement("input");
    selectAllChk.type = "checkbox";
    selectAllChk.className = "args-gdocs-checkbox";
    selectAllChk.style.pointerEvents = "none"; // row handles the click
    const allSelected = allItems.every(i => gdocsMemoSelected.has(i.sortKey));
    selectAllChk.checked = allSelected;
    selectAllChk.indeterminate = !allSelected && allItems.some(i => gdocsMemoSelected.has(i.sortKey));
    const selectAllLabel = document.createElement("span");
    selectAllLabel.className = "args-gdocs-select-all-label";
    selectAllLabel.textContent = "Select All";
    selectAllRow.addEventListener("click", (e) => {
      e.stopPropagation();
      const shouldSelect = !selectAllChk.checked || selectAllChk.indeterminate;
      if (shouldSelect) {
        allItems.forEach(i => gdocsMemoSelected.add(i.sortKey));
        selectAllChk.checked = true;
        selectAllChk.indeterminate = false;
      } else {
        allItems.forEach(i => gdocsMemoSelected.delete(i.sortKey));
        selectAllChk.checked = false;
        selectAllChk.indeterminate = false;
      }
      // Update individual card checkboxes in-place
      listEl!.querySelectorAll<HTMLInputElement>(".gdocs-arg-card--selectable .args-gdocs-checkbox").forEach(chk => {
        const cardId = (chk.closest(".gdocs-arg-card") as HTMLElement)?.dataset.cardId;
        if (cardId) chk.checked = shouldSelect;
      });
    });
    selectAllRow.appendChild(selectAllChk);
    selectAllRow.appendChild(selectAllLabel);
    listEl.appendChild(selectAllRow);
    const divider = document.createElement("div");
    divider.className = "gdocs-arg-divider";
    listEl.appendChild(divider);
  }

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

    if (isGDocs()) {
      // ── GDocs card: title + timestamp + body (flow layout) ──
      const card = document.createElement("div");
      card.className = "gdocs-arg-card";
      card.dataset.cardId = cardId;

      const titleEl = document.createElement("div");
      titleEl.className = "gdocs-arg-title";
      if (item.type === "reply") {
        const excerpt = item.replyHeader ?? "";
        titleEl.textContent = excerpt
          ? `Reply to \u201c${excerpt}\u201d`
          : "Reply";
      } else {
        const src = item.quote || item.text;
        const MAX = 38;
        titleEl.textContent =
          src.length > MAX
            ? `Memo on \u201c${src.slice(0, MAX)}\u2026\u201d`
            : `Memo on \u201c${src}\u201d`;
      }

      const tsEl = document.createElement("div");
      tsEl.className = "gdocs-arg-timestamp";
      tsEl.textContent = formatGDocsTimestamp(item.sortKey);

      const bodyEl = document.createElement("div");
      bodyEl.className = "gdocs-arg-body";
      bodyEl.textContent = item.text;

      // ── Expanded footer (hidden until card is expanded) ──
      const expandedFooter = document.createElement("div");
      expandedFooter.className = "gdocs-arg-expanded-footer";

      // "Go to highlight" link
      const gotoLink = document.createElement("button");
      gotoLink.className = "gdocs-arg-goto";
      gotoLink.textContent = "Go to highlight";
      gotoLink.addEventListener("click", (e) => {
        e.stopPropagation();
        if (item.annotationId) {
          document.dispatchEvent(
            new CustomEvent("oddity:scroll-to-annotation", {
              detail: { annotationId: item.annotationId, itemType: item.type },
            }),
          );
        }
      });

      // Action icons row
      const actionsEl = document.createElement("div");
      actionsEl.className = "gdocs-arg-actions";

      // Copy button (copies annotation header + body)
      const copyBtn = document.createElement("button");
      copyBtn.className = "gdocs-arg-icon-btn";
      copyBtn.title = "Copy";
      copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const header = titleEl.textContent ?? "";
        const body = item.text;
        navigator.clipboard.writeText(`${header}\n\n${body}`).catch(() => {});
        copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
        }, 1500);
      });

      // Edit button
      const editBtn = document.createElement("button");
      editBtn.className = "gdocs-arg-icon-btn";
      editBtn.title = "Edit";
      editBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (bodyEl.dataset.editMode === "true") return;
        bodyEl.dataset.editMode = "true";
        const originalText = item.text;
        const ta = document.createElement("textarea");
        ta.className = "gdocs-arg-edit-textarea";
        ta.value = originalText;
        ta.addEventListener("keydown", (ev) => ev.stopPropagation());
        ta.addEventListener("click", (ev) => ev.stopPropagation());
        const editActions = document.createElement("div");
        editActions.className = "gdocs-arg-edit-actions";
        const saveBtn = document.createElement("button");
        saveBtn.className = "gdocs-arg-edit-save";
        saveBtn.textContent = "Save";
        saveBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const newText = ta.value.trim();
          if (!newText) return;
          item.text = newText;
          bodyEl.textContent = newText;
          bodyEl.style.display = "";
          delete bodyEl.dataset.editMode;
          ta.remove();
          editActions.remove();
          if (item.feedbackId) {
            chrome.runtime.sendMessage({
              action: "updateFeedback",
              payload: { feedbackId: item.feedbackId, text: newText, url: getPageUrl() },
            }).catch(() => {});
          } else if (item.annotationId) {
            chrome.runtime.sendMessage({
              action: "updateAnnotation",
              payload: { annotationId: item.annotationId, text: newText, url: getPageUrl() },
            }).catch(() => {});
          }
        });
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "gdocs-arg-edit-cancel";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          bodyEl.style.display = "";
          delete bodyEl.dataset.editMode;
          ta.remove();
          editActions.remove();
        });
        editActions.appendChild(saveBtn);
        editActions.appendChild(cancelBtn);
        bodyEl.style.display = "none";
        bodyEl.after(ta, editActions);
        ta.focus();
      });

      // Delete button
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "gdocs-arg-icon-btn gdocs-arg-icon-btn--delete";
      deleteBtn.title = "Delete";
      deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        gdocsExpandedCardId = null;
        if (item.feedbackId) {
          deletedFeedbackIds.add(item.feedbackId);
          chrome.runtime.sendMessage({
            action: "deleteFeedback",
            payload: { feedbackId: item.feedbackId, contentHash: item.contentHash, url: getPageUrl() },
          }).catch(() => {});
          canonicalItems = canonicalItems.filter((i) => i.feedbackId !== item.feedbackId);
          liveItems = liveItems.filter((i) => i.feedbackId !== item.feedbackId);
          document.dispatchEvent(new CustomEvent("oddity:feedback-deleted", {
            detail: { feedbackId: item.feedbackId, annotationId: item.annotationId },
          }));
        } else if (item.annotationId) {
          deletedAnnotationIds.add(item.annotationId);
          chrome.runtime.sendMessage({
            action: "deleteAnnotation",
            payload: { annotationId: item.annotationId, url: getPageUrl(), contentHash: item.contentHash ?? "" },
          }).catch(() => {});
          canonicalItems = canonicalItems.filter((i) => i.annotationId !== item.annotationId);
          liveItems = liveItems.filter((i) => i.annotationId !== item.annotationId);
          document.dispatchEvent(new CustomEvent("oddity:annotation-deleted", {
            detail: { annotationId: item.annotationId },
          }));
        } else {
          canonicalItems = canonicalItems.filter((i) => i.sortKey !== item.sortKey);
          liveItems = liveItems.filter((i) => i.sortKey !== item.sortKey);
        }
        renderList();
      });

      actionsEl.appendChild(copyBtn);
      actionsEl.appendChild(editBtn);
      actionsEl.appendChild(deleteBtn);
      expandedFooter.appendChild(gotoLink);
      expandedFooter.appendChild(actionsEl);

      // Memo edit mode: add checkbox, disable expand
      if (gdocsMemoEditMode) {
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.className = "args-gdocs-checkbox";
        chk.checked = gdocsMemoSelected.has(cardId);
        chk.addEventListener("change", (e) => {
          e.stopPropagation();
          if (chk.checked) gdocsMemoSelected.add(cardId);
          else gdocsMemoSelected.delete(cardId);
        });
        card.classList.add("gdocs-arg-card--selectable");
        card.appendChild(chk);
      }

      const contentCol = document.createElement("div");
      contentCol.className = "gdocs-arg-card-content";
      contentCol.appendChild(titleEl);
      contentCol.appendChild(tsEl);
      contentCol.appendChild(bodyEl);
      contentCol.appendChild(expandedFooter);
      card.appendChild(contentCol);

      // Toggle expand on click (disabled in edit mode)
      card.addEventListener("click", () => {
        if (gdocsMemoEditMode) return;
        const isExpanded = gdocsExpandedCardId === cardId;
        // Collapse previously expanded card
        if (gdocsExpandedCardId) {
          const prev = listEl?.querySelector<HTMLDivElement>(`.gdocs-arg-card[data-card-id="${CSS.escape(gdocsExpandedCardId)}"]`);
          if (prev) {
            prev.classList.remove("gdocs-arg-card--expanded");
            const prevDivider = prev.nextElementSibling;
            if (prevDivider?.classList.contains("gdocs-arg-divider")) {
              (prevDivider as HTMLElement).style.display = "";
            }
          }
          gdocsExpandedCardId = null;
          if (listEl) listEl.style.overflow = "";
        }
        if (!isExpanded) {
          card.classList.add("gdocs-arg-card--expanded");
          const nextDivider = card.nextElementSibling;
          if (nextDivider?.classList.contains("gdocs-arg-divider")) {
            (nextDivider as HTMLElement).style.display = "none";
          }
          gdocsExpandedCardId = cardId;
          if (listEl) listEl.style.overflow = "visible";
        }
      });

      const divider = document.createElement("div");
      divider.className = "gdocs-arg-divider";

      listEl.appendChild(card);
      listEl.appendChild(divider);
      continue;
    }

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
    replyInput.placeholder = "Thoughts?";
    replyInput.className = "note-reply-input";

    const submitArgReply = () => {
      const text = replyInput.value.trim();
      if (!text) return;

      // Add reply item immediately
      const replyItem = document.createElement("div");
      replyItem.className = "note-reply-item";

      const replyText = document.createElement("div");
      replyText.className = "note-reply-text";
      replyText.textContent = text;

      const replyMeta = document.createElement("div");
      replyMeta.className = "note-reply-meta";

      const replyEditBtn = document.createElement("button");
      replyEditBtn.className = "note-reply-action-btn";
      replyEditBtn.title = "Edit";
      replyEditBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18.1641 1.33105C19.7393 -0.243794 22.2929 -0.243751 23.8682 1.33105C25.4435 2.90636 25.4435 5.46083 23.8682 7.03613L8.41699 22.4883C7.76597 23.1393 6.94983 23.6009 6.05664 23.8242L1.26465 25.0225C0.608468 25.1865 0.0136891 24.5917 0.177734 23.9355L1.37598 19.1436C1.59927 18.2504 2.0609 17.4342 2.71191 16.7832L18.1641 1.33105ZM16.4727 5.55664L3.97949 18.0508C3.55812 18.4722 3.25879 19 3.11426 19.5781L2.33887 22.6787L5.62207 22.0859C6.20018 21.9414 6.72804 21.6421 7.14941 21.2207L19.6426 8.72656L16.4727 5.55664ZM22.6016 2.59863C21.726 1.72311 20.3062 1.72311 19.4307 2.59863L17.8457 4.18359L20.9092 7.24805L22.6016 5.76953C23.4771 4.89404 23.477 3.47416 22.6016 2.59863Z" fill="currentColor"/></svg>`;
      replyEditBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const current = replyText.dataset.editMode;
        if (current === "true") return;
        replyText.dataset.editMode = "true";
        const oldText = replyText.textContent ?? "";
        const ta = document.createElement("textarea");
        ta.className = "note-edit-textarea";
        ta.value = oldText;
        const actions = document.createElement("div");
        actions.className = "note-edit-actions";
        const saveBtn = document.createElement("button");
        saveBtn.className = "note-save-btn";
        saveBtn.textContent = "Save";
        saveBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const newText = ta.value.trim();
          if (!newText) return;
          replyText.textContent = newText;
          replyText.style.display = "";
          delete replyText.dataset.editMode;
          ta.remove();
          actions.remove();
          if (replyItem.dataset.feedbackId) {
            chrome.runtime.sendMessage({
              action: "updateFeedback",
              payload: {
                feedbackId: replyItem.dataset.feedbackId,
                replyText: newText,
                contentHash: item.contentHash,
                url: getPageUrl(),
              },
            }).catch(() => {});
          }
        });
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "note-cancel-btn";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          replyText.style.display = "";
          delete replyText.dataset.editMode;
          ta.remove();
          actions.remove();
        });
        actions.appendChild(saveBtn);
        actions.appendChild(cancelBtn);
        replyText.style.display = "none";
        replyText.after(ta, actions);
      });

      const replyDeleteBtn = document.createElement("button");
      replyDeleteBtn.className = "note-reply-action-btn";
      replyDeleteBtn.title = "Delete";
      replyDeleteBtn.innerHTML = `<svg width="11" height="14" viewBox="0 0 22 27" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18.9219 7.43945C19.5106 7.28746 20.0695 7.65114 20.1689 8.25781C20.1871 8.36904 20.1904 8.48758 20.1904 8.61621C20.1916 12.9442 20.1921 17.2726 20.1914 21.6006C20.191 23.8874 18.6924 25.7032 16.4473 26.127C16.1796 26.1775 15.898 26.1959 15.6172 26.1963C12.4044 26.2013 9.19156 26.2003 5.97852 26.1992C3.69159 26.1985 1.85256 24.6628 1.45312 22.418C1.41441 22.2002 1.39474 21.976 1.39453 21.7549C1.39094 17.3332 1.39019 12.9109 1.39355 8.48926C1.3939 8.11363 1.54191 7.815 1.7627 7.62891C1.98301 7.44332 2.28797 7.35899 2.62695 7.43457C3.04346 7.52748 3.36132 7.89535 3.39258 8.32715C3.39551 8.62207 3.39648 20.6787 3.39648 20.6787L3.39648 20.6855C3.41225 21.17 3.37743 21.7036 3.45996 22.1953C3.65247 23.341 4.68451 24.1899 5.83789 24.1924C9.13566 24.1995 12.4336 24.1998 15.7314 24.1924C17.1037 24.1893 18.1861 23.0585 18.1865 21.6758C18.188 17.2823 18.1867 12.8885 18.1875 8.49512C18.1876 7.94499 18.484 7.55251 18.9219 7.43945Z" fill="currentColor"/><path d="M7.26953 0.203125C9.62027 0.198508 11.9716 0.199014 14.3223 0.204102C14.6616 0.204899 14.922 0.314719 15.0977 0.492188C15.2735 0.670059 15.3822 0.934127 15.3848 1.27637C15.3898 1.9497 15.3867 2.62192 15.3867 3.29785V3.7998H15.9141C17.3757 3.79981 18.8361 3.79648 20.2969 3.80078C20.9586 3.80273 21.3942 4.24054 21.3867 4.82031C21.3799 5.3401 20.9666 5.77238 20.4453 5.80176C20.3502 5.8071 20.2583 5.80371 20.1475 5.80371H1.2666C0.639678 5.80015 0.20525 5.37415 0.200195 4.81543C0.195178 4.24231 0.62806 3.8045 1.26758 3.80176C2.72789 3.7955 4.1877 3.79982 5.64941 3.7998H6.1709L6.18359 3.61328C6.18866 3.53651 6.20002 3.43702 6.2002 3.34961C6.20145 2.65408 6.19707 1.96406 6.20215 1.27148C6.20465 0.931308 6.31364 0.668386 6.49023 0.491211C6.66684 0.314264 6.92879 0.203859 7.26953 0.203125ZM8.20312 3.7998H13.3838V2.21973H8.20312V3.7998Z" fill="currentColor"/></svg>`;
      replyDeleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const fid = replyItem.dataset.feedbackId;
        if (fid) {
          chrome.runtime.sendMessage({
            action: "deleteFeedback",
            payload: { feedbackId: fid, contentHash: item.contentHash, url: getPageUrl() },
          }).catch(() => {});
        }
        replyItem.remove();
      });

      replyMeta.appendChild(replyEditBtn);
      replyMeta.appendChild(replyDeleteBtn);
      replyItem.appendChild(replyText);
      replyItem.appendChild(replyMeta);

      const divider = document.createElement("div");
      divider.className = "note-reply-divider";
      replyItem.appendChild(divider);

      repliesContainer.appendChild(replyItem);
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
              replyItem.dataset.feedbackId = fb.id;
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

  if (isGDocs()) {
    // GDocs: flow layout, no absolute positioning needed
    listEl.style.visibility = "";
    listEl.style.height = "";
  } else {
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
}

const PDF_SUMMARY_COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.4883 5.5H7.94922C6.59655 5.5 5.5 6.59655 5.5 7.94922V17.4883C5.5 18.8409 6.59655 19.9375 7.94922 19.9375H17.4883C18.8409 19.9375 19.9375 18.8409 19.9375 17.4883V7.94922C19.9375 6.59655 18.8409 5.5 17.4883 5.5Z" stroke="currentColor" stroke-width="1.375" stroke-linejoin="round"/><path d="M16.4785 5.5L16.5 4.46875C16.4982 3.83113 16.2441 3.22014 15.7932 2.76928C15.3424 2.31841 14.7314 2.06431 14.0938 2.0625H4.8125C4.08382 2.06465 3.38559 2.35508 2.87034 2.87034C2.35508 3.38559 2.06465 4.08382 2.0625 4.8125V14.0938C2.06431 14.7314 2.31841 15.3424 2.76928 15.7932C3.22014 16.2441 3.83113 16.4982 4.46875 16.5H5.5" stroke="currentColor" stroke-width="1.375" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function copyPdfSummary(summary: string, btn: HTMLButtonElement): void {
  navigator.clipboard
    .writeText(summary)
    .then(() => {
      btn.classList.add("copied");
      showNoticeToast("Summary copied");
      setTimeout(() => btn.classList.remove("copied"), 1500);
    })
    .catch(() => {
      showNoticeToast("Couldn't copy summary");
    });
}

function renderPdfSummaryList(): void {
  if (!pdfSummaryListEl) return;

  // Save scroll position so re-render doesn't jump to top
  const savedScroll = pdfSummaryListEl.scrollTop;
  pdfSummaryListEl.replaceChildren();

  if (!pdfSummaryTabVisible) return;

  if (pdfSummaryCards.length === 0) {
    const empty = document.createElement("div");
    empty.className = "args-pdf-summary-empty";
    empty.textContent = "No converted PDF pages found yet.";
    pdfSummaryListEl.appendChild(empty);
    return;
  }

  for (const item of pdfSummaryCards) {
    if (item.summary) {
      // ── Full summarized card ──
      const card = document.createElement("div");
      card.className = "args-pdf-summary-card";
      card.dataset.pageNo = item.pageNo;
      card.addEventListener("click", () => {
        document.dispatchEvent(
          new CustomEvent("oddity:pdf-summary-scroll-to-page", {
            detail: { pageNo: item.pageNo },
          }),
        );
      });

      const text = document.createElement("div");
      text.className = "args-pdf-summary-text";
      text.textContent = item.summary;
      card.appendChild(text);

      const footer = document.createElement("div");
      footer.className = "args-pdf-summary-footer";

      const pageLabel = document.createElement("div");
      pageLabel.className = "args-pdf-summary-page";
      pageLabel.textContent = item.pageLabel;
      footer.appendChild(pageLabel);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "args-pdf-summary-copy";
      copyBtn.title = `Copy summary for page ${item.pageLabel}`;
      copyBtn.innerHTML = PDF_SUMMARY_COPY_ICON;
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        copyPdfSummary(item.summary!, copyBtn);
      });
      footer.appendChild(copyBtn);
      card.appendChild(footer);
      pdfSummaryListEl.appendChild(card);
    } else {
      // ── Compact unsummarized card ──
      const card = document.createElement("div");
      card.className = "args-pdf-summary-card args-pdf-summary-card--compact";
      card.dataset.pageNo = item.pageNo;

      const footer = document.createElement("div");
      footer.className = "args-pdf-summary-footer";

      const pageLabel = document.createElement("div");
      pageLabel.className = "args-pdf-summary-page";
      pageLabel.textContent = item.pageLabel;
      footer.appendChild(pageLabel);

      const actionBtn = document.createElement("button");
      actionBtn.type = "button";
      actionBtn.className = "args-pdf-summary-generate";
      actionBtn.textContent = item.loading ? "Summarizing..." : "Summarize";
      actionBtn.disabled = item.loading;
      actionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        document.dispatchEvent(
          new CustomEvent("oddity:pdf-summary-generate", {
            detail: { pageNo: item.pageNo },
          }),
        );
      });
      footer.appendChild(actionBtn);
      card.appendChild(footer);
      pdfSummaryListEl.appendChild(card);
    }
  }

  // Restore scroll so the list doesn't jump on re-render
  pdfSummaryListEl.scrollTop = savedScroll;
}

// ─── Tab Switching ───

function switchTab(tab: "notes" | "sketch" | "summaries"): void {
  activeTab = tab;
  if (notesTabBtn)
    notesTabBtn.className = tab === "notes" ? "args-tab active" : "args-tab";
  if (sketchTabBtn)
    sketchTabBtn.className = tab === "sketch" ? "args-tab active" : "args-tab";
  if (pdfSummaryTabBtn)
    pdfSummaryTabBtn.className =
      tab === "summaries" ? "args-tab active" : "args-tab";
  if (listEl) listEl.style.display = tab === "notes" ? "" : "none";
  if (footerEl) footerEl.style.display = tab === "notes" ? "" : "none";
  if (sketchContentEl)
    sketchContentEl.style.display = tab === "sketch" ? "" : "none";
  if (pdfSummaryListEl)
    pdfSummaryListEl.style.display = tab === "summaries" ? "" : "none";
  if (
    tab === "sketch" &&
    isChatbotMode &&
    sketchViewState === "idle" &&
    !sketchBuffer
  ) {
    renderPromptEmptyState();
  }
}

// ─── Sketch Handler ───

function handleSketch(): void {
  if (sketchLoading) return;

  // Gate: Sketch Pad requires Standard plan
  if (dashUserTier !== "standard") {
    sketchViewState = "error";
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
      link.style.color = "#199A4D";
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
      purposeInputEl.placeholder = getPurposeValidationPlaceholderText();
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
  sketchViewState = "loading";
  sketchBuffer = "";
  if (sketchBtnEl) {
    sketchBtnEl.disabled = true;
    sketchBtnEl.textContent = getSketchLoadingLabel();
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
      payload: {
        inputText,
        purpose,
        userReactions,
        mode: isChatbotMode ? "prompt" : "sketch",
      },
    })
    .catch(() => {
      sketchViewState = "error";
      sketchLoading = false;
      if (sketchBtnEl) {
        sketchBtnEl.disabled = false;
        sketchBtnEl.textContent = getSketchActionLabel();
      }
      if (sketchContentEl) {
        const errorDiv = document.createElement("div");
        errorDiv.className = "args-sketch-error";
        errorDiv.textContent = getSketchErrorText();
        sketchContentEl.replaceChildren(errorDiv);
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

export function triggerOptimizePrompt(chatbotInputBoxText: string): void {
  if (sketchLoading) return;

  if (dashUserTier !== "standard") {
    document.dispatchEvent(
      new CustomEvent("oddity:optimizePromptDone", {
        detail: { error: "Requires Standard plan." },
      }),
    );
    return;
  }

  const inputText = inputTextProviderCb?.() ?? "";
  if (!inputText) {
    document.dispatchEvent(
      new CustomEvent("oddity:optimizePromptDone", {
        detail: { error: "No page context found." },
      }),
    );
    return;
  }

  const allItems = [...canonicalItems, ...liveItems];
  const userReactions = allItems.map((i) => formatItemPlain(i)).join("\n\n");

  sketchLoading = true;
  sketchViewState = "loading";
  sketchBuffer = "";

  // Make sure argbox shows loading too if it's open
  if (sketchContentEl) {
    sketchContentEl.innerHTML =
      '<div class="args-sketch-loading"><span></span><span></span><span></span></div>';
  }
  if (sketchBtnEl) {
    sketchBtnEl.disabled = true;
    sketchBtnEl.textContent = getSketchLoadingLabel();
  }

  chrome.runtime
    .sendMessage({
      action: "requestSketch",
      payload: {
        inputText,
        purpose: chatbotInputBoxText,
        userReactions,
        mode: "prompt",
      },
    })
    .catch((err) => {
      sketchViewState = "error";
      sketchLoading = false;
      if (sketchBtnEl) {
        sketchBtnEl.disabled = false;
        sketchBtnEl.textContent = getSketchActionLabel();
      }
      if (sketchContentEl) {
        const errorDiv = document.createElement("div");
        errorDiv.className = "args-sketch-error";
        errorDiv.textContent = getSketchErrorText();
        sketchContentEl.replaceChildren(errorDiv);
      }
      document.dispatchEvent(
        new CustomEvent("oddity:optimizePromptDone", { detail: { error: err } }),
      );
    });
}


export function getOptimizePromptContext() {
  const inputText = inputTextProviderCb?.() ?? "";
  const allItems = [...canonicalItems, ...liveItems];
  const userReactions = allItems.map((i) => formatItemPlain(i)).join("\n\n");
  
  return {
    tier: dashUserTier,
    inputText,
    userReactions
  };
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
  } else if (activeTab === "summaries") {
    const summarizedCards = pdfSummaryCards.filter((item) => item.summary);
    if (summarizedCards.length === 0) {
      showNoticeToast("No summaries to copy yet");
      return;
    }
    plainText = summarizedCards
      .map((item) => `Page ${item.pageLabel}\n${item.summary}`)
      .join("\n\n");
    html = summarizedCards
      .map(
        (item) =>
          `<b>Page ${escapeHtml(item.pageLabel)}</b><br>${escapeHtml(item.summary ?? "")}`,
      )
      .join("<br><br>");
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
  if (expanded) {
    // Pin to containerEl so it stays centered over the panel
    if (modeToggleWrapperEl.parentElement !== containerEl) {
      containerEl.appendChild(modeToggleWrapperEl);
    }
    modeToggleWrapperEl.classList.add("is-expanded");
    modeToggleWrapperEl.classList.remove("is-collapsed");
    modeToggleEl.classList.add("with-close");
    modeToggleWrapperEl.style.position = "absolute";
    modeToggleWrapperEl.style.top = "-40px";
    modeToggleWrapperEl.style.left = "50%";
    modeToggleWrapperEl.style.transform = "";
    modeToggleWrapperEl.style.transformOrigin = "center center";
  } else if (outerWrapperEl) {
    // Move toggle back to outerWrapper (next to FAB)
    if (modeToggleWrapperEl.parentElement !== outerWrapperEl) {
      outerWrapperEl.insertBefore(modeToggleWrapperEl, containerEl);
    }
    modeToggleWrapperEl.classList.add("is-collapsed");
    modeToggleWrapperEl.classList.remove("is-expanded");
    modeToggleEl.classList.remove("with-close");
    modeToggleWrapperEl.style.position = "absolute";
    modeToggleWrapperEl.style.top = "";
    modeToggleWrapperEl.style.left = "";
    modeToggleWrapperEl.style.transform = "translateX(0) translateY(0)";
    modeToggleWrapperEl.style.transformOrigin = "";
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
    if (!extensionEnabled) return;
    const target = (e.target as HTMLElement).closest("[data-mode]") as HTMLElement | null;
    if (!target || !modeToggleEl) return;
    const mode = target.dataset.mode as string;
    if (mode === modeToggleEl.dataset.active) return;
    modeToggleOverviewBtn!.classList.toggle("mode-active", mode === "overview");
    modeToggleDepthBtn!.classList.toggle("mode-active", mode === "depth");
    modeToggleEl.dataset.active = mode;
    syncModeToggleSlider();
    document.dispatchEvent(new CustomEvent("oddity:modeChange", { detail: { mode } }));
  });

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
    --oddity-note-font: system-ui, -apple-system, "Segoe UI", sans-serif;
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
    left: 11px;
    z-index: 3;
    transform: scale(0.81);
    transform-origin: left center;
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
    pointer-events: none;
    position: absolute;
    z-index: 3;
    display: block;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .args-container.expanded:hover .args-mode-toggle-wrapper.is-expanded,
  .args-mode-toggle-wrapper.is-expanded:hover {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(-50%) translateY(0);
  }

  .args-mode-toggle-wrapper.is-expanded {
    transform: translateX(-50%) translateY(10px);
    transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .args-mode-toggle-wrapper.is-collapsed {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(0) translateY(0);
    transition: opacity 0.2s ease;
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
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3px;
    background: #E6E6E6;
    border-radius: 10px;
    position: relative;
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(0,0,0,0.10), 0 0 1px rgba(0,0,0,0.08);
  }

  .mode-toggle.with-close {
    /* no change needed — already flex */
  }

  .mode-slider {
    position: absolute;
    top: 3px;
    height: calc(100% - 6px);
    background: #FFFFFF;
    border-radius: 8px;
    transition: left 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), width 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
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
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: #858E97;
    background: transparent;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.2s ease;
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
    border-radius: 50%;
    cursor: pointer;
    color: #858E97;
    background: transparent;
    position: relative;
    z-index: 1;
    transition: color 0.2s ease, background 0.2s ease;
  }

  .mode-close-btn:hover {
    color: #696F77;
    background: rgba(0, 0, 0, 0.08);
  }

  .mode-toggle.with-close .mode-close-btn,
  .mode-close-btn.mode-close-only {
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
    background: #E7E9EB;
    box-shadow: 0 1px 4px rgba(0,0,0,0.10), 0 0 1px rgba(0,0,0,0.08);
  }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-slider {
    background: #FFFFFF;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 0 1px rgba(0,0,0,0.08);
  }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-btn { color: #9A9DA3; }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-active { color: #62656B; }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-btn:hover:not(.mode-active) { color: #62656B; }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-close-btn { color: #9A9DA3; }
  :host([data-theme="light"]) .mode-toggle.with-close .mode-close-btn:hover { color: #62656B; background: rgba(0,0,0,0.06); }

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
      width 0.2s cubic-bezier(0.4, 0, 0.2, 1), height 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-radius 0.2s cubic-bezier(0.4, 0, 0.2, 1), transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s;
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
      transform 0.2s, box-shadow 0.2s, width 0.2s cubic-bezier(0.4, 0, 0.2, 1), height 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-radius 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .args-container.oddity-enabled {
    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.2), 0 0 0 2.5px #4ade80;
  }


  /* Expanded (panel) state — blur moves to ::after so child cards blur independently */
  .args-container.expanded {
    width: var(--panel-width, 300px);
    height: calc(100vh - 90px + 32px);
    border-radius: 0;
    box-shadow: none;
    border: 1.5px solid #E5E5E5;
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

  .args-container.expanded.top-proximity .args-resize-handle {
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
    transition: opacity 0.2s ease;
    pointer-events: none;
    background: #fff;
    border-radius: inherit;
    cursor: grab;
  }

  .args-container.expanded .args-button-face {
    opacity: 0;
    transition: opacity 0.2s ease;
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
    transition: opacity 0.2s ease;
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
    padding: 22px 16px 8px;
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
    transition: background 0.2s, color 0.2s;
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
    transition: opacity 0.2s, transform 0.2s;
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
    border-radius: 999px;
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

  .args-purpose-helper {
    font-size: 10px;
    line-height: 1.45;
    color: rgba(255, 255, 255, 0.5);
    font-family: system-ui, -apple-system, sans-serif;
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
    border-radius: 10px;
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
    transition: grid-template-rows 0.2s ease, opacity 0.2s ease, margin-top 0.2s ease;
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

  .arg-card .note-reply-item {
    padding: 8px 0 0;
  }

  .arg-card .note-reply-text {
    font-size: var(--oddity-note-size);
    color: #999;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    word-break: break-word;
    line-height: 1.45;
    margin-bottom: 4px;
  }

  .arg-card .note-reply-meta {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-bottom: 8px;
  }

  .arg-card .note-reply-action-btn {
    all: unset;
    cursor: pointer;
    color: #888;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.6;
    transition: opacity 0.2s;
  }

  .arg-card .note-reply-action-btn:hover {
    opacity: 1;
  }

  .arg-card .note-reply-divider {
    height: 1px;
    background: rgba(255,255,255,0.1);
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
    border-radius: 999px;
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
    background: #1E2229;
    color: #fff;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: opacity 0.2s;
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
    border-radius: 999px;
    background: #748DBF;
    color: #fff;
    opacity: 1;
    transition: opacity 0.2s;
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
    transition: color 0.2s, background 0.2s;
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
    border-radius: 999px;
    font-family: var(--oddity-note-font);
    transition: opacity 0.2s;
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

  .args-pdf-summary-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .args-pdf-summary-card {
    position: relative;
    background: rgba(255, 255, 255, 0.95);
    border: 1px solid rgba(17, 24, 39, 0.08);
    border-radius: 14px;
    padding: 16px 16px 14px 28px;
    color: #233146;
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.08);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }

  .args-pdf-summary-card::before {
    content: "";
    position: absolute;
    top: 16px;
    left: 12px;
    width: 4px;
    height: calc(100% - 32px);
    border-radius: 999px;
    background: linear-gradient(180deg, #1d9bf0 0%, #4cb4ff 100%);
  }

  .args-pdf-summary-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 16px 32px rgba(15, 23, 42, 0.12);
  }

  .args-pdf-summary-card--active {
    outline: 2px solid #3b82f6;
    outline-offset: -2px;
  }


  .args-pdf-summary-card--compact {
    padding-top: 10px;
    padding-bottom: 10px;
  }

  .args-pdf-summary-text {
    font-family: "Fraunces", Georgia, serif;
    font-size: 14px;
    line-height: 1.6;
    min-height: 54px;
  }

  .args-pdf-summary-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
    gap: 12px;
  }

  .args-pdf-summary-page {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 22px;
    font-weight: 700;
    line-height: 1;
    color: #111827;
  }

  .args-pdf-summary-copy,
  .args-pdf-summary-generate {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
  }

  .args-pdf-summary-copy {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #233146;
    background: rgba(29, 155, 240, 0.1);
    transition: background 0.2s ease, color 0.2s ease;
  }

  .args-pdf-summary-copy:hover {
    background: rgba(29, 155, 240, 0.18);
  }

  .args-pdf-summary-copy.copied {
    background: rgba(34, 197, 94, 0.18);
    color: #166534;
  }

  .args-pdf-summary-generate {
    padding: 8px 12px;
    border-radius: 999px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 12px;
    font-weight: 600;
    background: #172033;
    color: white;
  }

  .args-pdf-summary-generate:disabled {
    opacity: 0.7;
    cursor: progress;
  }

  .args-pdf-summary-empty {
    color: rgba(255, 255, 255, 0.5);
    font-size: 12px;
    line-height: 1.5;
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
    border-radius: 8px;
    transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
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
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.2s ease;
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
    background: #E7E9EB;
  }

  :host([data-theme="light"]) .args-mode-slider {
    background: #FFFFFF;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  :host([data-theme="light"]) .args-mode-btn {
    color: #9A9DA3;
  }

  :host([data-theme="light"]) .args-mode-active {
    color: #1F2124;
  }

  :host([data-theme="light"]) .args-mode-btn:hover:not(.args-mode-active) {
    color: #62656B;
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
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.2s, box-shadow 0.2s;
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
    transition: color 0.2s, border-color 0.2s;
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

  .args-prompt-empty {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 2px;
  }

  .args-prompt-empty-title {
    font-size: 13px;
    font-weight: 600;
    color: #fff;
  }

  .args-prompt-empty-body {
    font-size: 12px;
    line-height: 1.55;
    color: rgba(255, 255, 255, 0.65);
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
    transition: opacity 0.2s ease, transform 0.2s ease;
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
    border-color: #E0E2E5;
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
    color: #1F2124;
  }

  :host([data-theme="light"]) .add-tooltip {
    background: #FFFFFF;
    border: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  }
  :host([data-theme="light"]) .add-tooltip-title {
    color: #1F2124;
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
    background: #199A4D;
  }

  :host([data-theme="light"]) .args-purpose-label {
    color: rgba(0, 0, 0, 0.4);
  }

  :host([data-theme="light"]) .args-purpose-input {
    color: #1F2124;
  }

  :host([data-theme="light"]) .args-purpose-input::placeholder {
    color: rgba(0, 0, 0, 0.25);
  }

  :host([data-theme="light"]) .args-purpose-helper {
    color: rgba(0, 0, 0, 0.5);
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
    color: #1F2124;
  }

  :host([data-theme="light"]) .arg-card .note-reply-text {
    color: #62656B;
  }

  :host([data-theme="light"]) .arg-card .note-reply-action-btn {
    color: #62656B;
  }

  :host([data-theme="light"]) .arg-card .note-reply-divider {
    background: rgba(0, 0, 0, 0.1);
  }

  :host([data-theme="light"]) .arg-card .note-reply-send {
    background: #1F2124;
  }

  :host([data-theme="light"]) .arg-card .note-icon-btn,
  :host([data-theme="light"]) .arg-card .note-icon-btn:hover {
    color: #1F2124;
  }

  :host([data-theme="light"]) .arg-card .note-edit-textarea {
    background: rgba(0,0,0,0.05);
    border-color: rgba(0,0,0,0.15);
    color: #1F2124;
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
    color: #1F2124;
  }

  :host([data-theme="light"]) .args-footer-text:hover {
    color: #1F2124;
  }

  :host([data-theme="light"]) .args-sketch-btn {
    background: #748DBF;
    color: #FFFFFF;
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
    color: #1F2124;
  }

  :host([data-theme="light"]) .args-sketch-content {
    color: #1F2124;
  }

  :host([data-theme="light"]) .args-sketch-content strong {
    color: #1F2124;
  }

  :host([data-theme="light"]) .args-pdf-summary-card {
    border-color: rgba(15, 23, 42, 0.08);
  }

  :host([data-theme="light"]) .args-pdf-summary-empty {
    color: rgba(0, 0, 0, 0.5);
  }

  :host([data-theme="light"]) .args-prompt-empty-title {
    color: #1F2124;
  }

  :host([data-theme="light"]) .args-prompt-empty-body {
    color: rgba(0, 0, 0, 0.58);
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
    border-radius: 10px;
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
    transition: background 0.2s;
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
    border-radius: 10px;
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
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.2s;
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
    border-radius: 50%;
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
    color: #1F2124;
  }

  :host([data-theme="light"]) .args-not-enabled-hint {
    color: rgba(0, 0, 0, 0.35);
  }

  :host([data-theme="light"]) .args-run-btn--secondary {
    background: rgba(0, 0, 0, 0.07);
    color: #1F2124;
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
    border-radius: 50%;
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
    transition: color 0.2s ease, background 0.2s ease, opacity 0.2s ease;
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
    transition: opacity 0.2s ease;
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
    transition: opacity 0.2s ease;
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
    border-radius: 999px;
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
    transition: all 0.2s;
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
    transition: opacity 0.2s;
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

  .args-dash-input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: 0.5px solid #e5e7eb;
    border-radius: 20px;
    background: #fff;
    font-size: 12px;
    color: #374151;
    outline: none;
    box-sizing: border-box;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  }

  .args-dash-input::placeholder { color: #b6bcc7; }

  .args-dash-llm-note {
    font-size: 11px;
    line-height: 1.45;
    color: #9ca3af;
    padding: 0 2px;
  }

  .args-dash-llm-note.warn { color: #92600f; }

  .args-dash-llm-note a { color: #374151; }

  .args-dash-llm-actions {
    display: flex;
    gap: 6px;
  }

  .args-dash-llm-btn {
    all: unset;
    flex: 1;
    height: 28px;
    border-radius: 20px;
    font-size: 11px;
    text-align: center;
    cursor: pointer;
    box-sizing: border-box;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  }

  .args-dash-llm-btn-primary {
    background: #1a1a1a;
    color: #fff;
  }

  .args-dash-llm-btn-ghost {
    background: #fff;
    color: #6b7280;
    border: 0.5px solid #e5e7eb;
  }

  .args-dash-llm-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .args-dash-llm-status {
    font-size: 11px;
    min-height: 14px;
    padding: 0 2px;
  }

  .args-dash-llm-status.ok { color: #2f7d4f; }
  .args-dash-llm-status.err { color: #b3261e; }

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
    transition: opacity 0.2s;
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
    border-radius: 6px;
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
    border-radius: 999px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    box-sizing: border-box;
    transition: background 0.2s;
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
    border-radius: 8px;
    font-size: 13px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    outline: none;
    transition: border-color 0.2s;
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
    border-radius: 8px;
    font-size: 13px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    outline: none;
    transition: border-color 0.2s;
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
    border-radius: 8px;
    font-size: 13px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    outline: none;
    transition: border-color 0.2s;
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
    border-radius: 999px;
    background: #fff;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    color: #3a3a36;
    transition: all 0.2s;
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
    border-radius: 999px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    text-align: center;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    transition: opacity 0.2s;
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
    border-radius: 8px;
    font-size: 12px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #111;
    background: #fff;
    box-sizing: border-box;
    transition: border-color 0.2s;
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
    border-radius: 999px;
    background: #fff;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    color: #3a3a36;
    font-family: -apple-system, "Helvetica Neue", Helvetica, sans-serif;
    transition: all 0.2s;
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
    transition: opacity 0.2s ease;
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
    transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
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
    transition: background-color 0.2s ease, border-bottom-color 0.2s ease;
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
    transition: opacity 0.2s ease, transform 0.2s ease;
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
    transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
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
    transition: opacity 0.2s ease, transform 0.2s ease;
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
    transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
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
    transition: opacity 0.2s ease, max-height 0.2s ease;
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
    transition: opacity 0.2s ease, transform 0.2s ease;
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
    border-radius: 999px;
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
    transition: opacity 0.2s ease, transform 0.2s ease, max-height 0.2s ease, padding 0.2s ease, margin 0.2s ease, border-width 0.2s ease;
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
    border-radius: 999px;
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
    transition: grid-template-rows 0.2s ease, opacity 0.2s ease;
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
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.2s;
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
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 11px;
    line-height: 1.4;
    padding: 8px 14px;
    border-radius: 6px;
    border: 1px solid #333;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s, transform 0.2s;
    z-index: 100;
    margin-bottom: 8px;
  }

  .args-toast.visible {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  :host([data-theme="light"]) .args-toast {
    background: #FFFFFF;
    color: #1F2124;
    border-color: #E0E2E5;
    box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  }

  /* ── Google Docs panel styles ── */

  /* Panel face in GDocs mode: white background, flex column */
  .args-container.expanded .args-panel-face {
    background: #FFFFFF;
  }

  /* Header: back arrow + title */
  .args-gdocs-back {
    cursor: pointer;
    font-size: 16px;
    color: #1E2229;
    margin-right: 8px;
    opacity: 0.6;
    transition: opacity 0.15s;
  }
  .args-gdocs-back:hover {
    opacity: 1;
  }
  .args-gdocs-title-text {
    font-size: 14px;
    font-weight: 600;
    color: #1E2229;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }

  /* Override args-main-title to flex when in GDocs */
  .args-panel-header .args-main-title:has(.args-gdocs-back) {
    display: flex;
    align-items: center;
  }

  /* Persona subtitle */
  .args-gdocs-persona {
    padding: 0 16px 10px;
    margin-top: -4px;
  }
  .args-gdocs-persona-text {
    font-family: 'Fragment Mono', 'Courier New', monospace;
    font-size: 11px;
    color: #888;
    font-weight: 400;
  }

  /* GDocs tab bar */
  .args-tab-bar--gdocs {
    border-bottom: 1px solid #E8E8E8;
    padding: 0 16px;
    gap: 0;
  }

  .args-gdocs-tab {
    all: unset;
    cursor: pointer;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    font-weight: 400;
    color: #B0B0B0;
    padding: 0 16px 10px 0;
    margin-right: 8px;
    position: relative;
    transition: color 0.15s;
  }
  .args-gdocs-tab:first-child {
    padding-left: 0;
  }
  .args-gdocs-tab.active {
    color: #1E2229;
    font-weight: 600;
  }
  .args-gdocs-tab.active::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 16px;
    height: 2px;
    background: #1E2229;
    border-radius: 1px;
  }

  /* GDocs list: flow layout, not absolute */
  .args-panel-face:has(.args-gdocs-chat-section) .args-list {
    position: static;
    height: auto;
    overflow-y: auto;
    padding: 0;
  }

  /* Memo edit mode pill */
  .args-gdocs-memo-pill {
    display: flex;
    align-items: center;
    gap: 5px;
    background: #1E2229;
    color: #FFFFFF;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 12px;
    font-weight: 500;
    padding: 3px 8px 3px 10px;
    border-radius: 999px;
    width: fit-content;
    margin-bottom: 6px;
  }
  .args-gdocs-memo-pill-x {
    all: unset;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    opacity: 0.7;
    padding: 0 1px;
  }
  .args-gdocs-memo-pill-x:hover {
    opacity: 1;
  }

  /* GDocs arg cards */
  .gdocs-arg-card {
    padding: 16px 16px 12px;
    cursor: pointer;
    background: #FFFFFF;
    transition: background 0.1s;
  }
  .gdocs-arg-card:hover {
    background: #FAFAFA;
  }
  .gdocs-arg-card--selectable {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 10px;
    cursor: default;
  }
  .gdocs-arg-card--selectable .args-gdocs-checkbox {
    margin-top: 2px;
    flex-shrink: 0;
  }
  .gdocs-arg-card-content {
    flex: 1;
    min-width: 0;
  }
  .gdocs-arg-title {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    font-weight: 700;
    color: #1E2229;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 3px;
  }
  .gdocs-arg-timestamp {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 11px;
    color: #ABABAB;
    margin-bottom: 7px;
  }
  .gdocs-arg-body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    color: #333;
    line-height: 1.55;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .gdocs-arg-divider {
    height: 1px;
    background: #F0F0F0;
    margin: 0 16px;
  }

  /* GDocs card expanded state */
  .gdocs-arg-card--expanded {
    position: relative;
    z-index: 10;
    margin: 4px -12px;
    padding: 16px 28px 14px;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.13);
    background: #FFFFFF;
  }
  .gdocs-arg-card--expanded .gdocs-arg-body {
    -webkit-line-clamp: unset;
    overflow: visible;
    display: block;
  }
  .gdocs-arg-expanded-footer {
    display: none;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
  }
  .gdocs-arg-card--expanded .gdocs-arg-expanded-footer {
    display: flex;
  }
  .gdocs-arg-goto {
    all: unset;
    cursor: pointer;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 12px;
    color: #888;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .gdocs-arg-goto:hover {
    color: #444;
  }
  .gdocs-arg-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .gdocs-arg-icon-btn {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    color: #999;
    transition: color 0.12s, background 0.12s;
  }
  .gdocs-arg-icon-btn:hover {
    color: #333;
    background: #F2F2F2;
  }
  .gdocs-arg-icon-btn--delete:hover {
    color: #D93025;
    background: #FEF0EF;
  }
  .gdocs-arg-edit-textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    color: #333;
    line-height: 1.55;
    border: 1px solid #D0D0D0;
    border-radius: 6px;
    padding: 7px 9px;
    resize: vertical;
    outline: none;
    margin-top: 4px;
  }
  .gdocs-arg-edit-textarea:focus {
    border-color: #888;
  }
  .gdocs-arg-edit-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .gdocs-arg-edit-save {
    all: unset;
    cursor: pointer;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 11px;
    font-weight: 600;
    color: #FFF;
    background: #1E2229;
    padding: 4px 10px;
    border-radius: 5px;
  }
  .gdocs-arg-edit-save:hover {
    background: #333;
  }
  .gdocs-arg-edit-cancel {
    all: unset;
    cursor: pointer;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 11px;
    color: #888;
    padding: 4px 8px;
  }
  .gdocs-arg-edit-cancel:hover {
    color: #333;
  }

  /* GDocs resource panel */
  .args-gdocs-resource-panel {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }
  .args-gdocs-outline-panel {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }
  .args-gdocs-outline-text {
    flex: 1;
    font-size: 12.5px;
    line-height: 1.7;
    color: #374151;
    white-space: pre-wrap;
  }
  .args-gdocs-outline-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .args-gdocs-outline-btn {
    height: 28px;
    padding: 0 12px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    border: none;
    transition: background 0.12s;
  }
  .args-gdocs-outline-btn-continue {
    background: #111;
    color: #fff;
  }
  .args-gdocs-outline-btn-continue:hover { background: #333; }
  .args-gdocs-outline-btn-secondary {
    background: #f0f2f5;
    color: #6b7280;
  }
  .args-gdocs-outline-btn-secondary:hover { background: #e5e7eb; }
  .args-gdocs-outline-other {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .args-gdocs-outline-feedback {
    width: 100%;
    border: 1px solid #e8e8e2;
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 12px;
    font-family: inherit;
    color: #1a1a1a;
    outline: none;
    resize: none;
    background: #fff;
  }
  .args-gdocs-outline-feedback:focus { border-color: #9aa0a6; }
  .args-gdocs-outline-feedback-row {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .args-gdocs-resource-list {
    flex: 1;
  }
  .args-gdocs-select-all-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
  }
  .args-gdocs-select-all-label {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    color: #1E2229;
  }
  .args-gdocs-checkbox {
    appearance: none;
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    background: #E5E5E5;
    cursor: pointer;
    flex-shrink: 0;
    position: relative;
  }
  .args-gdocs-checkbox:checked::after {
    content: '';
    position: absolute;
    left: 4px;
    top: 1px;
    width: 5px;
    height: 9px;
    border: 1.8px solid #8C9096;
    border-top: none;
    border-left: none;
    transform: rotate(45deg);
  }
  .args-gdocs-checkbox:indeterminate::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 6px;
    width: 8px;
    height: 1.8px;
    background: #8C9096;
  }
  .args-gdocs-resource-item {
    padding: 10px 16px 10px;
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 10px;
  }
  .args-gdocs-resource-text-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .args-gdocs-resource-name {
    font-size: 13px;
    font-weight: 600;
    color: #1E2229;
    line-height: 1.3;
  }
  .args-gdocs-resource-meta {
    font-size: 12px;
    color: #9AA0A6;
  }
  .args-gdocs-resource-preview {
    font-size: 12px;
    color: #666;
    line-height: 1.45;
    margin-top: 3px;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .args-gdocs-resource-menu-btn {
    all: unset;
    cursor: pointer;
    font-size: 16px;
    color: #ABABAB;
    padding: 0 4px;
    line-height: 1;
    border-radius: 4px;
    flex-shrink: 0;
    align-self: flex-start;
    transition: color 0.12s, background 0.12s;
  }
  .args-gdocs-resource-menu-btn:hover {
    color: #555;
    background: #F0F0F0;
  }
  .args-gdocs-resource-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    background: #FFFFFF;
    border: 1px solid #E8E8E8;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.12);
    z-index: 100;
    min-width: 110px;
    overflow: hidden;
  }
  .args-gdocs-resource-dropdown-item {
    all: unset;
    cursor: pointer;
    display: block;
    width: 100%;
    padding: 9px 14px;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    box-sizing: border-box;
    transition: background 0.1s;
  }
  .args-gdocs-resource-dropdown-item:hover {
    background: #F5F5F5;
  }
  .args-gdocs-resource-dropdown-item--delete {
    color: #D93025;
  }
  .args-gdocs-resource-divider {
    height: 1px;
    background: #F0F0F0;
    margin: 0 16px;
  }
  .args-gdocs-new-resource {
    padding: 14px 16px 12px;
    border-top: 1px solid #F0F0F0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .args-gdocs-new-resource-title {
    font-size: 13px;
    font-weight: 700;
    color: #1E2229;
  }
  .args-gdocs-resource-name-input {
    all: unset;
    display: block;
    width: 100%;
    box-sizing: border-box;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    font-weight: 600;
    color: #1E2229;
    border-bottom: 1px solid #E0E0E0;
    padding-bottom: 5px;
    transition: border-color 0.15s;
  }
  .args-gdocs-resource-name-input:focus {
    border-bottom-color: #1E2229;
  }
  .args-gdocs-resource-name-input::placeholder {
    font-weight: 400;
    color: #ABABAB;
  }
  .args-gdocs-radio-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: #1E2229;
  }
  .args-gdocs-radio-row input[type="radio"] {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid #C4C4C4;
    background: #fff;
    cursor: pointer;
    margin: 0;
    flex-shrink: 0;
    position: relative;
    transition: border-color 0.15s;
  }
  .args-gdocs-radio-row input[type="radio"]:checked {
    border-color: #22c55e;
    border-width: 4px;
    background: #fff;
  }
  .args-gdocs-radio-row label {
    cursor: pointer;
    color: #1E2229;
    font-size: 13px;
    margin-right: 8px;
  }
  .args-gdocs-resource-textarea {
    all: unset;
    display: block;
    width: 100%;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    color: #1E2229;
    line-height: 1.5;
    resize: none;
    height: 60px;
    box-sizing: border-box;
    overflow-y: auto;
  }
  .args-gdocs-resource-textarea::placeholder {
    color: #ABABAB;
  }
  .args-gdocs-resource-save-row {
    display: flex;
    justify-content: flex-end;
  }
  .args-gdocs-resource-save-btn {
    all: unset;
    cursor: pointer;
    background: #1E2229;
    color: #FFFFFF;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 16px;
    border-radius: 9999px;
    transition: opacity 0.15s;
  }
  .args-gdocs-resource-save-btn:hover {
    opacity: 0.8;
  }

  /* GDocs chat section */
  .args-gdocs-chat-section {
    flex-shrink: 0;
    padding: 8px 8px 10px;
    background: #FFFFFF;
  }
  .args-gdocs-chat-box {
    background: #FFFFFF;
    border: 1px solid #E8E8E8;
    border-radius: 5px;
    padding: 12px 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.07);
    position: relative;
  }
  @keyframes args-gdocs-spin {
    to { transform: rotate(360deg); }
  }
  .args-gdocs-spinner {
    display: none;
    position: absolute;
    top: 12px;
    right: 12px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.5px solid #E0E0E0;
    border-top-color: #ABABAB;
    animation: args-gdocs-spin 0.75s linear infinite;
    pointer-events: none;
  }
  .args-gdocs-spinner.visible {
    display: block;
  }
  .args-gdocs-chat-textarea {
    all: unset;
    display: block;
    width: 100%;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    color: #1E2229;
    line-height: 1.5;
    resize: none;
    min-height: 80px;
    box-sizing: border-box;
    flex: 1;
  }
  .args-gdocs-chat-textarea::placeholder {
    color: #ABABAB;
  }
  .args-gdocs-chat-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .args-gdocs-mode-pills {
    flex-shrink: 0;
  }
  .args-gdocs-pill-btn {
    all: unset;
    cursor: pointer;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    font-weight: 400;
    color: #8C9096;
    background: #EDEDED;
    padding: 7px 16px;
    border-radius: 10px;
    white-space: nowrap;
    transition: background 0.15s, color 0.15s;
  }
  .args-gdocs-pill-btn:hover {
    background: #E4E4E4;
  }
  .args-gdocs-pill-divider {
    display: none;
  }
  .args-gdocs-dropdown-wrap {
    position: relative;
    flex-shrink: 0;
  }
  .args-gdocs-dropdown-btn {
    all: unset;
    cursor: pointer;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 12px;
    color: #666;
    padding: 5px 10px;
    border-radius: 8px;
    background: transparent;
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
  }
  .args-gdocs-dropdown-btn:hover {
    background: rgba(0,0,0,0.06);
    color: #1E2229;
  }
  .args-gdocs-dropdown-menu {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    background: #FFFFFF;
    border: 1px solid #E8E8E8;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.1);
    overflow: hidden;
    z-index: 10;
    min-width: 100px;
  }
  .args-gdocs-dropdown-option {
    all: unset;
    cursor: pointer;
    display: block;
    width: 100%;
    padding: 8px 14px;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 12.5px;
    color: #555;
    transition: background 0.1s;
    box-sizing: border-box;
  }
  .args-gdocs-dropdown-option:hover {
    background: #F5F5F5;
    color: #1E2229;
  }
  .args-gdocs-dropdown-option.active {
    font-weight: 600;
    color: #1E2229;
  }
  .args-gdocs-fast-btn {
    all: unset;
    cursor: pointer;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    color: #C4C4C4;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color 0.15s, background 0.15s;
  }
  .args-gdocs-fast-btn:hover {
    color: #1E2229;
  }
  .args-gdocs-fast-btn.active {
    color: #F59E0B;
  }
  .args-gdocs-send-btn {
    all: unset;
    cursor: pointer;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: #1E2229;
    color: #FFFFFF;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }
  .args-gdocs-send-btn:hover {
    opacity: 0.8;
  }

  /* Keep panel header readable (white bg in GDocs) */
  .args-panel-face:has(.args-gdocs-chat-section) .args-panel-header {
    border-bottom: none;
  }
  .args-panel-face:has(.args-gdocs-chat-section) .args-main-title,
  .args-panel-face:has(.args-gdocs-chat-section) .args-header-icon-btn {
    color: #1E2229;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
    }
  }
`;
