// vite.config.ts
import { crx } from "file:///Users/junseok/Desktop/oddity1_frontend/node_modules/@crxjs/vite-plugin/dist/index.mjs";
import { defineConfig } from "file:///Users/junseok/Desktop/oddity1_frontend/node_modules/vite/dist/node/index.js";

// manifest.config.ts
import { defineManifest } from "file:///Users/junseok/Desktop/oddity1_frontend/node_modules/@crxjs/vite-plugin/dist/index.mjs";
var manifest_config_default = defineManifest({
  manifest_version: 3,
  name: "Oddity1",
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
      resources: [
        "assets/logo-terry.svg",
        "Terry.png",
        "Jerry.png",
        "Sally.png",
      ],
      matches: ["<all_urls>"],
    },
  ],
});

// vite.config.ts
var vite_config_default = defineConfig({
  plugins: [crx({ manifest: manifest_config_default })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
export { vite_config_default as default };
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiLCAibWFuaWZlc3QuY29uZmlnLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL2p1bnNlb2svRGVza3RvcC9vZGRpdHkxX2Zyb250ZW5kL2V4dGVuc2lvblwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL2p1bnNlb2svRGVza3RvcC9vZGRpdHkxX2Zyb250ZW5kL2V4dGVuc2lvbi92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvanVuc2Vvay9EZXNrdG9wL29kZGl0eTFfZnJvbnRlbmQvZXh0ZW5zaW9uL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XG5pbXBvcnQgeyBjcnggfSBmcm9tICdAY3J4anMvdml0ZS1wbHVnaW4nO1xuaW1wb3J0IG1hbmlmZXN0IGZyb20gJy4vbWFuaWZlc3QuY29uZmlnJztcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgcGx1Z2luczogW2NyeCh7IG1hbmlmZXN0IH0pXSxcbiAgYnVpbGQ6IHtcbiAgICBvdXREaXI6ICdkaXN0JyxcbiAgICBlbXB0eU91dERpcjogdHJ1ZSxcbiAgfSxcbn0pO1xuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvanVuc2Vvay9EZXNrdG9wL29kZGl0eTFfZnJvbnRlbmQvZXh0ZW5zaW9uXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvanVuc2Vvay9EZXNrdG9wL29kZGl0eTFfZnJvbnRlbmQvZXh0ZW5zaW9uL21hbmlmZXN0LmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvanVuc2Vvay9EZXNrdG9wL29kZGl0eTFfZnJvbnRlbmQvZXh0ZW5zaW9uL21hbmlmZXN0LmNvbmZpZy50c1wiO2ltcG9ydCB7IGRlZmluZU1hbmlmZXN0IH0gZnJvbSBcIkBjcnhqcy92aXRlLXBsdWdpblwiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVNYW5pZmVzdCh7XG4gIG1hbmlmZXN0X3ZlcnNpb246IDMsXG4gIG5hbWU6IFwiT2RkaXR5XCIsXG4gIHZlcnNpb246IFwiMC4xLjBcIixcbiAgZGVzY3JpcHRpb246IFwiQUktcG93ZXJlZCBpbi1wbGFjZSB0ZXh0IGFubm90YXRpb25zIGZvciBhbnkgcGFnZVwiLFxuICBwZXJtaXNzaW9uczogW1wiYWN0aXZlVGFiXCIsIFwic3RvcmFnZVwiLCBcImNvbnRleHRNZW51c1wiLCBcInNjcmlwdGluZ1wiLCBcImFsYXJtc1wiXSxcbiAgaG9zdF9wZXJtaXNzaW9uczogW1wiPGFsbF91cmxzPlwiXSxcbiAgYmFja2dyb3VuZDoge1xuICAgIHNlcnZpY2Vfd29ya2VyOiBcInNyYy9iYWNrZ3JvdW5kL2luZGV4LnRzXCIsXG4gICAgdHlwZTogXCJtb2R1bGVcIixcbiAgfSxcbiAgY29udGVudF9zY3JpcHRzOiBbXG4gICAge1xuICAgICAgbWF0Y2hlczogW1wiPGFsbF91cmxzPlwiXSxcbiAgICAgIGpzOiBbXCJzcmMvY29udGVudC9pbmRleC50c1wiXSxcbiAgICAgIHJ1bl9hdDogXCJkb2N1bWVudF9pZGxlXCIsXG4gICAgfSxcbiAgXSxcbiAgYWN0aW9uOiB7XG4gICAgZGVmYXVsdF9wb3B1cDogXCJzcmMvcG9wdXAvaW5kZXguaHRtbFwiLFxuICB9LFxuICBvcHRpb25zX3VpOiB7XG4gICAgcGFnZTogXCJzcmMvb3B0aW9ucy9pbmRleC5odG1sXCIsXG4gICAgb3Blbl9pbl90YWI6IHRydWUsXG4gIH0sXG4gIHdlYl9hY2Nlc3NpYmxlX3Jlc291cmNlczogW1xuICAgIHtcbiAgICAgIHJlc291cmNlczogW1wiYXNzZXRzL2xvZ28tdGVycnkuc3ZnXCIsIFwiVGVycnkucG5nXCIsIFwiSmVycnkucG5nXCIsIFwiU2FsbHkucG5nXCJdLFxuICAgICAgbWF0Y2hlczogW1wiPGFsbF91cmxzPlwiXSxcbiAgICB9LFxuICBdLFxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQXFVLFNBQVMsb0JBQW9CO0FBQ2xXLFNBQVMsV0FBVzs7O0FDRHlULFNBQVMsc0JBQXNCO0FBRTVXLElBQU8sMEJBQVEsZUFBZTtBQUFBLEVBQzVCLGtCQUFrQjtBQUFBLEVBQ2xCLE1BQU07QUFBQSxFQUNOLFNBQVM7QUFBQSxFQUNULGFBQWE7QUFBQSxFQUNiLGFBQWEsQ0FBQyxhQUFhLFdBQVcsZ0JBQWdCLGFBQWEsUUFBUTtBQUFBLEVBQzNFLGtCQUFrQixDQUFDLFlBQVk7QUFBQSxFQUMvQixZQUFZO0FBQUEsSUFDVixnQkFBZ0I7QUFBQSxJQUNoQixNQUFNO0FBQUEsRUFDUjtBQUFBLEVBQ0EsaUJBQWlCO0FBQUEsSUFDZjtBQUFBLE1BQ0UsU0FBUyxDQUFDLFlBQVk7QUFBQSxNQUN0QixJQUFJLENBQUMsc0JBQXNCO0FBQUEsTUFDM0IsUUFBUTtBQUFBLElBQ1Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxRQUFRO0FBQUEsSUFDTixlQUFlO0FBQUEsRUFDakI7QUFBQSxFQUNBLFlBQVk7QUFBQSxJQUNWLE1BQU07QUFBQSxJQUNOLGFBQWE7QUFBQSxFQUNmO0FBQUEsRUFDQSwwQkFBMEI7QUFBQSxJQUN4QjtBQUFBLE1BQ0UsV0FBVyxDQUFDLHlCQUF5QixhQUFhLGFBQWEsV0FBVztBQUFBLE1BQzFFLFNBQVMsQ0FBQyxZQUFZO0FBQUEsSUFDeEI7QUFBQSxFQUNGO0FBQ0YsQ0FBQzs7O0FEN0JELElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVMsQ0FBQyxJQUFJLEVBQUUsa0NBQVMsQ0FBQyxDQUFDO0FBQUEsRUFDM0IsT0FBTztBQUFBLElBQ0wsUUFBUTtBQUFBLElBQ1IsYUFBYTtBQUFBLEVBQ2Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
