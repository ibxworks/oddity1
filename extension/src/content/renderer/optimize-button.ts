
const OPTIMIZE_BUTTON_CSS = `
:host {
  display: block;
  position: absolute;
  z-index: 2147483647;
  pointer-events: none;
}

.oddity-optimize-btn {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  background: #FFFFFF;
  border: 1px solid #E0E2E5;
  border-radius: 999px;
  padding: 4px 10px;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  font-weight: 500;
  color: #1F2124;
  cursor: pointer;
  box-shadow: 0 0 0 1px #ECEDEF, 0 2px 8px rgba(31, 33, 36, 0.06);
  transition: background 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
  transform: translateY(-100%);
  margin-top: -8px;
}

.oddity-optimize-btn:hover {
  background: #F4F5F6;
  box-shadow: 0 0 0 1px #E0E2E5, 0 3px 6px rgba(31, 33, 36, 0.08);
}

.oddity-optimize-btn:active {
  transform: translateY(-100%) scale(0.96);
}

.oddity-optimize-btn.loading {
  background: #F2F2F3;
  color: #9A9DA3;
  pointer-events: none;
}

.oddity-optimize-icon {
  width: 14px;
  height: 14px;
}

[data-theme="dark"] .oddity-optimize-btn {
  background: #2a2a2a;
  border-color: #3f3f3f;
  color: #e5e5e5;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

[data-theme="dark"] .oddity-optimize-btn:hover {
  background: #333;
}

.oddity-optimize-tooltip {
  position: absolute;
  bottom: calc(100% + 14px);
  left: 50%;
  transform: translateX(-50%);
  background: #25272B;
  color: #F6F7F8;
  padding: 5px 9px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 400;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s ease;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.oddity-optimize-btn:hover .oddity-optimize-tooltip {
  opacity: 1;
}

[data-theme="dark"] .oddity-optimize-tooltip {
  background: #444;
}

@media (prefers-reduced-motion: reduce) {
  .oddity-optimize-btn,
  .oddity-optimize-tooltip {
    transition-duration: 0.01ms;
  }
}
`;

export interface OptimizeTarget {
  selector: string;
  displayName: string | null;
}

let hostEl: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let btnEl: HTMLButtonElement | null = null;
let tooltipEl: HTMLDivElement | null = null;
let iconImgEl: HTMLImageElement | null = null;
let textSpanEl: HTMLSpanElement | null = null;
let targetConfig: OptimizeTarget | null = null;
let positionTimer: ReturnType<typeof setInterval> | null = null;
let isLoading = false;
let resizeObserver: ResizeObserver | null = null;

// The callback to execute the actual prompt optimization
let onTriggerOptimizeCb: ((text: string) => void) | null = null;
// The callback to perform the pasting into the chatbot
let onPasteCb: ((selector: string, text: string) => void) | null = null;

export function initOptimizeButton(
  config: OptimizeTarget,
  handleTriggerOptimize: (text: string) => void,
  handlePaste: (selector: string, text: string) => void
): void {
  if (hostEl) return;
  targetConfig = config;
  onTriggerOptimizeCb = handleTriggerOptimize;
  onPasteCb = handlePaste;

  hostEl = document.createElement("oddity-optimize-overlay");
  // Set theme based on body (or let arguments-box manage it)
  if (document.documentElement.classList.contains("dark")) {
    hostEl.dataset.theme = "dark";
  }
  document.body.appendChild(hostEl);

  shadowRoot = hostEl.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = OPTIMIZE_BUTTON_CSS;
  shadowRoot.appendChild(style);

  btnEl = document.createElement("button");
  btnEl.className = "oddity-optimize-btn";

  iconImgEl = document.createElement("img");
  iconImgEl.src = chrome.runtime.getURL("Terry.png");
  iconImgEl.className = "oddity-optimize-icon";

  textSpanEl = document.createElement("span");
  textSpanEl.textContent = "Optimize Prompt with Oddity1";

  tooltipEl = document.createElement("div");
  tooltipEl.className = "oddity-optimize-tooltip";
  const name = config.displayName || "chatbot";
  tooltipEl.textContent = `Oddity1 builds a complete prompt for ${name} from the page, your compiled notes and replies, and your prompt.`;

  btnEl.appendChild(iconImgEl);
  btnEl.appendChild(textSpanEl);
  btnEl.appendChild(tooltipEl);
  shadowRoot.appendChild(btnEl);

  btnEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isLoading) return;
    performOptimization();
  });

  // Track position
  startPositionTracking();
}

function getChatbotInputText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return el.value || "";
  }
  return el.innerText || el.textContent || "";
}

function performOptimization() {
  if (!targetConfig || !onTriggerOptimizeCb || !onPasteCb) return;

  const el = document.querySelector(targetConfig.selector) as HTMLElement | null;
  if (!el) return;

  const currentText = getChatbotInputText(el);
  if (!currentText.trim()) return;

  isLoading = true;
  if (btnEl && textSpanEl) {
    btnEl.classList.add("loading");
    textSpanEl.textContent = "⏳ Optimizing ...";
    // Placeholder text in the chat input
    onPasteCb(targetConfig.selector, "Optimizing your prompt...");
  }

  const finishListener = (e: Event) => {
    document.removeEventListener("oddity:optimizePromptDone", finishListener);
    isLoading = false;
    const detail = (e as CustomEvent).detail || {};

    // On error, revert to current text
    if (detail.error) {
       console.error("[Oddity 1] Optimize prompt failed:", detail.error);
       if (onPasteCb && targetConfig) onPasteCb(targetConfig.selector, currentText);
    }

    // On success, the paste is already handled by arguments-box
    if (btnEl && textSpanEl) {
      btnEl.classList.remove("loading");
      textSpanEl.textContent = "Optimize Prompt with Oddity1";
    }
  };

  document.addEventListener("oddity:optimizePromptDone", finishListener);

  try {
    onTriggerOptimizeCb(currentText);
  } catch (err) {
    document.removeEventListener("oddity:optimizePromptDone", finishListener);
    isLoading = false;
    if (btnEl && textSpanEl) {
      btnEl.classList.remove("loading");
      textSpanEl.textContent = "Optimize Prompt with Oddity1";
    }
    onPasteCb(targetConfig.selector, currentText);
  }
}


function startPositionTracking() {
  const updatePosition = () => {
    if (!targetConfig || !hostEl) return;
    const el = document.querySelector(targetConfig.selector) as HTMLElement | null;
    if (!el) {
      hostEl.style.display = "none";
      return;
    }
    const rect = el.getBoundingClientRect();
    // Only show if the input is visible
    if (rect.width === 0 || rect.height === 0 || rect.top < 0) {
      hostEl.style.display = "none";
      return;
    }

    // Also hide if text input is empty? The reference image shows it when text is present.
    // Let's just always show it, or check if there is text?
    // If we want it only when text is typed:
    // const text = getChatbotInputText(el);
    // if (!text.trim() && !isLoading) { hostEl.style.display = 'none'; return; }

    hostEl.style.display = "block";
    hostEl.style.left = `${rect.left + window.scrollX}px`;
    hostEl.style.top = `${rect.top + window.scrollY}px`;
    hostEl.style.width = `${rect.width}px`;
  };

  updatePosition();
  positionTimer = setInterval(updatePosition, 200);

  // Attempt to observe layout shifts on the body
  if (window.ResizeObserver) {
    resizeObserver = new ResizeObserver(() => updatePosition());
    resizeObserver.observe(document.body);
  }
}

export function destroyOptimizeButton(): void {
  if (positionTimer) {
    clearInterval(positionTimer);
    positionTimer = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (hostEl) {
    hostEl.remove();
    hostEl = null;
    shadowRoot = null;
    btnEl = null;
    textSpanEl = null;
    iconImgEl = null;
    tooltipEl = null;
  }
  targetConfig = null;
  onTriggerOptimizeCb = null;
  onPasteCb = null;
}
