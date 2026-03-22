type ThemeMode = 'light' | 'dark';
type ThemeChangeCallback = (mode: ThemeMode) => void;

let currentMode: ThemeMode = 'light';
let observer: MutationObserver | null = null;
let mediaQuery: MediaQueryList | null = null;
let listeners: ThemeChangeCallback[] = [];
let throttleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Compute relative luminance from an rgb/rgba color string.
 * Returns -1 for transparent or unparseable values.
 */
function luminance(bgColor: string): number {
  const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return -1;

  // Check for fully transparent
  const alphaMatch = bgColor.match(/rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)/);
  if (alphaMatch && parseFloat(alphaMatch[1]!) === 0) return -1;

  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };

  const r = toLinear(parseInt(match[1]!, 10));
  const g = toLinear(parseInt(match[2]!, 10));
  const b = toLinear(parseInt(match[3]!, 10));

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function colorSchemeSignal(value: string | null | undefined): ThemeMode | null {
  if (!value || value === 'normal' || value === 'auto') return null;
  const hasDark = /dark/i.test(value);
  const hasLight = /light/i.test(value);
  if (hasDark && !hasLight) return 'dark';
  if (hasLight && !hasDark) return 'light';
  // "light dark" — site supports both; return null so we fall through to
  // the background luminance check, which reflects the actual rendered theme.
  if (hasDark && hasLight) return null;
  return null;
}

function detectMode(): ThemeMode {
  // 1. color-scheme CSS property on html/body — only trust unambiguous values
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const result = colorSchemeSignal(getComputedStyle(el).colorScheme);
    if (result) return result;
  }

  // 2. <meta name="color-scheme"> tag — only trust unambiguous values
  const metaCS = document.querySelector('meta[name="color-scheme"]')?.getAttribute('content');
  const metaResult = colorSchemeSignal(metaCS);
  if (metaResult) return metaResult;

  // 3. Background luminance on body/html
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const lum = luminance(getComputedStyle(el).backgroundColor);
    if (lum >= 0) return lum < 0.4 ? 'dark' : 'light';
  }

  // 4. Probe deeper: body/html may be transparent (e.g. arxiv).
  //    Walk down the first few children to find an element with a real background.
  if (document.body) {
    const candidates = document.body.querySelectorAll('main, article, [role="main"], body > div, body > main, body > section');
    for (const el of candidates) {
      const lum = luminance(getComputedStyle(el).backgroundColor);
      if (lum >= 0) return lum < 0.4 ? 'dark' : 'light';
    }
    // Also try the first few direct children of body
    for (let i = 0; i < Math.min(3, document.body.children.length); i++) {
      const el = document.body.children[i]!;
      if (el.id === 'oddity-margin-notes' || el.id === 'oddity-page-dim') continue;
      const lum = luminance(getComputedStyle(el).backgroundColor);
      if (lum >= 0) return lum < 0.4 ? 'dark' : 'light';
    }
  }

  // 5. Last resort: OS preference
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';

  return 'light';
}

function handlePossibleChange(): void {
  if (throttleTimer) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    const newMode = detectMode();
    if (newMode !== currentMode) {
      currentMode = newMode;
      for (const cb of listeners) cb(currentMode);
    }
  }, 500);
}

export function getThemeMode(): ThemeMode {
  currentMode = detectMode();
  return currentMode;
}

export function onThemeChange(cb: ThemeChangeCallback): void {
  listeners.push(cb);

  if (!observer) {
    observer = new MutationObserver(handlePossibleChange);
    const config: MutationObserverInit = {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'color-scheme'],
    };
    if (document.documentElement) observer.observe(document.documentElement, config);
    if (document.body) observer.observe(document.body, config);

    // Also listen for OS-level theme changes (covers color-scheme: light dark sites)
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', handlePossibleChange);
  }
}

export function offThemeChange(cb: ThemeChangeCallback): void {
  listeners = listeners.filter((l) => l !== cb);
  if (listeners.length === 0) {
    if (observer) { observer.disconnect(); observer = null; }
    if (mediaQuery) { mediaQuery.removeEventListener('change', handlePossibleChange); mediaQuery = null; }
  }
}
