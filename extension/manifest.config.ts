import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu0R4w03iRHUngelW+qzFxSau0IVLDv58I0SljcdJx39ZsnblFSUUPnEKfS0GsunGeqp4bHRmtT2DnutRWHtubqyvVyVLQhuX1hTVkpwEqiumgbnsOF1olJYhxyXSGpHfZoM5WxOrXwlcqM9qxvCKkNZJMs+6lKBXenIiExQHpiieQ48VPRnNQ8tyG6Y8WsjmqIJox/mxxhFrwkDdpqspSaUc85R5IRUgf8D5iG8Ja6RfgGfkNdcULmW7xm2MSpgqLs4Ug42VzqmqYvz8tloWEPi76Qr9VDSQUsA7MiMOM3C4fw0yyxjo5FTiktsPlKsYdcxCRDwm1c+hHPepqZcYawIDAQAB" as any,
  manifest_version: 3,
  name: "Oddity1",
  version: "0.1.2",
  description:
    "Annotation layer on top of your LLM conversation, amplifying your critical thinking.",
  icons: {
    16: "icons/terry-icon-16.png",
    32: "icons/terry-icon-32.png",
    48: "icons/terry-icon-48.png",
    128: "icons/terry-icon-128.png",
  },
  permissions: [
    "activeTab",
    "storage",
    "contextMenus",
    "scripting",
    "alarms",
    "identity",
    "tabs",
  ],
  host_permissions: ["<all_urls>"],
  oauth2: {
    client_id: "1068892621108-ma96bv3d62p65qh8iihh5jreok1vs83i.apps.googleusercontent.com",
    scopes: ["https://www.googleapis.com/auth/documents"],
  },
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
      16: "icons/terry-icon-16.png",
      32: "icons/terry-icon-32.png",
      48: "icons/terry-icon-48.png",
      128: "icons/terry-icon-128.png",
    },
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  web_accessible_resources: [
    {
      resources: [
        "Oddity1-Logo.png",
        "Terry.png",
        "Terry-Icon.png",
        "Jerry.png",
        "Sally.png",
        "Terry-svg.svg",
      ],
      matches: ["<all_urls>"],
    },
  ],
});
