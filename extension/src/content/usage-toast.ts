type UsageToastOptions = {
  title?: string;
  message: string;
  actionLabel?: string;
  actionUrl?: string;
};

const TOAST_TAG = "oddity-usage-toast";

let hostEl: HTMLElement | null = null;
let toastEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let messageEl: HTMLDivElement | null = null;
let actionsEl: HTMLDivElement | null = null;
let actionBtnEl: HTMLButtonElement | null = null;
let currentActionUrl: string | null = null;

export function showUsageToast(options: UsageToastOptions): void {
  if (!document.body) return;

  if (!hostEl) {
    hostEl = document.createElement(TOAST_TAG);
    const shadow = hostEl.attachShadow({ mode: "closed" });

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
          align-items: flex-start;
          gap: 10px;
          padding: 12px 16px;
          background: #1e293b;
          color: #f1f5f9;
          border-radius: 8px;
          font-size: 13px;
          line-height: 1.4;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
          max-width: 360px;
          animation: slideIn 0.25s ease-out;
        }
        .toast.hiding {
          animation: slideOut 0.2s ease-in forwards;
        }
        .text {
          flex: 1;
          min-width: 0;
        }
        .title {
          font-weight: 600;
          margin-bottom: 4px;
        }
        .message {
          color: #cbd5e1;
        }
        .actions {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 10px;
        }
        .action-btn {
          display: none;
          background: #22c55e;
          color: #fff;
          border: none;
          border-radius: 6px;
          padding: 6px 14px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          flex-shrink: 0;
          transition: background 0.15s;
        }
        .action-btn:hover {
          background: #16a34a;
        }
        .dismiss {
          background: none;
          border: none;
          color: #94a3b8;
          cursor: pointer;
          font-size: 16px;
          padding: 0 0 0 4px;
          line-height: 1;
          flex-shrink: 0;
        }
        .dismiss:hover {
          color: #f1f5f9;
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
        <div class="text">
          <div class="title"></div>
          <div class="message"></div>
          <div class="actions">
            <button class="action-btn" type="button"></button>
          </div>
        </div>
        <button class="dismiss" aria-label="Dismiss" type="button">\u00d7</button>
      </div>
    `;

    toastEl = shadow.querySelector(".toast");
    titleEl = shadow.querySelector(".title");
    messageEl = shadow.querySelector(".message");
    actionsEl = shadow.querySelector(".actions");
    actionBtnEl = shadow.querySelector(".action-btn");

    shadow.querySelector(".dismiss")?.addEventListener("click", dismissUsageToast);
    actionBtnEl?.addEventListener("click", () => {
      if (!currentActionUrl) return;
      window.open(currentActionUrl, "_blank", "noopener,noreferrer");
    });

    document.body.appendChild(hostEl);
  } else if (!hostEl.isConnected) {
    document.body.appendChild(hostEl);
  }

  if (!toastEl || !titleEl || !messageEl || !actionsEl || !actionBtnEl) return;

  titleEl.textContent = options.title ?? "";
  titleEl.style.display = options.title ? "block" : "none";
  messageEl.textContent = options.message;

  currentActionUrl = options.actionUrl ?? null;
  actionBtnEl.textContent = options.actionLabel ?? "";
  actionsEl.style.display =
    options.actionLabel && options.actionUrl ? "flex" : "none";
  actionBtnEl.style.display =
    options.actionLabel && options.actionUrl ? "inline-flex" : "none";

  toastEl.classList.remove("hiding");
}

function dismissUsageToast(): void {
  if (!hostEl || !toastEl) {
    cleanupUsageToast(hostEl);
    return;
  }

  const localHost = hostEl;
  const localToast = toastEl;
  localToast.classList.add("hiding");
  localToast.addEventListener("animationend", () => cleanupUsageToast(localHost), {
    once: true,
  });
}

function cleanupUsageToast(localHost: HTMLElement | null): void {
  if (hostEl === localHost) {
    hostEl = null;
    toastEl = null;
    titleEl = null;
    messageEl = null;
    actionsEl = null;
    actionBtnEl = null;
    currentActionUrl = null;
  }
  localHost?.remove();
}
