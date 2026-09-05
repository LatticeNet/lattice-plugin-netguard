/**
 * Canned answers shaped like the wire, for looking at the plugin in a browser.
 *
 * The default scenario is the fleet at production shape: 33 nodes, 25 under
 * NetGuard authority (2 of them drifted), 4 observe only, 2 on a legacy
 * baseline, 2 with no binding, 2 whose snapshot is stale and 1 that has never
 * reported. Several nodes have a postgres or nginx on 0.0.0.0 that no rule
 * explains, the relays carry a 31001-31012 port bank, and every listener has
 * an owning process the way a root agent reports it.
 *
 * Writes mutate the scenario's state so a saved group or binding shows up on
 * the next overview, which is how the editor flows are exercised end to end.
 * Anything the harness cannot answer throws, because a mock that quietly
 * returns undefined teaches the UI to tolerate nonsense.
 *
 * Never imported by src/; the shipped bundle is built from index.html alone.
 */

import type {
  GuardInterface,
  GuardListener,
  GuardNode,
  GuardNodeReality,
  GuardRule,
  GuardSuggestion,
  GuardZone,
  LintFinding,
  NodeBinding,
  Overview,
  RealityDetail,
  RealitySummary,
  Review,
  SecurityGroup,
} from "../src/netguardModel";

export const SCENARIOS = ["fleet", "empty", "readonly", "failing"] as const;
export type Scenario = (typeof SCENARIOS)[number];

const SERVICE = "latticenet.netguard/firewall";
const READ = ["overview", "review", "reality"];
const WRITE = ["upsert_group", "delete_group", "upsert_zone", "delete_zone", "upsert_binding", "adopt", "plan"];

export const INTERFACES: Record<Scenario, { service: string; methods: string[] }[]> = {
  fleet: [{ service: SERVICE, methods: [...READ, ...WRITE] }],
  empty: [{ service: SERVICE, methods: [...READ, ...WRITE] }],
  readonly: [{ service: SERVICE, methods: READ }],
  failing: [{ service: SERVICE, methods: [...READ, ...WRITE] }],
};

/** One clock for the whole scenario, so ages read as ages and not as drift. */
const NOW = Date.now();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function rule(id: string, over: Partial<GuardRule>): GuardRule {
  return { id, action: "allow", direction: "ingress", protocol: "tcp", ports: [], remote: { kind: "any" }, ...over };
}

function sha(seed: string): string {
  // Deterministic, hex, 64 chars: enough to look like a table hash.
  let h = 0;
  for (const char of seed) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return (h.toString(16).padStart(8, "0") + seed.replace(/[^a-z0-9]/gi, "").padEnd(56, "0")).slice(0, 64).toLowerCase();
}

// ── the declared side ───────────────────────────────────────────────────────

const ZONES: GuardZone[] = [
  { id: "loopback", name: "loopback", builtin: true, interfaces: ["lo"], cidrs: ["127.0.0.0/8", "::1/128"], description: "The node itself." },
  { id: "public", name: "public", builtin: true, description: "Every interface no other zone claims. Resolved per node." },
  { id: "wireguard", name: "wg", builtin: true, interfaces: ["wg0"], cidrs: ["10.7.0.0/24"], description: "The fleet overlay." },
  { id: "tailscale", name: "tailscale", builtin: true, interfaces: ["tailscale0"], cidrs: ["100.64.0.0/10"], description: "Operator laptops." },
  { id: "office", name: "Office VPN", cidrs: ["10.99.0.0/16"], description: "The office concentrator's client range." },
];

const GROUPS: SecurityGroup[] = [
  { id: "ssh", name: "ssh", version: 4, description: "Operator shell from anywhere; the key is the gate.", rules: [rule("ssh-any", { ports: [{ from: 22, to: 22 }], comment: "operator shell" })] },
  {
    id: "relay-hub", name: "relay-hub", version: 11, description: "What a sing-box relay accepts from clients.",
    rules: [
      rule("bank", { ports: [{ from: 31001, to: 31012 }], comment: "per-user inbound bank" }),
      rule("reality", { ports: [{ from: 32426, to: 32426 }], comment: "VLESS REALITY" }),
      rule("hy2", { protocol: "udp", ports: [{ from: 36712, to: 36712 }], comment: "Hysteria2" }),
    ],
  },
  { id: "web", name: "web", version: 2, rules: [rule("http", { ports: [{ from: 80, to: 80 }, { from: 443, to: 443 }] })] },
  { id: "db-wg", name: "db-wg", version: 1, description: "Postgres reachable over the overlay only.", rules: [rule("pg", { ports: [{ from: 5432, to: 5432 }], remote: { kind: "zone", zone_id: "wireguard" }, comment: "postgres from the fleet" })] },
  { id: "monitoring", name: "monitoring", version: 3, rules: [rule("node-exporter", { ports: [{ from: 9100, to: 9100 }], remote: { kind: "cidr", cidr: "10.7.0.0/24" } }), rule("smtp-deny", { action: "deny", ports: [{ from: 25, to: 25 }], comment: "never relay mail" })] },
  { id: "mgmt-office", name: "mgmt-office", version: 1, rules: [rule("ssh-office", { ports: [{ from: 22, to: 22 }], remote: { kind: "cidr", cidr: "10.99.0.0/16" } }), rule("console", { ports: [{ from: 8443, to: 8443 }], remote: { kind: "zone", zone_id: "tailscale" } }), rule("old", { disabled: true, ports: [{ from: 8080, to: 8080 }], comment: "retired staging port" })] },
];

const LEGACY_HOME: SecurityGroup = {
  id: "legacy:cd-homeserver", name: "cd-homeserver baseline", version: 1, source: "legacy", node_id: "cd-homeserver",
  rules: [rule("l-ssh", { ports: [{ from: 22, to: 22 }] }), rule("l-web", { ports: [{ from: 80, to: 80 }, { from: 443, to: 443 }] })],
};
const LEGACY_NAS: SecurityGroup = {
  id: "legacy:cd-nas", name: "cd-nas baseline", version: 1, source: "legacy", node_id: "cd-nas",
  rules: [rule("l-ssh", { ports: [{ from: 22, to: 22 }] }), rule("l-smb", { ports: [{ from: 445, to: 445 }], remote: { kind: "cidr", cidr: "192.168.1.0/24" } })],
};

// ── the fleet ───────────────────────────────────────────────────────────────

type Shape = "managed" | "drift" | "observe" | "observe-stale" | "legacy" | "legacy-stale" | "unbound" | "never";

interface Spec {
  id: string;
  name: string;
  shape: Shape;
  groups: string[];
  zones: string[];
  listeners: GuardListener[];
  foreign?: string[];
  lockout?: boolean;
  /** The tcp ports the node's SSH knock table gates, when SSH Guard is on it. */
  knock?: number[];
  ageSeconds: number;
}

const listen = (port: number, process: string, address = "0.0.0.0", protocol = "tcp"): GuardListener => ({ protocol, address, port, process, pid: 1000 + port });
const bank = (): GuardListener[] => Array.from({ length: 12 }, (_, index) => listen(31001 + index, "sing-box"));
const relayListeners = (): GuardListener[] => [listen(22, "sshd"), listen(22, "sshd", "::"), listen(53, "systemd-resolved", "127.0.0.53", "udp"), ...bank(), listen(32426, "sing-box"), listen(36712, "sing-box", "0.0.0.0", "udp")];

const RELAYS = [
  "hkg-edge-01", "hkg-edge-02", "sin-edge-01", "sin-edge-02", "nrt-edge-01", "nrt-edge-02",
  "lax-exit-01", "lax-exit-02", "fra-exit-01", "ams-exit-01", "lhr-relay-01", "syd-relay-01",
  "icn-relay-01", "tpe-relay-01", "sjc-hub-01", "ord-hub-01", "iad-hub-01", "cdg-hub-01",
  "waw-hub-01", "gru-hub-01",
];

const SPECS: Spec[] = [
  ...RELAYS.map<Spec>((name, index) => ({
    id: name, name, shape: "managed", groups: ["ssh", "relay-hub", ...(index % 5 === 0 ? ["monitoring"] : [])], zones: ["wireguard", ...(index % 3 === 0 ? ["tailscale"] : [])],
    listeners: [...relayListeners(), ...(index % 5 === 0 ? [listen(9100, "node_exporter")] : []), ...(index === 7 ? [listen(8080, "nginx")] : [])],
    lockout: index === 14, knock: index % 4 === 0 ? [22] : undefined, ageSeconds: 20 + index * 7,
  })),
  { id: "metix-dmit-1", name: "[Metix]-DMIT-1", shape: "managed", groups: ["ssh", "relay-hub", "web"], zones: ["wireguard", "tailscale"], listeners: [...relayListeners(), listen(80, "nginx"), listen(443, "nginx")], ageSeconds: 41 },
  { id: "metix-dmit-3", name: "[Metix]-DMIT-3", shape: "managed", groups: ["ssh", "relay-hub", "db-wg"], zones: ["wireguard"], listeners: [...relayListeners(), listen(5432, "postgres"), listen(5432, "postgres", "10.7.0.23")], ageSeconds: 33 },
  { id: "metix-racknerd-1", name: "[Metix]-RackNerd-1", shape: "managed", groups: ["ssh", "relay-hub"], zones: ["wireguard"], listeners: relayListeners(), ageSeconds: 58 },
  { id: "metix-dmit-2", name: "[Metix]-DMIT-2", shape: "drift", groups: ["ssh", "relay-hub", "db-wg"], zones: ["wireguard"], listeners: [...relayListeners(), listen(5432, "postgres"), listen(8080, "nginx")], ageSeconds: 27 },
  { id: "fra-exit-02", name: "fra-exit-02", shape: "drift", groups: ["ssh", "relay-hub"], zones: ["wireguard"], listeners: [...relayListeners(), listen(8080, "nginx")], foreign: ["ip filter"], ageSeconds: 71 },
  { id: "cd-build-1", name: "[cd]-build-1", shape: "observe", groups: ["ssh"], zones: [], listeners: [listen(22, "sshd"), listen(3434, "sshd"), listen(8080, "nginx"), listen(2375, "dockerd")], foreign: ["ip nat", "ip filter", "inet lattice_knock"], knock: [22, 3434], ageSeconds: 45 },
  { id: "cd-build-2", name: "[cd]-build-2", shape: "observe", groups: ["ssh", "mgmt-office"], zones: ["tailscale"], listeners: [listen(22, "sshd"), listen(8443, "lattice-console"), listen(9100, "node_exporter", "100.64.0.12")], ageSeconds: 52 },
  { id: "cd-lab-1", name: "[cd]-lab-1", shape: "observe", groups: [], zones: [], listeners: [listen(22, "sshd"), listen(3000, "grafana")], ageSeconds: 12 },
  { id: "cd-lab-2", name: "[cd]-lab-2", shape: "observe-stale", groups: ["ssh"], zones: ["wireguard"], listeners: [listen(22, "sshd"), listen(6443, "kube-apiserver")], ageSeconds: 3 * 86400 + 1200 },
  { id: "cd-homeserver", name: "[cd]-homeserver", shape: "legacy", groups: [], zones: [], listeners: [listen(22, "sshd"), listen(80, "nginx"), listen(443, "nginx"), listen(5432, "postgres"), listen(5432, "postgres", "::"), listen(631, "cupsd", "127.0.0.1")], ageSeconds: 12 },
  { id: "cd-nas", name: "[cd]-nas", shape: "legacy-stale", groups: [], zones: [], listeners: [listen(22, "sshd"), listen(445, "smbd")], ageSeconds: 5 * 86400 },
  { id: "cd-mac-air", name: "[cd]-mac-air", shape: "unbound", groups: [], zones: [], listeners: [listen(5000, "ControlCenter"), listen(7000, "ControlCenter"), listen(22, "sshd")], knock: [22], ageSeconds: 118 },
  { id: "cd-pi-zero", name: "[cd]-pi-zero", shape: "never", groups: [], zones: [], listeners: [], ageSeconds: 0 },
];

function bindingFor(spec: Spec, index: number): NodeBinding {
  const applied = spec.shape === "managed" || spec.shape === "drift";
  return {
    node_id: spec.id,
    group_ids: spec.groups,
    zone_ids: spec.zones,
    managed: spec.shape === "managed" || spec.shape === "drift",
    version: 3 + (index % 4),
    ...(applied ? { applied_table_sha: sha(`applied:${spec.id}`), last_applied_at: ago(3600 * (2 + index)), last_plan_sha: sha(`plan:${spec.id}`) } : {}),
    ...(spec.id === "lax-exit-02" ? { last_error: "selfcheck: control plane unreachable for 4s after commit; rolled back" } : {}),
  };
}

function interfacesFor(spec: Spec, index: number): GuardInterface[] {
  const out: GuardInterface[] = [
    { name: "lo", addresses: ["127.0.0.1/8", "::1/128"], up: true },
    { name: "eth0", addresses: [`203.0.113.${(index % 200) + 10}/24`, `2001:db8:1::${(index + 1).toString(16)}/64`], up: true },
  ];
  if (spec.zones.includes("wireguard") || spec.shape === "managed" || spec.shape === "drift") out.push({ name: "wg0", addresses: [`10.7.0.${(index % 200) + 2}/24`], up: true });
  if (spec.zones.includes("tailscale") || spec.id === "cd-build-2") out.push({ name: "tailscale0", addresses: [`100.64.0.${(index % 200) + 2}/32`], up: true });
  if (spec.foreign?.length) out.push({ name: "docker0", addresses: ["172.17.0.1/16"], up: false });
  return out;
}

interface NodeState {
  spec: Spec;
  index: number;
  node: GuardNode;
  summary: RealitySummary;
  detail: RealityDetail;
}

function buildNode(spec: Spec, index: number, groups: SecurityGroup[]): NodeState {
  const legacy = spec.shape === "legacy" || spec.shape === "legacy-stale";
  const binding = bindingFor(spec, index);
  const resolvedGroups = legacy
    ? [spec.id === "cd-homeserver" ? LEGACY_HOME : LEGACY_NAS]
    : spec.groups.map((id) => groups.find((group) => group.id === id)).filter((group): group is SecurityGroup => Boolean(group));
  const node: GuardNode = {
    node_id: spec.id,
    node_name: spec.name,
    source: legacy ? "legacy" : "stored",
    binding: legacy ? { ...binding, group_ids: resolvedGroups.map((group) => group.id), managed: false } : binding,
    groups: resolvedGroups,
    zones: ZONES.filter((zone) => spec.zones.includes(zone.id)),
  };

  const never = spec.shape === "never";
  const stale = spec.shape === "observe-stale" || spec.shape === "legacy-stale";
  const collectedAt = never ? undefined : ago(spec.ageSeconds);
  const managedSha = spec.shape === "managed" ? binding.applied_table_sha : spec.shape === "drift" ? sha(`live:${spec.id}`) : undefined;
  const reality: GuardNodeReality | null = never
    ? null
    : {
        node_id: spec.id,
        listeners: spec.listeners,
        interfaces: interfacesFor(spec, index),
        managed_sha: managedSha,
        foreign_tables: spec.foreign ?? [],
        nft_version: "1.0.9",
        collected_at: collectedAt!,
      };
  const status = never ? "unknown" : stale ? "stale" : "fresh";
  const drift = never || !binding.applied_table_sha || !managedSha ? "unknown" : managedSha === binding.applied_table_sha ? "in_sync" : "drift";
  const summary: RealitySummary = {
    node_id: spec.id,
    node_name: spec.name,
    snapshot_status: status,
    drift_state: drift,
    managed: node.binding.managed,
    has_binding: !spec.shape.startsWith("unbound") && spec.shape !== "never",
    ...(collectedAt ? { collected_at: collectedAt, received_at: collectedAt, stale_after: new Date(Date.parse(collectedAt) + 30 * 3600 * 1000).toISOString() } : {}),
    ...(managedSha ? { managed_sha: managedSha } : {}),
    ...(binding.applied_table_sha ? { applied_table_sha: binding.applied_table_sha, last_applied_at: binding.last_applied_at } : {}),
    ...(binding.last_error ? { last_error: binding.last_error } : {}),
    ...(reality ? { listener_count: reality.listeners?.length ?? 0, interface_count: reality.interfaces?.length ?? 0, foreign_table_count: reality.foreign_tables?.length ?? 0 } : {}),
  };
  const detail: RealityDetail = {
    node_id: spec.id, snapshot_status: status, reality, received_at: collectedAt ?? null, stale_after: summary.stale_after ?? null,
    // The knock table is reported as a foreign table plus its scope; a gated
    // port is confined whatever the guard rules say.
    ...(spec.knock && !never ? { knock_gate: true, knock_gated_ports: spec.knock } : {}),
  };
  if (spec.shape === "unbound" || never) {
    node.binding = { node_id: spec.id, group_ids: [], zone_ids: [], managed: false, version: 0 };
  }
  return { spec, index, node, summary, detail };
}

// ── the review, computed the way the server would ───────────────────────────

function rulesFor(node: GuardNode): GuardRule[] {
  return [...(node.binding.overrides ?? []), ...node.groups.flatMap((group) => group.rules ?? [])];
}

function covers(rules: GuardRule[], listener: GuardListener): boolean {
  return rules.some((candidate) =>
    !candidate.disabled && candidate.action === "allow" && candidate.direction === "ingress" &&
    (candidate.protocol === "any" || candidate.protocol === listener.protocol) &&
    ((candidate.ports ?? []).length === 0 || (candidate.ports ?? []).some((range) => range.from <= (listener.port ?? 0) && (listener.port ?? 0) <= range.to)));
}

function suggestionsFor(state: NodeState): GuardSuggestion[] {
  const out: GuardSuggestion[] = [];
  const reality = state.detail.reality;
  if (!reality) return out;
  if (state.summary.drift_state === "drift") {
    out.push({ id: `${state.node.node_id}:managed_table_drift`, code: "managed_table_drift", severity: "warn", title: "Managed table drift detected", detail: "The live lattice_guard table hash differs from the last applied plan hash; review and re-apply the guard plan." });
  }
  const rules = rulesFor(state.node);
  const seen = new Set<string>();
  for (const listener of reality.listeners ?? []) {
    const address = listener.address ?? "";
    if (address.startsWith("127.") || address === "::1") continue;
    const overlay = address.startsWith("10.7.") || address.startsWith("100.64.");
    const key = `${listener.protocol}/${listener.port}`;
    if (seen.has(key) || covers(rules, listener)) continue;
    seen.add(key);
    out.push({
      id: `${state.node.node_id}:listener_missing_allow:${overlay ? "wireguard" : "public"}:${key}`,
      code: "listener_missing_allow", severity: "warn", title: "Listener has no matching allow",
      detail: `${listener.protocol}/${listener.port} is listening on ${address || "an unspecified address"} but no matching ingress allow was found; review whether to add it.`,
      zone_id: overlay ? "wireguard" : "public", protocol: listener.protocol, port: listener.port, address, process: listener.process,
    });
  }
  return out;
}

function rulesetFor(node: GuardNode): string {
  const lines = ["table inet lattice_guard {", "  chain input {", "    type filter hook input priority 0; policy drop;", "    iif lo accept", "    ct state established,related accept"];
  for (const zone of node.zones) for (const iface of zone.interfaces ?? []) lines.push(`    iifname "${iface}" accept comment "zone ${zone.id}"`);
  for (const group of node.groups) {
    for (const item of group.rules ?? []) {
      if (item.disabled) continue;
      const ports = (item.ports ?? []).map((range) => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`)).join(", ");
      const remote = item.remote.cidr ? `ip saddr ${item.remote.cidr} ` : item.remote.zone_id ? `iifname "${ZONES.find((zone) => zone.id === item.remote.zone_id)?.interfaces?.[0] ?? item.remote.zone_id}" ` : "";
      lines.push(`    ${remote}${item.protocol === "any" ? "" : `${item.protocol} dport { ${ports} } `}${item.action === "deny" ? "drop" : "accept"} comment "${group.id}/${item.id}"`);
    }
  }
  lines.push("  }", "}");
  return lines.join("\n");
}

function findingsFor(state: NodeState): LintFinding[] {
  const out: LintFinding[] = [];
  if (state.spec.lockout) out.push({ code: "mgmt_lockout", severity: "block", message: "The plan drops the interface the control plane reaches this node on (eth0) and no trusted zone or allow keeps that path open." });
  if (state.summary.drift_state === "drift") out.push({ code: "drift_reapply", severity: "warn", message: "The node's live table differs from the last applied plan; applying re-installs the intended ruleset." });
  return out;
}

function reviewFor(state: NodeState): Review {
  const managed = state.node.binding.managed;
  return {
    node: state.node,
    reality: state.detail,
    suggestions: suggestionsFor(state),
    drift_state: state.summary.drift_state ?? "unknown",
    replan_input: { node_id: state.node.node_id },
    findings: managed ? findingsFor(state) : [],
    ...(managed ? { ruleset: rulesetFor(state.node) } : { compile_error: state.node.source === "legacy" ? "legacy baseline is observe-only until adopted" : "node has no managed binding" }),
  };
}

// ── scenario state and handlers ─────────────────────────────────────────────

interface State {
  groups: SecurityGroup[];
  zones: GuardZone[];
  nodes: NodeState[];
}

function build(scenario: Scenario): State {
  if (scenario === "empty") return { groups: [], zones: ZONES.filter((zone) => zone.builtin), nodes: [] };
  const groups = GROUPS.map((group) => ({ ...group, rules: group.rules.map((item) => ({ ...item })) }));
  return { groups, zones: ZONES.map((zone) => ({ ...zone })), nodes: SPECS.map((spec, index) => buildNode(spec, index, groups)) };
}

const states = new Map<Scenario, State>();

function stateFor(scenario: Scenario): State {
  let state = states.get(scenario);
  if (!state) {
    state = build(scenario);
    states.set(scenario, state);
  }
  return state;
}

function nodeOr(state: State, nodeId: unknown): NodeState {
  const found = state.nodes.find((entry) => entry.node.node_id === nodeId);
  if (!found) throw new Error(`unknown node ${String(nodeId)}`);
  return found;
}

function overviewOf(state: State): Overview {
  // A node nobody bound is in the reality roster only, as on the real server.
  const bound = state.nodes.filter((entry) => entry.spec.shape !== "unbound" && entry.spec.shape !== "never");
  return { groups: state.groups, zones: state.zones, nodes: bound.map((entry) => entry.node) };
}

type Handler = (payload: Record<string, any>) => unknown;

export function handlers(scenario: Scenario): Record<string, Handler> {
  const state = stateFor(scenario);
  return {
    "firewall/overview": () => overviewOf(state),
    "firewall/reality": (payload) => {
      if (payload.node_id) return { node: nodeOr(state, payload.node_id).detail };
      const limit = Math.max(1, Math.min(Number(payload.limit) || 100, 500));
      const start = payload.cursor ? Number(payload.cursor) : 0;
      const nodes = state.nodes.slice(start, start + limit).map((entry) => entry.summary);
      return { nodes, ...(start + limit < state.nodes.length ? { next_cursor: String(start + limit) } : {}) };
    },
    "firewall/review": (payload) => ({ review: reviewFor(nodeOr(state, payload.node_id)) }),
    "firewall/upsert_group": (payload) => {
      const id = String(payload.id || payload.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const existing = state.groups.find((group) => group.id === id);
      const group: SecurityGroup = { id, name: String(payload.name), description: payload.description, rules: payload.rules ?? [], version: (existing?.version ?? 0) + 1 };
      if (existing) Object.assign(existing, group);
      else state.groups.push(group);
      // Nodes carry resolved copies, and the server would re-resolve them.
      for (const entry of state.nodes) entry.node.groups = entry.node.groups.map((candidate) => (candidate.id === id ? group : candidate));
      return { group };
    },
    "firewall/delete_group": (payload) => {
      if (state.nodes.some((entry) => entry.node.binding.group_ids.includes(payload.id))) throw new Error(`group ${payload.id} is still bound to a node`);
      state.groups = state.groups.filter((group) => group.id !== payload.id);
      return { ok: true };
    },
    "firewall/upsert_zone": (payload) => {
      const existing = state.zones.find((zone) => zone.id === payload.id);
      const zone: GuardZone = { id: payload.id, name: payload.name, description: payload.description, interfaces: payload.interfaces ?? [], cidrs: payload.cidrs ?? [] };
      if (existing) Object.assign(existing, zone);
      else state.zones.push(zone);
      return { zone };
    },
    "firewall/delete_zone": (payload) => {
      state.zones = state.zones.filter((zone) => zone.id !== payload.id);
      return { ok: true };
    },
    "firewall/upsert_binding": (payload) => {
      const entry = nodeOr(state, payload.node_id);
      entry.node.binding = { ...entry.node.binding, group_ids: payload.group_ids ?? [], zone_ids: payload.zone_ids ?? [], managed: Boolean(payload.managed), version: (entry.node.binding.version ?? 0) + 1 };
      entry.node.groups = entry.node.binding.group_ids.map((id) => state.groups.find((group) => group.id === id)).filter((group): group is SecurityGroup => Boolean(group));
      entry.node.zones = state.zones.filter((zone) => entry.node.binding.zone_ids?.includes(zone.id));
      entry.summary.managed = entry.node.binding.managed;
      return { binding: entry.node.binding };
    },
    "firewall/adopt": (payload) => {
      const entry = nodeOr(state, payload.node_id);
      entry.node.source = "stored";
      entry.node.binding = { ...entry.node.binding, managed: true, version: entry.node.binding.version + 1 };
      entry.summary.managed = true;
      return { node: entry.node };
    },
    "firewall/plan": (payload) => {
      const entry = nodeOr(state, payload.node_id);
      if (entry.spec.lockout && !payload.accept_lockout_risk) throw new Error("plan blocked: mgmt_lockout finding requires accept_lockout_risk");
      return { approval: { id: `apr_${entry.node.node_id}_${(NOW % 100000).toString(36)}` } };
    },
  };
}
