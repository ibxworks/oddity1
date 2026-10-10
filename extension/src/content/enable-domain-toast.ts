// ─── Enable Domain Toast ───
// Shadow DOM toast asking the user to enable Oddity 1 for the current domain.
// Idempotent — calling showEnableDomainToast() multiple times shows only one toast.

import { TOAST_CSS } from "./toast-theme.js";
import { sendMessage } from "../shared/messaging.js";

let shown = false;
let hostEl: HTMLElement | null = null;

export function showEnableDomainToast(domain: string): void {
  if (shown) return;
  shown = true;

  hostEl = document.createElement("oddity-enable-toast");
  const shadow = hostEl.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = TOAST_CSS;
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
