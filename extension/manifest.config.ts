import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Oddity1",
  version: "0.1.0",
  description: "AI-powered in-place text annotations for any page",
  icons: {
    16: "Terry.png",
    32: "Terry.png",
    48: "Terry.png",
    128: "Terry.png",
  },
  permissions: [
    "activeTab",
    "storage",
    "contextMenus",
    "scripting",
    "alarms",
    "identity",
  ],
  host_permissions: ["<all_urls>"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/dom-guard.ts"],
      run_at: "document_start",
      world: "MAIN" as any,
    },
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
  action: {
    default_popup: "src/popup/index.html",
    default_icon: {
      16: "Terry.png",
      32: "Terry.png",
      48: "Terry.png",
      128: "Terry.png",
    },
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  web_accessible_resources: [
    {
      resources: ["Oddity1-Logo.png", "Terry.png", "Jerry.png", "Sally.png"],
      matches: ["<all_urls>"],
    },
  ],
});
