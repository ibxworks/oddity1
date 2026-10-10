// ─── Auth Toast ───
// Dismissible Shadow DOM toast prompting the user to sign in.
// Idempotent — calling showAuthToast() multiple times shows only one toast.

import { LIGHT_TOKENS } from "@oddity/shared";
import { TOAST_CSS } from "./toast-theme.js";

let shown = false;

export function showAuthToast(): void {
  if (shown) return;
  shown = true;

  const host = document.createElement("oddity-auth-toast");
  const shadow = host.attachShadow({ mode: "closed" });

  shadow.innerHTML = `
    <style>${TOAST_CSS}</style>
    <div class="toast" role="status" aria-live="polite">
      <span class="msg">Sign in to Oddity 1 to see annotations 👇</span>
      <button class="dismiss" aria-label="Dismiss">\u00d7</button>
    </div>
  `;

  function dismiss(): void {
    const toast = shadow.querySelector(".toast");
    if (!toast) {
      host.remove();
      return;
    }
    toast.classList.add("hiding");
    toast.addEventListener("animationend", () => host.remove(), { once: true });
  }

  shadow.querySelector(".dismiss")!.addEventListener("click", dismiss);

  // Auto-dismiss after the shared sign-in prompt interval
  setTimeout(dismiss, LIGHT_TOKENS.motion.toastPromptMs);

  document.body.appendChild(host);
}
