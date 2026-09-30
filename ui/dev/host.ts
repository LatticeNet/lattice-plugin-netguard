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
 * It keeps the plugin's page state in its own address the way the console
 * does (design 22, "Plugin page state in the console address"): every query
 * key that is not one of the harness's own is page state, handed to the
 * plugin as `pageState` in init, and a `lattice.plugin.state` replaces those
 * keys with a history replace, without reloading the frame. So
 * `?view=nodes&open=metix-dmit-2` opens that node's panel, and a reload of
 * the harness lands where the plugin was. `oldhost=1` plays a console from
 * before the contract: no `pageState`, state messages ignored.
 *
 * Ported from lattice-plugin-vpn-core/ui/dev/host.ts. Harness parameters:
 * `scenario`, `width`, `frame` (the pane height), `theme`, `zoom`, `latency`
 * (hold every answer, to look at the loading state), `oldhost`, and `plugin`
 * (forwarded to the plugin document's own query, the old way to deep-link,
 * read only by a page whose host keeps no state).
 */

import { filterPageState, validPageState, type PageState } from "../src/pageState";
import { handlers, INTERFACES, SCENARIOS, type Scenario } from "./fixtures";

const PLUGIN_ID = "latticenet.netguard";
const ROUTE = "firewall";
const NONCE = "dev-harness-nonce-000000";

/* The console's default theme (teal on slate, lattice-dashboard
 * src/style/app.css and src/theme/palettes.ts, "teal" is DEFAULT_COLOR), so
 * colours are judged on what the plugin will actually receive. */
const DARK: Record<string, string> = {
  "--background": "oklch(0.155 0.012 240)", "--foreground": "oklch(0.97 0.004 240)", "--card": "oklch(0.195 0.014 240)",
  "--border": "oklch(1 0 0 / 9%)", "--muted": "oklch(0.255 0.014 240)", "--muted-foreground": "oklch(0.705 0.012 240)",
  "--primary": "oklch(0.81 0.13 180)", "--primary-foreground": "oklch(0.17 0.012 240)",
  "--destructive": "oklch(0.704 0.191 22.2)", "--ring": "oklch(0.7 0.12 182)",
  "--success": "oklch(0.706 0.15 156)", "--warning": "oklch(0.8 0.16 80)", "--info": "oklch(0.7 0.12 210)",
  "--success-text": "oklch(0.706 0.15 156)", "--warning-text": "oklch(0.8 0.16 80)", "--info-text": "oklch(0.7 0.12 210)",
};
const LIGHT: Record<string, string> = {
  "--background": "oklch(0.99 0.0015 280)", "--foreground": "oklch(0.21 0.02 281)", "--card": "oklch(1 0 0)",
  "--border": "oklch(0.91 0.006 281)", "--muted": "oklch(0.965 0.006 280)", "--muted-foreground": "oklch(0.524 0.022 281)",
  "--primary": "oklch(0.53 0.105 185)", "--primary-foreground": "oklch(0.985 0.01 180)",
  "--destructive": "oklch(0.583 0.231 27.5)", "--ring": "oklch(0.53 0.105 185)",
  "--success": "oklch(0.62 0.16 150)", "--warning": "oklch(0.72 0.16 73)", "--info": "oklch(0.6 0.14 240)",
  "--success-text": "oklch(0.5 0.14 150)", "--warning-text": "oklch(0.52 0.13 73)", "--info-text": "oklch(0.5 0.13 240)",
};

/* The harness's own keys. Everything else in the address is page state. */
const HARNESS_KEYS = new Set(["scenario", "theme", "width", "frame", "zoom", "latency", "plugin", "oldhost"]);

const params = new URLSearchParams(location.search);
let frameEpoch = 0;
let scenario = (SCENARIOS.includes(params.get("scenario") as Scenario) ? params.get("scenario") : "fleet") as Scenario;
/* `zoom` magnifies the whole harness for screenshot review on a very wide
 * display, where a 1440px frame is a postage stamp. Harness only. */
const zoom = params.get("zoom");
if (zoom) document.documentElement.style.zoom = zoom;
const pluginQuery = params.get("plugin") ?? "";
/* `oldhost=1` answers like a console from before page state: init carries no
 * `pageState` and state messages are ignored, so the fallback can be seen. */
const oldHost = params.get("oldhost") === "1";
/* Page state, filtered by the contract's rules as the console filters its query. */
let pageState: PageState = filterPageState([...params].filter(([key]) => !HARNESS_KEYS.has(key)));
/* The console's budget: 60 states in any 60 seconds per frame, and nothing
 * before the plugin has said it is ready. Both reset with the frame. */
const STATES_PER_MINUTE = 60;
let stateTimes: number[] = [];
let readySeen = false;
/* `latency` holds every answer for this many milliseconds, so the first-load
 * skeleton can be looked at instead of blinking past. Harness only. */
const latency = Number(params.get("latency") ?? 0);
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
    <span id="state"></span>
  </div>
  <div class="viewport" id="viewport">
    <div class="frame-wrap" id="wrap"><iframe id="frame" title="plugin"></iframe></div>
  </div>`;
document.body.append(shell);

const frame = document.getElementById("frame") as HTMLIFrameElement;
const wrap = document.getElementById("wrap") as HTMLDivElement;
const viewport = document.getElementById("viewport") as HTMLDivElement;
const reported = document.getElementById("reported") as HTMLSpanElement;
const stateNote = document.getElementById("state") as HTMLSpanElement;

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

/** The harness's keys, then the page state, as the console would hold it. */
function writeAddress(): void {
  const query = new URLSearchParams({ scenario, theme: dark ? "dark" : "light", width, frame: String(windowHeight) });
  if (zoom) query.set("zoom", zoom);
  if (latency) query.set("latency", String(latency));
  if (pluginQuery) query.set("plugin", pluginQuery);
  if (oldHost) query.set("oldhost", "1");
  for (const [key, value] of Object.entries(pageState)) query.set(key, value);
  history.replaceState(null, "", `?${query}`);
}

function reload(): void {
  writeAddress();
  applyChrome();
  stateTimes = [];
  readySeen = false;
  stateNote.textContent = oldHost ? "old host: page state not kept" : "";
  // The epoch matters: assigning an identical src, fragment and all, is a
  // same-document navigation, so the frame would keep running and the data
  // the operator just picked would never reach a fresh plugin. The console's
  // frame URL has no query; `plugin=` is the old deep link, kept for testing
  // the fallback.
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
        ...(oldHost ? {} : { pageState: { ...pageState } }),
      });
      readySeen = true;
      return;
    case "lattice.plugin.state": {
      if (oldHost || !readySeen) return;
      const now = Date.now();
      stateTimes = stateTimes.filter((time) => now - time < 60_000);
      if (stateTimes.length >= STATES_PER_MINUTE) {
        stateNote.textContent = "state ignored: over 60 a minute";
        return;
      }
      stateTimes.push(now);
      const state = validPageState(data.state);
      if (!state) {
        stateNote.textContent = "state dropped: breaks the contract's rules";
        return;
      }
      const clash = Object.keys(state).filter((key) => HARNESS_KEYS.has(key));
      if (clash.length) {
        stateNote.textContent = `state dropped: ${clash.join(", ")} is a harness key`;
        return;
      }
      pageState = state;
      writeAddress();
      stateNote.textContent = `state ${new URLSearchParams(state).toString() || "(default)"}`;
      return;
    }
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
      const delay = latency || (data.method === "reality" && data.payload?.node_id ? 60 : 320);
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
  writeAddress();
  post({ type: "lattice.host.theme", colorScheme: dark ? "dark" : "light", designTokens: tokens() });
});

reload();
