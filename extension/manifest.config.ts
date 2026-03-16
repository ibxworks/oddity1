import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Oddity",
  version: "0.1.0",
  description: "AI-powered in-place text annotations for any page",
  permissions: ["activeTab", "storage", "contextMenus", "scripting", "alarms"],
  host_permissions: ["<all_urls>"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
  action: {
    default_popup: "src/popup/index.html",
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  web_accessible_resources: [
    {
      resources: ["assets/logo-terry.svg", "Terry.png", "Jerry.png", "Sally.png"],
      matches: ["<all_urls>"],
    },
  ],
});
