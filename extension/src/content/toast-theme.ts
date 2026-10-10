// Unified light theme for in-page toasts.
// One vanilla CSS string shared by every toast shadow root so the five
// toast variants render as a single family. Light values only, system
// font stack, 0.2s motion with a reduced-motion collapse. Self-contained:
// no dependency on page stylesheets or remote resources.

export const TOAST_CSS = `
  :host {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: #FFFFFF;
    color: #1F2124;
    border: 1px solid #E0E2E5;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.4;
    box-shadow: 0 0 0 1px #E0E2E5, 0 12px 32px rgba(31, 33, 36, 0.14);
    max-width: 360px;
    box-sizing: border-box;
    animation: toastIn 0.2s cubic-bezier(0.23, 1, 0.32, 1);
  }
  .toast.hiding {
    animation: toastOut 0.2s ease-in forwards;
  }
  .toast--top {
    align-items: flex-start;
  }
  .msg {
    flex: 1;
    min-width: 0;
  }
  .msg strong {
    font-weight: 600;
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
    color: #62656B;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  .action-btn,
  .enable-btn {
    background: #199A4D;
    color: #FFFFFF;
    border: 1px solid #199A4D;
    border-radius: 8px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    flex-shrink: 0;
    transition: filter 0.2s;
  }
  .action-btn:hover,
  .enable-btn:hover {
    filter: brightness(0.92);
  }
  .dismiss {
    background: none;
    border: none;
    color: #9A9DA3;
    cursor: pointer;
    font-size: 16px;
    padding: 0 0 0 4px;
    line-height: 1;
    flex-shrink: 0;
    transition: color 0.2s;
  }
  .dismiss:hover {
    color: #1F2124;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #0285FF;
    flex-shrink: 0;
    animation: toastPulse 1.2s ease-out infinite;
  }
  @keyframes toastIn {
    from { opacity: 0; transform: translateX(20px); }
    to { opacity: 1; transform: translateX(0); }
  }
  @keyframes toastOut {
    from { opacity: 1; transform: translateX(0); }
    to { opacity: 0; transform: translateX(20px); }
  }
  @keyframes toastPulse {
    0% { box-shadow: 0 0 0 0 rgba(2, 133, 255, 0.5); }
    70% { box-shadow: 0 0 0 8px rgba(2, 133, 255, 0); }
    100% { box-shadow: 0 0 0 0 rgba(2, 133, 255, 0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation-duration: 0.01ms;
    }
    .dot {
      animation: none;
    }
    .action-btn,
    .enable-btn,
    .dismiss {
      transition-duration: 0.01ms;
    }
  }
`;
