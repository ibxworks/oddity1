import { sendToTab } from '../shared/messaging.js';

const MENU_ID = 'oddity-add-annotation';

/**
 * Register the "Add Oddity Annotation" context menu item.
 * Call from chrome.runtime.onInstalled.
 */
export function setupContextMenu(): void {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Add Oddity Annotation',
    contexts: ['selection'],
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID) return;
    if (!tab?.id || !info.selectionText) return;

    sendToTab(tab.id, {
      action: 'saveManualAnnotation',
      payload: {
        url: tab.url ?? '',
        contentHash: '',
        annotation: {
          id: crypto.randomUUID(),
          mode: 'overview',
          type: 'user_written',
          anchor: {
            type: 'TextQuoteSelector',
            exact: info.selectionText,
          },
          content: {
            note: 'Manual annotation',
          },
        },
      },
    });
  });
}
