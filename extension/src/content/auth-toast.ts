// ─── Auth Toast ───
// Dismissible Shadow DOM toast prompting the user to sign in.
// Idempotent — calling showAuthToast() multiple times shows only one toast.

let shown = false;

export function showAuthToast(): void {
  if (shown) return;
  shown = true;

  const host = document.createElement("oddity-auth-toast");
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
        gap: 10px;
        padding: 12px 16px;
        background: #1e293b;
        color: #f1f5f9;
        border-radius: 8px;
        font-size: 13px;
        line-height: 1.4;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        max-width: 340px;
        animation: slideIn 0.25s ease-out;
      }
      .toast.hiding {
        animation: slideOut 0.2s ease-in forwards;
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
      .dismiss:hover { color: #f1f5f9; }
      @keyframes slideIn {
        from { opacity: 0; transform: translateX(20px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      @keyframes slideOut {
        from { opacity: 1; transform: translateX(0); }
        to   { opacity: 0; transform: translateX(20px); }
      }
    </style>
    <div class="toast">
      <span>Sign in to Oddity 1 to see annotations.</span>
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

  // Auto-dismiss after 8 seconds
  setTimeout(dismiss, 8000);

  document.body.appendChild(host);
}
