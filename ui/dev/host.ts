/**
 * A stand-in for the dashboard host, for looking at the plugin in a browser.
 *
 * This is deliberately not a mock of the UI: it runs the real plugin build in a
 * real iframe and speaks the real bridge protocol at it, including the frame
 * model production actually uses. The pane fills the console's main region and
 * the iframe fills the pane, so the frame IS the plugin's viewport: the plugin
 * document scrolls inside it, there is one scrollbar, and `100vh`,
 * `position: fixed` and `position: sticky` resolve against the visible window.
 *
 * The host accepts `lattice.plugin.resize` for protocol compatibility and does
 * not wire it to layout, exactly as PluginFrameHost.vue does. The reported
 * number is printed in the bar so a plugin that still tries to drive its own
 * frame height is visible here rather than only in production.
 *
 * Ported from lattice-plugin-vpn-core/ui/dev/host.ts. Query parameters:
 * `scenario`, `width`, `frame` (the pane height), `theme`, `zoom`, and
 * `plugin` (forwarded to the plugin document's own query string, so
 * `plugin=lens%3Dgroups` opens a lens by URL).
 */

import { handlers, INTERFACES, SCENARIOS, type Scenario } from "./fixtures";

const PLUGIN_ID = "latticenet.netguard";
const ROUTE = "firewall";
const NONCE = "dev-harness-nonce-000000";

/* The Claude palette the dashboard ships as its default, so the plugin is
 * reviewed in the colours production sends it. Light and dark are the values
 * in DESIGN-PROGRAM-2026-09.md section 1.x, rounded to hex. */
const DARK: Record<string, string> = {
  "--background": "#181513", "--foreground": "#f1ece6", "--card": "#221e1b",
  "--border": "#ffffff1a", "--muted": "#2a2522", "--muted-foreground": "#a39a91",
  "--primary": "#ea906d", "--primary-foreground": "#231512",
  "--destructive": "#f2777a", "--ring": "#ea906d",
};
const LIGHT: Record<string, string> = {
  "--background": "#fbfaf7", "--foreground": "#241e1a", "--card": "#fefdfb",
  "--border": "#e2ddd3", "--muted": "#f1eee8", "--muted-foreground": "#6b625b",
  "--primary": "#bd5833", "--primary-foreground": "#ffffff",
  "--destructive": "#c43838", "--ring": "#bd5833",
};

const params = new URLSearchParams(location.search);
let frameEpoch = 0;
let scenario = (SCENARIOS.includes(params.get("scenario") as Scenario) ? params.get("scenario") : "fleet") as Scenario;
/* `zoom` magnifies the whole harness for screenshot review on a very wide
 * display, where a 1440px frame is a postage stamp. Harness only. */
const zoom = params.get("zoom");
if (zoom) document.documentElement.style.zoom = zoom;
const pluginQuery = params.get("plugin") ?? "";
let dark = params.get("theme") !== "light";
let width = params.get("width") ?? "1440";
/** The height of the console's main region. The frame gets exactly this. */
let windowHeight = Number(params.get("frame") ?? 760);

const shell = document.createElement("div");
shell.className = "harness";
shell.innerHTML = `
  <div class="bar">
    <strong>netguard dev harness</strong>
    <label>data <select id="scenario">${SCENARIOS.map((value) => `<option${value === scenario ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>width <select id="width">${["1440", "1024", "375"].map((value) => `<option${value === width ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <button id="theme" type="button">${dark ? "light" : "dark"}</button>
    <span id="reported"></span>
  </div>
  <div class="viewport" id="viewport">
    <div class="frame-wrap" id="wrap"><iframe id="frame" title="plugin"></iframe></div>
  </div>`;
document.body.append(shell);

const frame = document.getElementById("frame") as HTMLIFrameElement;
const wrap = document.getElementById("wrap") as HTMLDivElement;
const viewport = document.getElementById("viewport") as HTMLDivElement;
const reported = document.getElementById("reported") as HTMLSpanElement;

function tokens(): Record<string, string> {
  return dark ? DARK : LIGHT;
}

function applyChrome(): void {
  wrap.style.width = `${width}px`;
  viewport.style.height = `${windowHeight}px`;
  reported.textContent = `frame ${width} x ${windowHeight}`;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  (document.getElementById("theme") as HTMLButtonElement).textContent = dark ? "light" : "dark";
}

function reload(): void {
  const query = new URLSearchParams({ scenario, theme: dark ? "dark" : "light", width, frame: String(windowHeight) });
  if (pluginQuery) query.set("plugin", pluginQuery);
  history.replaceState(null, "", `?${query}`);
  applyChrome();
  // The epoch matters: assigning an identical src, fragment and all, is a
  // same-document navigation, so the frame would keep running and the data
  // the operator just picked would never reach a fresh plugin.
  frameEpoch += 1;
  frame.src = `/index.html?frame=${frameEpoch}${pluginQuery ? `&${pluginQuery}` : ""}#lattice_nonce=${NONCE}&host_origin=${encodeURIComponent(location.origin)}`;
}

function post(message: Record<string, unknown>): void {
  frame.contentWindow?.postMessage({ nonce: NONCE, ...message }, location.origin);
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
  const data = event.data as Record<string, any>;
  if (!data || data.nonce !== NONCE) return;
  switch (data.type) {
    case "lattice.plugin.ready":
      post({
        type: "lattice.host.init", version: "1", pluginId: PLUGIN_ID,
        pluginVersion: "0.0.0-dev", pluginRoute: ROUTE, locale: "en",
        colorScheme: dark ? "dark" : "light", designTokens: tokens(), interfaces: INTERFACES[scenario],
      });
      return;
    case "lattice.plugin.resize": {
      // Accepted and ignored, like the real host. The frame height never
      // depends on anything the plugin says. Reported only so a plugin still
      // trying to drive its own frame is visible.
      const height = Math.max(120, Number(data.height) || 0);
      reported.textContent = `plugin reported ${height}px (ignored; frame is ${windowHeight}px)`;
      return;
    }
    case "lattice.plugin.call": {
      const table = handlers(scenario);
      const key = `${String(data.service).split("/").pop()}/${data.method}`;
      const handler = table[key];
      // Latency, so loading states are visible rather than theoretical. The
      // per-node snapshot reads are quick, like the real ones.
      const delay = data.method === "reality" && data.payload?.node_id ? 60 : 320;
      window.setTimeout(() => {
        if (scenario === "failing") {
          post({ type: "lattice.host.error", id: data.id, message: `upstream refused ${key}: 503 service unavailable` });
          return;
        }
        if (!handler) {
          post({ type: "lattice.host.error", id: data.id, message: `the dev harness has no answer for ${key}` });
          return;
        }
        try {
          post({ type: "lattice.host.result", id: data.id, result: handler((data.payload ?? {}) as any) });
        } catch (cause) {
          post({ type: "lattice.host.error", id: data.id, message: cause instanceof Error ? cause.message : String(cause) });
        }
      }, delay);
    }
  }
});

document.getElementById("scenario")!.addEventListener("change", (event) => {
  scenario = (event.target as HTMLSelectElement).value as Scenario;
  reload();
});
document.getElementById("width")!.addEventListener("change", (event) => {
  width = (event.target as HTMLSelectElement).value;
  reload();
});
document.getElementById("theme")!.addEventListener("click", () => {
  dark = !dark;
  applyChrome();
  post({ type: "lattice.host.theme", colorScheme: dark ? "dark" : "light", designTokens: tokens() });
});

reload();
