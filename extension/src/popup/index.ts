import type {
  AnnotationType,
  Intensity,
  UserPreferences,
  Annotation,
} from '@oddity/shared';
import { ALL_ANNOTATION_TYPES } from '@oddity/shared';
import { sendMessage } from '../shared/messaging.js';
import { exportAsMarkdown, downloadMarkdown } from './export.js';

// ─── DOM refs ───

const enabledToggle = document.getElementById(
  'enabled-toggle',
) as HTMLInputElement;
const toggleLabel = document.getElementById('toggle-label')!;
const intensityGroup = document.getElementById('intensity-group')!;
const typeFilters = document.getElementById('type-filters')!;
const exportBtn = document.getElementById('export-btn')!;
const authStatus = document.getElementById('auth-status')!;
const openOptions = document.getElementById('open-options')!;

// ─── State ───

let currentPrefs: Required<UserPreferences> = {
  enabled: true,
  intensity: 'default',
  visible_types: [...ALL_ANNOTATION_TYPES],
  disabled_sites: [],
};

// ─── Init ───

async function init(): Promise<void> {
  // Load preferences from storage
  const stored = await chrome.storage.local.get('preferences');
  if (stored['preferences']) {
    const prefs = stored['preferences'] as UserPreferences;
    currentPrefs = {
      enabled: prefs.enabled ?? true,
      intensity: prefs.intensity ?? 'default',
      visible_types: prefs.visible_types ?? [...ALL_ANNOTATION_TYPES],
      disabled_sites: prefs.disabled_sites ?? [],
    };
  }

  // Apply state to UI
  applyPrefsToUI();

  // Fetch auth status
  loadAuthStatus();

  // Fetch annotation stats from current tab
  loadAnnotationStats();
}

function applyPrefsToUI(): void {
  // Toggle
  enabledToggle.checked = currentPrefs.enabled;
  toggleLabel.textContent = currentPrefs.enabled ? 'On' : 'Off';

  // Intensity buttons
  for (const btn of intensityGroup.querySelectorAll<HTMLButtonElement>(
    '.intensity-btn',
  )) {
    btn.classList.toggle(
      'active',
      btn.dataset['intensity'] === currentPrefs.intensity,
    );
  }

  // Type filter checkboxes
  for (const cb of typeFilters.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  )) {
    const t = cb.dataset['type'] as AnnotationType;
    cb.checked = currentPrefs.visible_types.includes(t);
  }
}

async function savePrefs(): Promise<void> {
  await chrome.storage.local.set({ preferences: currentPrefs });
}

// ─── Auth ───

async function loadAuthStatus(): Promise<void> {
  try {
    const result = await sendMessage<{
      authenticated: boolean;
      user: { id: string; email: string } | null;
    }>({
      action: 'getAuthStatus',
      payload: {},
    });

    if (result.authenticated && result.user) {
      authStatus.innerHTML = `<span class="auth-email">${escapeHtml(result.user.email)}</span>`;
    } else {
      authStatus.textContent = 'Not signed in';
    }
  } catch {
    authStatus.textContent = 'Auth unavailable';
  }
}

// ─── Annotation Stats ───

async function loadAnnotationStats(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab.url) return;

    // Query storage for cached annotations for this URL
    const key = `annotations:${tab.url}`;
    const stored = await chrome.storage.local.get(key);
    const annotations: Annotation[] = stored[key] ?? [];

    // Count by type
    const counts: Record<AnnotationType, number> = {
      highlight: 0,
      underline: 0,
      question: 0,
      insight: 0,
      caveat: 0,
      vocabulary: 0,
    };

    for (const ann of annotations) {
      if (ann.type in counts) {
        counts[ann.type]++;
      }
    }

    for (const t of ALL_ANNOTATION_TYPES) {
      const el = document.getElementById(`stat-${t}`);
      if (el) el.textContent = String(counts[t]);
    }
  } catch {
    // Stats unavailable — leave at 0
  }
}

// ─── Event Handlers ───

// Toggle enabled/disabled
enabledToggle.addEventListener('change', () => {
  currentPrefs.enabled = enabledToggle.checked;
  toggleLabel.textContent = currentPrefs.enabled ? 'On' : 'Off';
  savePrefs();
});

// Intensity selection
intensityGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
    '.intensity-btn',
  );
  if (!btn) return;

  const intensity = btn.dataset['intensity'] as Intensity | undefined;
  if (!intensity) return;

  currentPrefs.intensity = intensity;

  for (const b of intensityGroup.querySelectorAll<HTMLButtonElement>(
    '.intensity-btn',
  )) {
    b.classList.toggle('active', b === btn);
  }

  savePrefs();
});

// Type filter checkboxes
typeFilters.addEventListener('change', (e) => {
  const cb = e.target as HTMLInputElement;
  const type = cb.dataset['type'] as AnnotationType | undefined;
  if (!type) return;

  if (cb.checked) {
    if (!currentPrefs.visible_types.includes(type)) {
      currentPrefs.visible_types.push(type);
    }
  } else {
    currentPrefs.visible_types = currentPrefs.visible_types.filter(
      (t) => t !== type,
    );
  }

  savePrefs();
});

// Export button
exportBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.url) return;

    const key = `annotations:${tab.url}`;
    const stored = await chrome.storage.local.get(key);
    const annotations: Annotation[] = stored[key] ?? [];

    const title = tab.title ?? 'Untitled Page';
    const md = exportAsMarkdown(annotations, title, tab.url);
    const safeName = title.replace(/[^a-zA-Z0-9 -]/g, '').substring(0, 50);
    downloadMarkdown(md, `${safeName}-oddity.md`);
  } catch {
    // Export failed silently
  }
});

// Open options page
openOptions.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ─── Helpers ───

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Start ───

init();
