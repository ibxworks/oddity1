/** Returns the canonical page URL for annotation storage.
 *  On converted PDF pages, returns the original PDF URL so
 *  annotations persist across reconversions (blob URLs change every time). */
export function getPageUrl(): string {
  const meta = document.querySelector('meta[name="oddity-source-pdf"]');
  return meta?.getAttribute("content") || window.location.href;
}
