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

  // 4. Text color check — most reliable when backgrounds are transparent.
  //    Light-colored text (high luminance) reliably indicates a dark theme,
  //    regardless of how dark mode is implemented (CSS vars, media queries,
  //    browser forced dark mode, extensions, etc.)
  if (document.body) {
    const textLum = luminance(getComputedStyle(document.body).color);
    if (textLum >= 0 && textLum > 0.5) return 'dark';

    // Also sample a <p> or heading for text color — body color may be inherited
    const prose = document.querySelector('p, h1, h2, h3, article, main');
    if (prose) {
      const proseLum = luminance(getComputedStyle(prose).color);
      if (proseLum >= 0 && proseLum > 0.5) return 'dark';
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
