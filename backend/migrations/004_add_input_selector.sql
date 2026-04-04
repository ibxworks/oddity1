-- 004_add_input_selector.sql
-- Adds input_selector column to site_adapters for chatbot auto-paste support.
-- When non-null, the extension treats the page as a chatbot and uses this
-- CSS selector to find the input element for pasting generated prompts.

ALTER TABLE site_adapters
  ADD COLUMN IF NOT EXISTS input_selector text DEFAULT NULL;

-- Populate for known chatbot adapters.
-- These selectors target the main text input / contenteditable element.
UPDATE site_adapters SET input_selector = '#prompt-textarea'
  WHERE hostname_pattern = 'chatgpt.com';

UPDATE site_adapters SET input_selector = 'div.ProseMirror[contenteditable]'
  WHERE hostname_pattern = 'claude.ai';

UPDATE site_adapters SET input_selector = 'div.ql-editor[contenteditable]'
  WHERE hostname_pattern = 'gemini.google.com';
