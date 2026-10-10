import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// arguments-box touches the `chrome` API at module load and uses
// window.matchMedia during init — stub both before importing the module.
function installChromeStub() {
  const prefs = { preferences: { enabled: true, enabled_sites: [] as string[] } };
  const storageGet = vi.fn((...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === "function") (last as (v: unknown) => void)(prefs);
    return Promise.resolve(prefs);
  });
  (globalThis as any).chrome = {
    storage: {
      onChanged: { addListener: vi.fn() },
      local: { get: storageGet, set: vi.fn(() => Promise.resolve()) },
    },
    runtime: {
      sendMessage: vi.fn((msg: { action: string }) => {
        if (msg?.action === "getAuthStatus") {
          return Promise.resolve({ authenticated: true });
        }
        return Promise.resolve({});
      }),
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
  };
}

function installMatchMediaStub() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

installChromeStub();
installMatchMediaStub();

const mod = await import("../renderer/arguments-box.js");

function shadow(): ShadowRoot {
  const root = mod.getShadowRootForTest();
  if (!root) throw new Error("shadow root not initialized");
  return root;
}

function closeButtons(): NodeListOf<Element> {
  return shadow().querySelectorAll(".args-not-enabled-close");
}

beforeEach(async () => {
  document.body.innerHTML = "";
  mod.initArgumentsBox();
  // Flush init's async auth/prefs chain so localAuthState is settled.
  await new Promise((r) => setTimeout(r, 0));
});

afterEach(() => {
  mod.destroyArgumentsBox();
  document.body.innerHTML = "";
  vi.clearAllTimers();
});

describe("not-enabled overlay dismiss button", () => {
  it("shows exactly one floating dismiss button with the overlay", () => {
    mod.showNotEnabledOverlayForTest();

    expect(shadow().querySelector(".args-not-enabled-overlay")).not.toBeNull();
    expect(closeButtons().length).toBe(1);
  });

  it("removes the floating dismiss button when 'Run once' is clicked", async () => {
    mod.showNotEnabledOverlayForTest();
    const runOnce = shadow().querySelector(
      ".args-not-enabled-btn-row .args-run-btn--secondary",
    ) as HTMLButtonElement;
    expect(runOnce).not.toBeNull();

    runOnce.click();
    await Promise.resolve();

    // Overlay and its floating X are gone; the mode toggle keeps its own X
    // and is shown again so the panel stays collapsible.
    expect(shadow().querySelector(".args-not-enabled-overlay")).toBeNull();
    expect(closeButtons().length).toBe(0);
    expect(shadow().querySelector(".mode-close-btn")).not.toBeNull();
    expect(
      (shadow().querySelector(".args-mode-toggle-wrapper") as HTMLElement).style.display,
    ).not.toBe("none");
  });

  it("removes the floating dismiss button when 'Always enable' is clicked", async () => {
    mod.showNotEnabledOverlayForTest();
    const alwaysEnable = shadow().querySelector(
      ".args-not-enabled-btn-row .args-run-btn:not(.args-run-btn--secondary)",
    ) as HTMLButtonElement;
    expect(alwaysEnable).not.toBeNull();

    alwaysEnable.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(shadow().querySelector(".args-not-enabled-overlay")).toBeNull();
    expect(closeButtons().length).toBe(0);
    expect(shadow().querySelector(".mode-close-btn")).not.toBeNull();
    expect(
      (shadow().querySelector(".args-mode-toggle-wrapper") as HTMLElement).style.display,
    ).not.toBe("none");
  });

  it("never stacks duplicate floating dismiss buttons on re-show", () => {
    // Simulate stale buttons leaked before the fix.
    const container = shadow().querySelector(".args-container")!;
    for (let i = 0; i < 2; i++) {
      const stale = document.createElement("button");
      stale.className = "args-not-enabled-close";
      container.appendChild(stale);
    }

    mod.showNotEnabledOverlayForTest();

    expect(closeButtons().length).toBe(1);
  });
});

describe("resize handle", () => {
  it("uses a thick corner mark concentric with the panel radius", () => {
    const css = shadow().querySelector("style")!.textContent!;
    // 12px mark at 5px inset with an 11px corner radius: the arc center lands
    // at (16,16), exactly concentric with the panel's 16px corner.
    const rule = css.match(/\.args-resize-handle::after \{[^}]*\}/)![0];
    expect(rule).toContain("width: 12px");
    expect(rule).toContain("height: 12px");
    expect(rule).toContain("border-top: 3px solid");
    expect(rule).toContain("border-left: 3px solid");
    expect(rule).toContain("border-radius: 11px 0 0 0");
  });

  it("uses a neutral gray mark in both themes", () => {
    const css = shadow().querySelector("style")!.textContent!;
    const base = css.match(/\.args-resize-handle::after \{[^}]*\}/)![0];
    expect(base).toContain("rgba(255, 255, 255, 0.5)");
    const light = css.match(
      /:host\(\[data-theme="light"\]\) \.args-resize-handle::after \{[^}]*\}/,
    )![0];
    expect(light).toContain("rgba(0, 0, 0, 0.35)");
  });
});
