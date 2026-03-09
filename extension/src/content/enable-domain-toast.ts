// ─── Enable Domain Toast ───
// Shadow DOM toast asking the user to enable Oddity 1 for the current domain.
// Idempotent — calling showEnableDomainToast() multiple times shows only one toast.

import { sendMessage } from "../shared/messaging.js";

let shown = false;
let hostEl: HTMLElement | null = null;

export function showEnableDomainToast(domain: string): void {
  if (shown) return;
  shown = true;

  hostEl = document.createElement("oddity-enable-toast");
  const shadow = hostEl.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
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
    .msg { flex: 1; }
    .msg strong { font-weight: 600; }
    .enable-btn {
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
    .enable-btn:hover { background: #16a34a; }
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
    .dismiss:hover { color: #f1f5f9; }
    @keyframes slideIn {
      from { opacity: 0; transform: translateX(20px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes slideOut {
      from { opacity: 1; transform: translateX(0); }
      to   { opacity: 0; transform: translateX(20px); }
    }
  `;
  shadow.appendChild(style);

  const toast = document.createElement("div");
  toast.className = "toast";

  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = "Always enable Oddity 1 for ";
  const strong = document.createElement("strong");
  strong.textContent = domain;
  msg.appendChild(strong);
  msg.appendChild(document.createTextNode("?"));

  const enableBtn = document.createElement("button");
  enableBtn.className = "enable-btn";
  enableBtn.textContent = "Enable";

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "dismiss";
  dismissBtn.setAttribute("aria-label", "Dismiss");
  dismissBtn.textContent = "\u00d7";

  toast.appendChild(msg);
  toast.appendChild(enableBtn);
  toast.appendChild(dismissBtn);
  shadow.appendChild(toast);

  function dismiss(): void {
    toast.classList.add("hiding");
    toast.addEventListener(
      "animationend",
      () => {
        hostEl?.remove();
        hostEl = null;
      },
      { once: true },
    );
  }

  enableBtn.addEventListener("click", () => {
    sendMessage({ action: "addEnabledSite", payload: { domain } }).catch(
      () => {},
    );
    dismiss();
  });

  dismissBtn.addEventListener("click", dismiss);

  document.body.appendChild(hostEl);
}

export function hideEnableDomainToast(): void {
  if (hostEl) {
    hostEl.remove();
    hostEl = null;
  }
}
