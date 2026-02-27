type ThemeMode = 'light' | 'dark';
type ThemeChangeCallback = (mode: ThemeMode) => void;

let currentMode: ThemeMode = 'light';
let observer: MutationObserver | null = null;
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

function detectMode(): ThemeMode {
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const lum = luminance(getComputedStyle(el).backgroundColor);
    if (lum >= 0) return lum < 0.4 ? 'dark' : 'light';
  }
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
  }
}

export function offThemeChange(cb: ThemeChangeCallback): void {
  listeners = listeners.filter((l) => l !== cb);
  if (listeners.length === 0 && observer) {
    observer.disconnect();
    observer = null;
  }
}
