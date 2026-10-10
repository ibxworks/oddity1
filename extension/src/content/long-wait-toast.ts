import { TOAST_CSS } from "./toast-theme.js";

const TOAST_TAG = "oddity-long-wait-toast";
const MESSAGES = [
  "Long read detected. Brewing your annotations now...",
  "It's a lot of text! Generating annotations for you...",
];

let host: HTMLElement | null = null;

export function showLongWaitToast(): void {
  if (host || !document.body) return;

  host = document.createElement(TOAST_TAG);
  const shadow = host.attachShadow({ mode: "open" });
  const message = MESSAGES[Math.floor(Math.random() * MESSAGES.length)]!;

  shadow.innerHTML = `
    <style>${TOAST_CSS}</style>
    <div class="toast" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <span class="msg"></span>
    </div>
  `;
  const msgEl = shadow.querySelector(".msg");
  if (msgEl) msgEl.textContent = message;

  document.body.appendChild(host);
}

export function hideLongWaitToast(): void {
  if (!host) return;
  const localHost = host;
  const shadow = localHost.shadowRoot;
  const toast = shadow?.querySelector(".toast");
  host = null;

  if (!toast) {
    localHost.remove();
    return;
  }

  toast.classList.add("hiding");
  toast.addEventListener("animationend", () => localHost.remove(), {
    once: true,
  });
}
