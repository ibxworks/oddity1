import { TOAST_CSS } from "./toast-theme.js";

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
      <style>${TOAST_CSS}</style>
      <div class="toast toast--top" role="status" aria-live="polite">
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
