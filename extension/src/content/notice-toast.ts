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
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes slideOut {
          from { opacity: 1; transform: translateX(0); }
          to   { opacity: 0; transform: translateX(20px); }
        }
      </style>
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
    }, 3000);
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
