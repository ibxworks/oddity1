import type {
  AnnotationType,
  DepthPersonality,
  UserPreferences,
  UserTier,
} from '@oddity/shared';
import { ALL_OVERVIEW_TYPES, ALL_DEPTH_TYPES, isBlockedDomain } from '@oddity/shared';
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
const authNotSignedIn = document.getElementById('auth-not-signed-in')!;
const authSignedIn = document.getElementById('auth-signed-in')!;
const authDisplayName = document.getElementById('auth-display-name')!;
const authEmailDisplay = document.getElementById('auth-email-display')!;
const authTierDisplay = document.getElementById('auth-tier-display')!;
const authAnnotationCount = document.getElementById('auth-annotation-count')!;
const changeNameBtn = document.getElementById('change-name-btn')!;
const nameEditRow = document.getElementById('name-edit-row')!;
const nameEditInput = document.getElementById('name-edit-input') as HTMLInputElement;
const nameSaveBtn = document.getElementById('name-save-btn')!;
const nameCancelBtn = document.getElementById('name-cancel-btn')!;
const upgradeBtn = document.getElementById('upgrade-btn')!;
const logoutBtn = document.getElementById('logout-btn')!;
const toast = document.getElementById('toast')!;

// ─── State ───

let currentPrefs: Required<UserPreferences> = {
  enabled: true,
  annotation_mode: 'overview',
  depth_personality: 'jerry',
  visible_types: [...ALL_OVERVIEW_TYPES, 'user_written'],
  enabled_sites: [],
  annotation_font: 'fraunces',
  annotation_font_size: 'default',
};

// ─── Init ───

async function init(): Promise<void> {
  // Load preferences
  const stored = await chrome.storage.local.get('preferences');
  if (stored['preferences']) {
    const prefs = stored['preferences'] as UserPreferences;
    // Migrate renamed personality: gary → sally
    let personality = prefs.depth_personality ?? 'jerry';
    if (personality === ('gary' as DepthPersonality)) personality = 'sally';
    currentPrefs = {
      enabled: prefs.enabled ?? true,
      annotation_mode: prefs.annotation_mode ?? 'overview',
      depth_personality: personality,
      visible_types: prefs.visible_types ?? [...ALL_OVERVIEW_TYPES, 'user_written'],
      enabled_sites: prefs.enabled_sites ?? [],
      annotation_font: prefs.annotation_font ?? 'fraunces',
      annotation_font_size: prefs.annotation_font_size ?? 'default',
    };
  }

  applyPrefsToUI();
  loadAuthStatus();

  // Fetch enabled sites from background (synced with Supabase)
  try {
    const result = await sendMessage<{ sites: string[] }>({
      action: 'getEnabledSites',
      payload: {},
    });
    if (result?.sites) {
      currentPrefs.enabled_sites = result.sites;
      renderSiteList();
    }
  } catch {
    // Use locally stored list
  }
}

function applyPrefsToUI(): void {
  // Personality buttons
  for (const btn of intensityGroup.querySelectorAll<HTMLButtonElement>(
    '.radio-btn',
  )) {
    btn.classList.toggle(
      'active',
      btn.dataset['intensity'] === currentPrefs.depth_personality,
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
      user: {
        id: string;
        email: string;
        display_name: string | null;
        tier: UserTier;
        annotation_count?: number;
      } | null;
    }>({
      action: 'getAuthStatus',
      payload: {},
    });

    if (result.authenticated && result.user) {
      authNotSignedIn.style.display = 'none';
      authSignedIn.style.display = '';
      authDisplayName.textContent = result.user.display_name || result.user.email.split('@')[0] || result.user.email;
      authEmailDisplay.textContent = result.user.email;
      authTierDisplay.textContent = result.user.tier === 'pro' ? 'Pro Plan' : 'Free Plan';
      authAnnotationCount.textContent = String(result.user.annotation_count ?? 0);
      upgradeBtn.style.display = result.user.tier === 'pro' ? 'none' : 'inline-flex';
    } else {
      authNotSignedIn.style.display = '';
      authSignedIn.style.display = 'none';
    }
  } catch {
    authNotSignedIn.style.display = '';
    authSignedIn.style.display = 'none';
  }
}

// ─── Site List ───

function renderSiteList(): void {
  while (siteList.firstChild) siteList.removeChild(siteList.firstChild);
  const sites = currentPrefs.enabled_sites;

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
    removeBtn.addEventListener('click', async () => {
      try {
        const result = await sendMessage<{ sites: string[] }>({
          action: 'removeEnabledSite',
          payload: { domain: site },
        });
        if (result?.sites) {
          currentPrefs.enabled_sites = result.sites;
        } else {
          currentPrefs.enabled_sites = currentPrefs.enabled_sites.filter(
            (s) => s !== site,
          );
        }
      } catch {
        currentPrefs.enabled_sites = currentPrefs.enabled_sites.filter(
          (s) => s !== site,
        );
      }
      renderSiteList();
      showToast('Site removed');
    });

    li.appendChild(removeBtn);
    siteList.appendChild(li);
  }
}

// ─── Event Handlers ───

// Personality buttons
intensityGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.radio-btn');
  if (!btn) return;

  const personality = btn.dataset['intensity'] as DepthPersonality | undefined;
  if (!personality) return;

  currentPrefs.depth_personality = personality;

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

// Add enabled site
addSiteBtn.addEventListener('click', async () => {
  const site = siteInput.value.trim().toLowerCase();
  if (!site) return;

  // Basic domain validation
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(site)) {
    showToast('Enter a valid domain (e.g. example.com)');
    return;
  }

  if (currentPrefs.enabled_sites.includes(site)) {
    showToast('Site already enabled');
    return;
  }

  if (isBlockedDomain(site)) {
    showToast('Cannot enable — annotations are built into the dashboard');
    return;
  }

  try {
    const result = await sendMessage<{ sites: string[] }>({
      action: 'addEnabledSite',
      payload: { domain: site },
    });
    if (result?.sites) {
      currentPrefs.enabled_sites = result.sites;
    } else {
      currentPrefs.enabled_sites.push(site);
    }
  } catch {
    currentPrefs.enabled_sites.push(site);
  }
  siteInput.value = '';
  renderSiteList();
  showToast('Site added');
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
  try {
    await sendMessage({ action: 'signOut', payload: {} });
  } catch {
    // Sign out failed; still show not-signed-in UI
  }
  authNotSignedIn.style.display = '';
  authSignedIn.style.display = 'none';
  showToast('Logged out');
});

// Change name
changeNameBtn.addEventListener('click', () => {
  nameEditInput.value = authDisplayName.textContent ?? '';
  nameEditRow.style.display = '';
  changeNameBtn.style.display = 'none';
});

nameCancelBtn.addEventListener('click', () => {
  nameEditRow.style.display = 'none';
  changeNameBtn.style.display = '';
});

nameSaveBtn.addEventListener('click', async () => {
  const newName = nameEditInput.value.trim();
  if (!newName) return;

  nameSaveBtn.textContent = 'Saving...';
  nameSaveBtn.setAttribute('disabled', '');
  try {
    await sendMessage({ action: 'updateProfile', payload: { display_name: newName } });
    authDisplayName.textContent = newName;
    nameEditRow.style.display = 'none';
    changeNameBtn.style.display = '';
    showToast('Name updated');
  } catch {
    showToast('Failed to update name');
  } finally {
    nameSaveBtn.textContent = 'Save';
    nameSaveBtn.removeAttribute('disabled');
  }
});

// Upgrade to Pro
upgradeBtn.addEventListener('click', () => {
  window.open('https://oddity1.com/pricing', '_blank');
});

// ─── Helpers ───

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
