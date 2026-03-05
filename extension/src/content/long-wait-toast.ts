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
    <style>
      :host {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .toast {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        background: #0f172a;
        color: #e2e8f0;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.25);
        font-size: 13px;
        line-height: 1.4;
        box-shadow: 0 8px 24px rgba(2, 6, 23, 0.35);
        max-width: 340px;
        animation: slideIn 0.22s ease-out;
      }
      .toast.hiding {
        animation: slideOut 0.18s ease-in forwards;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #38bdf8;
        box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.7);
        animation: pulse 1.2s infinite;
        flex-shrink: 0;
      }
      @keyframes slideIn {
        from { opacity: 0; transform: translateX(20px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      @keyframes slideOut {
        from { opacity: 1; transform: translateX(0); }
        to   { opacity: 0; transform: translateX(20px); }
      }
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.7); }
        70% { box-shadow: 0 0 0 8px rgba(56, 189, 248, 0); }
        100% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0); }
      }
    </style>
    <div class="toast" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <span>${message}</span>
    </div>
  `;

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
