import type {
  AnnotationType,
  Intensity,
  UserPreferences,
} from '@oddity/shared';
import { ALL_ANNOTATION_TYPES } from '@oddity/shared';
import { sendMessage } from '../shared/messaging.js';

// ─── DOM refs ───

const intensityGroup = document.getElementById('intensity-group')!;
const typeCheckboxes = document.getElementById('type-checkboxes')!;
const siteList = document.getElementById('site-list')!;
const siteEmpty = document.getElementById('site-empty')!;
const siteInput = document.getElementById('site-input') as HTMLInputElement;
const addSiteBtn = document.getElementById('add-site-btn')!;
const clearCacheBtn = document.getElementById('clear-cache-btn')!;
const exportAllBtn = document.getElementById('export-all-btn')!;
const authDetail = document.getElementById('auth-detail')!;
const authTier = document.getElementById('auth-tier')!;
const logoutBtn = document.getElementById('logout-btn')!;
const toast = document.getElementById('toast')!;

// ─── State ───

let currentPrefs: Required<UserPreferences> = {
  enabled: true,
  intensity: 'jerry',
  visible_types: [...ALL_ANNOTATION_TYPES],
  disabled_sites: [],
  annotation_font: 'default',
  annotation_font_size: 'default',
};

// ─── Init ───

async function init(): Promise<void> {
  // Load preferences
  const stored = await chrome.storage.local.get('preferences');
  if (stored['preferences']) {
    const prefs = stored['preferences'] as UserPreferences;
    currentPrefs = {
      enabled: prefs.enabled ?? true,
      intensity: prefs.intensity ?? 'jerry',
      visible_types: prefs.visible_types ?? [...ALL_ANNOTATION_TYPES],
      disabled_sites: prefs.disabled_sites ?? [],
      annotation_font: prefs.annotation_font ?? 'default',
      annotation_font_size: prefs.annotation_font_size ?? 'default',
    };
  }

  applyPrefsToUI();
  loadAuthStatus();
}

function applyPrefsToUI(): void {
  // Intensity buttons
  for (const btn of intensityGroup.querySelectorAll<HTMLButtonElement>(
    '.radio-btn',
  )) {
    btn.classList.toggle(
      'active',
      btn.dataset['intensity'] === currentPrefs.intensity,
    );
  }

  // Type checkboxes
  for (const cb of typeCheckboxes.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  )) {
    const t = cb.dataset['type'] as AnnotationType;
    cb.checked = currentPrefs.visible_types.includes(t);
  }

  // Disabled sites
  renderSiteList();
}

async function savePrefs(): Promise<void> {
  await chrome.storage.local.set({ preferences: currentPrefs });
  showToast('Settings saved');
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
      authDetail.innerHTML = `<span class="auth-email">${escapeHtml(result.user.email)}</span>`;
      authTier.textContent = 'Free tier';
      logoutBtn.style.display = 'inline-flex';
    } else {
      authDetail.textContent = 'Not signed in';
      authTier.textContent = '';
      logoutBtn.style.display = 'none';
    }
  } catch {
    authDetail.textContent = 'Auth unavailable';
    authTier.textContent = '';
    logoutBtn.style.display = 'none';
  }
}

// ─── Site List ───

function renderSiteList(): void {
  siteList.innerHTML = '';
  const sites = currentPrefs.disabled_sites;

  if (sites.length === 0) {
    siteEmpty.style.display = 'block';
    return;
  }

  siteEmpty.style.display = 'none';

  for (const site of sites) {
    const li = document.createElement('li');
    li.textContent = site;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'site-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      currentPrefs.disabled_sites = currentPrefs.disabled_sites.filter(
        (s) => s !== site,
      );
      renderSiteList();
      savePrefs();
    });

    li.appendChild(removeBtn);
    siteList.appendChild(li);
  }
}

// ─── Event Handlers ───

// Intensity buttons
intensityGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.radio-btn');
  if (!btn) return;

  const intensity = btn.dataset['intensity'] as Intensity | undefined;
  if (!intensity) return;

  currentPrefs.intensity = intensity;

  for (const b of intensityGroup.querySelectorAll<HTMLButtonElement>(
    '.radio-btn',
  )) {
    b.classList.toggle('active', b === btn);
  }

  savePrefs();
});

// Type checkboxes
typeCheckboxes.addEventListener('change', (e) => {
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

// Add disabled site
addSiteBtn.addEventListener('click', () => {
  const site = siteInput.value.trim().toLowerCase();
  if (!site) return;

  // Basic domain validation
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(site)) {
    showToast('Enter a valid domain (e.g. example.com)');
    return;
  }

  if (currentPrefs.disabled_sites.includes(site)) {
    showToast('Site already disabled');
    return;
  }

  currentPrefs.disabled_sites.push(site);
  siteInput.value = '';
  renderSiteList();
  savePrefs();
});

// Enter key on site input
siteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addSiteBtn.click();
  }
});

// Clear cache
clearCacheBtn.addEventListener('click', async () => {
  // Remove all annotation cache keys from storage
  const allKeys = await chrome.storage.local.get(null);
  const annotationKeys = Object.keys(allKeys).filter((k) =>
    k.startsWith('annotations:'),
  );
  if (annotationKeys.length > 0) {
    await chrome.storage.local.remove(annotationKeys);
  }
  showToast(`Cache cleared (${annotationKeys.length} entries)`);
});

// Export all data
exportAllBtn.addEventListener('click', async () => {
  const allData = await chrome.storage.local.get(null);
  const json = JSON.stringify(allData, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `oddity-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Data exported');
});

// Logout
logoutBtn.addEventListener('click', async () => {
  // Clear auth data from storage
  await chrome.storage.local.remove(['session', 'auth_token']);
  authDetail.textContent = 'Not signed in';
  authTier.textContent = '';
  logoutBtn.style.display = 'none';
  showToast('Logged out');
});

// ─── Helpers ───

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add('visible');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
  }, 2000);
}

// ─── Start ───

init();
