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

// Auth form refs
const authForm = document.getElementById('auth-form')!;
const authFormTitle = document.getElementById('auth-form-title')!;
const authError = document.getElementById('auth-error')!;
const authSuccess = document.getElementById('auth-success')!;
const authEmail = document.getElementById('auth-email') as HTMLInputElement;
const authPassword = document.getElementById('auth-password') as HTMLInputElement;
const authSubmitBtn = document.getElementById('auth-submit-btn')!;
const authToggleLink = document.getElementById('auth-toggle-link')!;
const authToggleText = document.getElementById('auth-toggle-text')!;
const mainContent = document.getElementById('main-content')!;
const signOutBtn = document.getElementById('sign-out-btn')!;

let isSignUpMode = false;

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

function showAuthenticatedUI(email: string): void {
  authForm.style.display = 'none';
  mainContent.classList.remove('hidden');
  authStatus.innerHTML = `<span class="auth-email">${escapeHtml(email)}</span>`;
  signOutBtn.style.display = '';
}

function showUnauthenticatedUI(): void {
  authForm.style.display = '';
  mainContent.classList.add('hidden');
  authStatus.textContent = 'Not signed in';
  signOutBtn.style.display = 'none';
}

function showAuthError(msg: string): void {
  authError.textContent = msg;
  authError.style.display = 'block';
  authSuccess.style.display = 'none';
}

function hideAuthMessages(): void {
  authError.style.display = 'none';
  authSuccess.style.display = 'none';
}

function friendlyAuthError(error: string): string {
  if (error.includes('Invalid login credentials')) return 'Invalid email or password.';
  if (error.includes('Email not confirmed')) return 'Please confirm your email before signing in.';
  if (error.includes('User already registered')) return 'An account with this email already exists.';
  if (error.includes('Password should be at least')) return 'Password must be at least 6 characters.';
  if (error.includes('Unable to validate email')) return 'Please enter a valid email address.';
  return error;
}

async function refreshActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.reload(tab.id);
    }
  } catch {
    // Tab refresh failed; not critical
  }
}

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
      showAuthenticatedUI(result.user.email);
      chrome.action.setBadgeText({ text: "" });
    } else {
      showUnauthenticatedUI();
    }
  } catch {
    showUnauthenticatedUI();
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

// ─── Auth Event Handlers ───

// Toggle between sign-in and sign-up mode
authToggleLink.addEventListener('click', (e) => {
  e.preventDefault();
  isSignUpMode = !isSignUpMode;
  hideAuthMessages();

  if (isSignUpMode) {
    authFormTitle.textContent = 'Sign Up';
    authSubmitBtn.textContent = 'Sign Up';
    authToggleText.textContent = 'Already have an account? ';
    authToggleLink.textContent = 'Sign In';
  } else {
    authFormTitle.textContent = 'Sign In';
    authSubmitBtn.textContent = 'Sign In';
    authToggleText.textContent = "Don't have an account? ";
    authToggleLink.textContent = 'Sign Up';
  }
});

// Submit auth form
authSubmitBtn.addEventListener('click', async () => {
  const email = authEmail.value.trim();
  const password = authPassword.value;

  hideAuthMessages();

  if (!email || !password) {
    showAuthError('Please enter both email and password.');
    return;
  }

  authSubmitBtn.textContent = isSignUpMode ? 'Signing up...' : 'Signing in...';
  authSubmitBtn.setAttribute('disabled', '');

  try {
    if (isSignUpMode) {
      const result = await sendMessage<{
        success: boolean;
        needsConfirmation?: boolean;
        user: { id: string; email: string } | null;
        error?: string;
      }>({ action: 'signUp', payload: { email, password } });

      if (result.error) {
        showAuthError(friendlyAuthError(result.error));
        return;
      }

      if (result.needsConfirmation) {
        authSuccess.textContent = 'Check your email to confirm your account, then sign in.';
        authSuccess.style.display = 'block';
        authError.style.display = 'none';
        // Auto-switch to sign-in mode
        isSignUpMode = false;
        authFormTitle.textContent = 'Sign In';
        authSubmitBtn.textContent = 'Sign In';
        authToggleText.textContent = "Don't have an account? ";
        authToggleLink.textContent = 'Sign Up';
        return;
      }

      // Sign-up with auto-confirm (no email verification)
      if (result.user) {
        showAuthenticatedUI(result.user.email);
        chrome.action.setBadgeText({ text: "" });
        loadAnnotationStats();
        refreshActiveTab();
      }
    } else {
      const result = await sendMessage<{
        success: boolean;
        user: { id: string; email: string };
        error?: string;
      }>({ action: 'signIn', payload: { email, password } });

      if (result.error) {
        showAuthError(friendlyAuthError(result.error));
        return;
      }

      showAuthenticatedUI(result.user.email);
      chrome.action.setBadgeText({ text: "" });
      loadAnnotationStats();
      refreshActiveTab();
    }
  } catch (err) {
    showAuthError(friendlyAuthError(String(err)));
  } finally {
    authSubmitBtn.textContent = isSignUpMode ? 'Sign Up' : 'Sign In';
    authSubmitBtn.removeAttribute('disabled');
  }
});

// Enter key on password → submit
authPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    authSubmitBtn.click();
  }
});

// Enter key on email → focus password
authEmail.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    authPassword.focus();
  }
});

// Sign out
signOutBtn.addEventListener('click', async () => {
  try {
    await sendMessage({ action: 'signOut', payload: {} });
  } catch {
    // Sign out failed; still show unauthenticated UI
  }
  showUnauthenticatedUI();
  refreshActiveTab();
});

// ─── Helpers ───

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Start ───

init();
