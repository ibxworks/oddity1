import { LIGHT_TOKENS } from "@oddity/shared";
import { TOAST_CSS } from "./toast-theme.js";

const TOAST_TAG = "oddity-notice-toast";

let host: HTMLElement | null = null;
let toastEl: HTMLDivElement | null = null;
let messageEl: HTMLSpanElement | null = null;
let hideTimer: number | null = null;

export function dismissNoticeToast(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }

  if (!host || !toastEl) {
    cleanupNoticeToast(host);
    return;
  }

  const localHost = host;
  const localToast = toastEl;

  localToast.classList.add("hiding");
  localToast.addEventListener("animationend", () => cleanupNoticeToast(localHost), {
    once: true,
  });
}

export function showNoticeToast(message: string, persistent = false): void {
  if (!document.body) return;

  if (!host) {
    host = document.createElement(TOAST_TAG);
    const shadow = host.attachShadow({ mode: "closed" });

    shadow.innerHTML = `
      <style>${TOAST_CSS}</style>
      <div class="toast" role="status" aria-live="polite">
        <span class="message"></span>
      </div>
    `;

    toastEl = shadow.querySelector(".toast");
    messageEl = shadow.querySelector(".message");
    document.body.appendChild(host);
  }

  if (!host || !toastEl || !messageEl) return;

  toastEl.classList.remove("hiding");
  messageEl.textContent = message;

  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }

  if (!persistent) {
    hideTimer = window.setTimeout(() => {
      dismissNoticeToast();
    }, LIGHT_TOKENS.motion.toastNoticeMs);
  }
}

function cleanupNoticeToast(localHost: HTMLElement | null): void {
  if (host === localHost) {
    host = null;
    toastEl = null;
    messageEl = null;
  }
  localHost?.remove();
}
