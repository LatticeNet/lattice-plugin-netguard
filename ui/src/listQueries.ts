/**
 * The console's list query (@latticenet/plugin-bridge/query) on NetGuard's
 * three lists: Nodes, Groups and Zones. Each layer declares its own fields,
 * read from the row model it draws, so `status:drifted`, `port:22/tcp` and
 * `nodes:0` mean what the table beside them shows. The Nodes layer adds the
 * console's shared node fields it can answer (name and id); the plugin
 * contract carries no online state, address or last report, so the rest of
 * the shared set would match nothing and stays out of the menu.
 *
 * Each schema is built once per page. Facts that change with a refresh (what
 * the session may read, the groups and zones that name an id) are read
 * through `read()` when the query runs, so the field index is built once and
 * the answers follow the data.
 *
 * DOM-free, like the rest of the page's rules, so the tests read the fields
 * without a renderer.
 */
import { compileQuery, nodeQueryFields, parseQuery, type QueryField, type QueryNode, type QuerySchema } from "@latticenet/plugin-bridge/query";

import { formatProcesses, matchesGroup, remoteScope, ruleSentence, usedByNodes, LOOPBACK_ZONE, PUBLIC_ZONE, type ExposureContext } from "./exposure";
import type { GuardNode, GuardRule, GuardZone, SecurityGroup } from "./netguardModel";
import { remoteValue } from "./netguardModel";
import { nodeStatus, statusRank, type NodeStatusKey } from "./nodeStatus";
import { hasFreshEvidence, matchesPortQuery, needsAttention, parsePortQuery, portLabel, type ExposureRowView } from "./overview";
import type { Coverage, DriftState, SnapshotStatus } from "./posture";

/** One query example for the bar's help card. */
export interface ListQueryExample {
  query: string;
  note: string;
}

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

// ── Nodes ───────────────────────────────────────────────────────────────────

/** What the Nodes fields need from the page when the query runs. */
export interface NodesQueryContext {
  canSeeReality: boolean;
  /** False when the session may read reality but the read failed. */
  realityRead: boolean;
  groups: readonly SecurityGroup[];
  zones: readonly GuardZone[];
}

/**
 * The Status column's verdicts as query words, one per verdict, spelled the
 * way the column reads them (`Drifted` is `drifted`, `Not read` is
 * `not_read`). The one verdict whose label is a count, "3 ports, no rule",
 * is `no_rule`.
 */
const STATUS_WORDS: Readonly<Record<NodeStatusKey, string>> = {
  drift: "drifted",
  "apply-failed": "apply_failed",
  unexplained: "no_rule",
  stale: "stale",
  "snapshot-unread": "snapshot_unread",
  "never-applied": "never_applied",
  "no-managed-table": "no_managed_table",
  unverified: "unverified",
  "never-reported": "never_reported",
  "reality-unread": "not_read",
  reading: "reading",
  "not-judged": "not_judged",
  "intent-only": "intent_only",
  "not-enforced": "not_enforced",
  "no-binding": "no_binding",
  enforced: "enforced",
};

/** The verdict words in the attention order the Status column sorts by, worst first, which is the order `sort:status` uses. */
export const NODE_STATUS_VALUES: readonly string[] = (Object.keys(STATUS_WORDS) as NodeStatusKey[])
  .sort((a, b) => statusRank(a) - statusRank(b))
  .map((key) => STATUS_WORDS[key]);

const COVERAGE_WORDS: Readonly<Record<Coverage, string>> = { managed: "managed", observe_only: "observe_only", legacy: "legacy", unbound: "unbound" };
const DRIFT_WORDS: Readonly<Record<DriftState, string>> = { drift: "drifted", unknown: "unknown", in_sync: "in_sync" };
const SNAPSHOT_WORDS: Readonly<Record<SnapshotStatus, string>> = { fresh: "fresh", stale: "stale", unknown: "never_reported" };

/** A row's open ports as the Overview's picture names them, protocol always written: 22/tcp, 31001-31012/tcp. */
function openLabels(view: ExposureRowView): string[] {
  return hasFreshEvidence(view) ? view.exposure.open.map(portLabel) : [];
}

export function nodesQuerySchema(read: () => NodesQueryContext): QuerySchema<ExposureRowView> {
  /** Whether this row's reality facts were read; a fact nobody read matches nothing rather than claiming "never reported". */
  const realityKnown = (): boolean => {
    const ctx = read();
    return ctx.canSeeReality && ctx.realityRead;
  };
  const groupNames = (view: ExposureRowView): string[] => {
    const groups = read().groups;
    const managed = view.exposure.managedBy.kind === "none" ? [] : view.exposure.managedBy.names;
    return unique([...view.row.groupIds, ...view.row.groupIds.map((id) => groups.find((group) => group.id === id)?.name), ...managed]);
  };
  const zoneNames = (view: ExposureRowView): string[] => {
    const zones = read().zones;
    return unique([...view.row.zoneIds, ...view.row.zoneIds.map((id) => zones.find((zone) => zone.id === id)?.name)]);
  };
  const fresh = <V>(get: (view: ExposureRowView) => V) => (view: ExposureRowView): V | undefined => (hasFreshEvidence(view) ? get(view) : undefined);

  const fields: QueryField<ExposureRowView>[] = [
    {
      key: "status",
      aliases: ["verdict"],
      type: "enum",
      values: NODE_STATUS_VALUES,
      valueAliases: { drift: "drifted", failed: "apply_failed", unexplained: "no_rule", never: "never_reported" },
      hint: "The Status column's verdict",
      get: (view) => {
        const ctx = read();
        return STATUS_WORDS[nodeStatus(view, ctx.canSeeReality, ctx.realityRead).key];
      },
    },
    {
      key: "coverage",
      aliases: ["posture"],
      type: "enum",
      values: ["managed", "observe_only", "legacy", "unbound"],
      valueAliases: { observe: "observe_only", baseline: "legacy", none: "unbound" },
      hint: "How far NetGuard governs the node: managed, observe_only, legacy or unbound",
      get: (view) => COVERAGE_WORDS[view.row.coverage],
    },
    {
      key: "drift",
      type: "enum",
      values: ["drifted", "unknown", "in_sync"],
      valueAliases: { drift: "drifted", sync: "in_sync" },
      hint: "Whether the live table still matches what Lattice applied",
      get: (view) => (realityKnown() ? DRIFT_WORDS[view.row.driftState] : undefined),
    },
    {
      key: "snapshot",
      type: "enum",
      values: ["fresh", "stale", "never_reported"],
      valueAliases: { never: "never_reported", reporting: "fresh" },
      hint: "Whether the node's last firewall snapshot is fresh, stale or missing",
      get: (view) => (realityKnown() ? SNAPSHOT_WORDS[view.row.snapshotStatus] : undefined),
    },
    {
      key: "group",
      aliases: ["groups"],
      type: "list",
      hint: "Security group the node's binding attaches, by name or id",
      get: groupNames,
      suggest: (rows) => unique(rows.flatMap((view) => view.row.groupIds.map((id) => read().groups.find((group) => group.id === id)?.name ?? id))),
      sort: false,
    },
    {
      key: "zone",
      aliases: ["zones"],
      type: "list",
      hint: "Trusted zone the node's binding lists, by name or id",
      get: zoneNames,
      suggest: (rows) => unique(rows.flatMap((view) => view.row.zoneIds)),
      sort: false,
    },
    {
      key: "port",
      aliases: ["ports"],
      type: "list",
      hint: "A port open to the internet on a fresh snapshot: 22/tcp, 31001-31012/tcp, 36712/udp",
      get: openLabels,
      // The Overview's picture opens Nodes on `port:22/tcp`, which lists exactly
      // the nodes that row counted: the same port or bank, never one that
      // contains it (overview.ts matchesPortQuery). Anything else, a wildcard
      // among them, falls back to the labels.
      match: (view, value) => {
        const query = parsePortQuery(`port:${value.trim().toLowerCase()}`);
        return query ? matchesPortQuery(view, query) : undefined;
      },
      suggest: (rows) => unique(rows.flatMap(openLabels)),
      sort: false,
    },
    {
      key: "process",
      aliases: ["proc"],
      type: "list",
      hint: "Process that owns a port open to the internet",
      get: fresh((view) => view.exposure.open.flatMap((span) => span.processes)),
      suggest: (rows) => unique(rows.flatMap((view) => (hasFreshEvidence(view) ? view.exposure.open.flatMap((span) => span.processes) : []))),
      sort: false,
    },
    {
      key: "unexplained",
      aliases: ["no_rule"],
      type: "number",
      hint: "Ports open to the internet that no rule allows",
      get: fresh((view) => view.exposure.unexplained),
    },
    {
      key: "open",
      type: "number",
      hint: "Ports and port banks open to the internet",
      get: fresh((view) => view.exposure.open.length),
    },
    {
      key: "foreign",
      aliases: ["foreign_tables"],
      type: "number",
      hint: "nftables tables on the node that Lattice did not write",
      get: (view) => (realityKnown() ? view.row.foreignTableCount : undefined),
    },
    {
      key: "seen",
      aliases: ["collected"],
      type: "time",
      hint: "When the node's last firewall snapshot was taken, as an age or a date",
      get: (view) => view.row.collectedAt,
    },
    {
      key: "applied",
      aliases: ["last_apply", "last_applied"],
      type: "time",
      hint: "When Lattice last applied a ruleset to the node, as an age or a date",
      get: (view) => view.row.lastAppliedAt,
    },
    {
      key: "attention",
      type: "bool",
      flag: true,
      hint: "Needs attention: drift, a failed apply, or ports no rule allows",
      get: needsAttention,
    },
    { key: "drifted", type: "bool", flag: true, hint: "The live table drifted from what Lattice applied", get: (view) => view.row.driftState === "drift" },
    { key: "failed", type: "bool", flag: true, hint: "The last apply failed", get: (view) => Boolean(view.row.lastError) },
    { key: "enforced", type: "bool", flag: true, hint: "Lattice enforces the node's rules", get: (view) => view.exposure.enforced },
    ...nodeQueryFields<ExposureRowView>((view) => ({ id: view.row.nodeId, name: view.row.nodeName }), { only: ["name", "id"] }),
  ];

  return {
    fields,
    text: (view) => [
      view.row.nodeName,
      view.row.nodeId,
      ...groupNames(view),
      ...zoneNames(view),
      ...view.exposure.open.flatMap((span) => [portLabel(span), formatProcesses(span)]),
    ],
  };
}

export const NODES_QUERY_EXAMPLES: readonly ListQueryExample[] = [
  { query: "is:attention sort:-unexplained", note: "Nodes that need a hand, the most ports with no rule first" },
  { query: "status:drifted OR status:apply_failed", note: "Tables that drifted and applies that failed" },
  { query: "port:5432/tcp -zone:wireguard", note: "Postgres open to the internet on nodes that do not trust the overlay" },
];

// ── Groups ──────────────────────────────────────────────────────────────────

export interface GroupsQueryContext {
  context: ExposureContext;
  /** The intent records, for which nodes bind a group. */
  nodes: readonly GuardNode[];
}

/** "22", "8000-8100", "36712/udp" and "22/tcp" as a port query; undefined for anything else. */
function parseRulePort(value: string): { from: number; to: number; protocol?: "tcp" | "udp" } | undefined {
  const match = /^(\d{1,5})(?:-(\d{1,5}))?(?:\/(tcp|udp))?$/.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to > 65535 || to < from) return undefined;
  return { from, to, ...(match[3] ? { protocol: match[3] as "tcp" | "udp" } : {}) };
}

/**
 * Whether a rule names this port or range, whatever it does with it: a deny
 * on 25 is what someone searching a group for port 25 is looking for. A rule
 * with no ports covers them all; ICMP has none.
 */
function ruleNamesPort(rule: GuardRule, port: { from: number; to: number; protocol?: "tcp" | "udp" }): boolean {
  if (rule.protocol === "icmp" || rule.protocol === "icmpv6") return false;
  if (port.protocol && rule.protocol !== "any" && rule.protocol !== port.protocol) return false;
  const ranges = rule.ports ?? [];
  return ranges.length === 0 || ranges.some((range) => range.from <= port.from && port.to <= range.to);
}

function rulePortLabels(rule: GuardRule): string[] {
  if (rule.protocol !== "tcp" && rule.protocol !== "udp") return [];
  return (rule.ports ?? []).map((range) => portLabel({ ...range, protocol: rule.protocol as "tcp" | "udp" }));
}

function bindingNodes(nodes: readonly GuardNode[], groupId: string): GuardNode[] {
  return nodes.filter((node) => (node.binding?.group_ids ?? []).includes(groupId));
}

/** The fields that look inside a group's rules; a query that names one opens the groups it keeps. */
const RULE_FIELD_KEYS = ["port", "remote", "protocol", "direction", "action", "comment"] as const;

export function groupsQuerySchema(read: () => GroupsQueryContext): QuerySchema<SecurityGroup> {
  const rules = (group: SecurityGroup): GuardRule[] => group.rules ?? [];
  const fields: QueryField<SecurityGroup>[] = [
    { key: "name", type: "string", hint: "Group name", get: (group) => group.name, suggest: (rows) => unique(rows.map((group) => group.name)) },
    { key: "id", type: "string", hint: "Group id", get: (group) => group.id },
    { key: "rules", type: "number", hint: "How many rules the group holds", get: (group) => rules(group).length },
    {
      key: "nodes",
      aliases: ["used_by"],
      type: "number",
      hint: "How many nodes bind the group",
      get: (group) => usedByNodes(read().nodes, "group_ids", group.id),
    },
    {
      key: "node",
      type: "list",
      hint: "A node that binds the group, by name or id",
      get: (group) => bindingNodes(read().nodes, group.id).flatMap((node) => unique([node.node_name, node.node_id])),
      suggest: () => unique(read().nodes.map((node) => node.node_name || node.node_id)),
      sort: false,
    },
    {
      key: "port",
      aliases: ["ports"],
      type: "list",
      hint: "A port or range a rule names: 22, 8000-8100, 36712/udp",
      get: (group) => unique(rules(group).flatMap(rulePortLabels)),
      match: (group, value) => {
        const port = parseRulePort(value);
        return port ? rules(group).some((rule) => ruleNamesPort(rule, port)) : undefined;
      },
      suggest: (rows) => unique(rows.flatMap((group) => rules(group).flatMap(rulePortLabels))),
      sort: false,
    },
    {
      key: "remote",
      aliases: ["from"],
      type: "list",
      hint: "Where a rule allows from or to: a CIDR, a zone, a group, a node, a domain, or any",
      get: (group) => {
        const ctx = read().context;
        return unique(rules(group).flatMap((rule) => [remoteValue(rule.remote) || rule.remote?.kind, remoteScope(rule.remote, ctx).label]));
      },
      suggest: (rows) => unique(rows.flatMap((group) => rules(group).map((rule) => remoteValue(rule.remote) || rule.remote?.kind))),
      sort: false,
    },
    {
      key: "protocol",
      aliases: ["proto"],
      type: "enum",
      values: ["tcp", "udp", "icmp", "icmpv6", "any"],
      hint: "A rule's protocol",
      get: (group) => unique(rules(group).map((rule) => rule.protocol)),
      sort: false,
    },
    {
      key: "direction",
      type: "enum",
      values: ["ingress", "egress"],
      valueAliases: { in: "ingress", out: "egress" },
      hint: "A rule's direction",
      get: (group) => unique(rules(group).map((rule) => rule.direction)),
      sort: false,
    },
    {
      key: "action",
      type: "enum",
      values: ["allow", "deny"],
      hint: "What a rule does",
      get: (group) => unique(rules(group).map((rule) => rule.action)),
      sort: false,
    },
    {
      key: "comment",
      type: "list",
      hint: "A rule's comment",
      get: (group) => unique(rules(group).map((rule) => rule.comment)),
      sort: false,
    },
    { key: "version", type: "number", hint: "The group's version", get: (group) => group.version },
    { key: "legacy", type: "bool", flag: true, hint: "A node's imported legacy baseline", get: (group) => group.source === "legacy" },
  ];

  return {
    fields,
    text: (group) => {
      const ctx = read().context;
      return [group.name, group.id, group.description, ...rules(group).flatMap((rule) => [ruleSentence(rule, ctx), rule.comment, rule.id])];
    },
  };
}

/** Every name the rule-level fields answer to, as the parser lowercases them. */
function ruleFieldNames(schema: QuerySchema<SecurityGroup>): Set<string> {
  const names = new Set<string>();
  for (const field of schema.fields) {
    if ((RULE_FIELD_KEYS as readonly string[]).includes(field.key)) for (const name of [field.key, ...(field.aliases ?? [])]) names.add(name.toLowerCase());
  }
  return names;
}

/** The query's terms that are not under a negation: what it asks to find, not what it asks to leave out. */
function positiveTerms(node: QueryNode | null, out: { words: string[]; terms: { start: number; end: number; field: string }[] }, negated = false): typeof out {
  if (!node) return out;
  switch (node.kind) {
    case "and":
    case "or":
      for (const item of node.items) positiveTerms(item, out, negated);
      break;
    case "not":
      positiveTerms(node.item, out, !negated);
      break;
    case "text":
      if (!negated && node.value) out.words.push(node.value.toLowerCase());
      break;
    case "term":
      if (!negated) out.terms.push({ start: node.start, end: node.end, field: node.field });
      break;
  }
  return out;
}

/**
 * The groups a query reaches inside of: a bare word found in a rule's
 * sentence or comment and not in the group's own name, id or description, or
 * a rule-level term (port, remote, protocol, direction, action, comment) the
 * group passes on its own. The Groups layer opens them while the query
 * stands, because the operator asked for the rule, not the group; clearing
 * the query restores their own set. A negated term opens nothing: it says
 * what to leave out.
 */
export function groupsReachedByQuery(
  text: string,
  groups: readonly SecurityGroup[],
  schema: QuerySchema<SecurityGroup>,
  context: ExposureContext,
): Set<string> {
  const parsed = parseQuery(text);
  const reached = new Set<string>();
  if (!parsed.ok || !parsed.tree || !groups.length) return reached;
  const { words, terms } = positiveTerms(parsed.tree, { words: [], terms: [] });
  const ruleNames = ruleFieldNames(schema);
  // Each rule-level term on its own, so a group kept by `name:web OR port:22`
  // opens only when its rules name port 22.
  const now = Date.now();
  const tests = terms
    .filter((term) => ruleNames.has(term.field))
    .flatMap((term) => {
      const compiled = compileQuery(text.slice(term.start, term.end), schema);
      return compiled.ok ? [compiled.query] : [];
    });
  for (const group of groups) {
    if (tests.some((query) => query.test(group, now)) || words.some((word) => matchesGroup(group, context, word).inRules)) reached.add(group.id);
  }
  return reached;
}

export const GROUPS_QUERY_EXAMPLES: readonly ListQueryExample[] = [
  { query: "port:22", note: "Groups with a rule that names port 22, opened on the rule" },
  { query: "nodes:0", note: "Groups no node binds" },
  { query: "action:deny OR direction:egress sort:name", note: "Groups with a deny or an egress rule, by name" },
];

// ── Zones ───────────────────────────────────────────────────────────────────

export interface ZonesQueryContext {
  nodes: readonly GuardNode[];
}

export function zonesQuerySchema(read: () => ZonesQueryContext): QuerySchema<GuardZone> {
  const fields: QueryField<GuardZone>[] = [
    { key: "name", type: "string", hint: "Zone name", get: (zone) => zone.name, suggest: (rows) => unique(rows.map((zone) => zone.name)) },
    { key: "id", type: "string", hint: "Zone id", get: (zone) => zone.id },
    {
      key: "interface",
      aliases: ["interfaces", "iface"],
      type: "list",
      hint: "An interface the zone names: wg0, tailscale0",
      get: (zone) => zone.interfaces ?? [],
      suggest: (rows) => unique(rows.flatMap((zone) => zone.interfaces ?? [])),
      sort: false,
    },
    {
      key: "cidr",
      aliases: ["cidrs", "net"],
      type: "list",
      hint: "A CIDR the zone names: 10.7.0.0/24",
      get: (zone) => zone.cidrs ?? [],
      suggest: (rows) => unique(rows.flatMap((zone) => zone.cidrs ?? [])),
      sort: false,
    },
    {
      key: "nodes",
      aliases: ["trusted_by"],
      type: "number",
      hint: "How many nodes trust the zone through their binding (loopback and public have no count)",
      // The Trusted by column says "every node" for loopback and "never
      // trusted" for public (ZonesTable.vue); neither is a count of bindings.
      get: (zone) => (zone.id === LOOPBACK_ZONE || zone.id === PUBLIC_ZONE ? undefined : usedByNodes(read().nodes, "zone_ids", zone.id)),
    },
    { key: "builtin", type: "bool", flag: true, hint: "Defined on every node", get: (zone) => Boolean(zone.builtin) },
  ];
  return {
    fields,
    text: (zone) => [zone.name, zone.id, zone.description, ...(zone.interfaces ?? []), ...(zone.cidrs ?? [])],
  };
}

export const ZONES_QUERY_EXAMPLES: readonly ListQueryExample[] = [
  { query: "-is:builtin", note: "Zones defined here, not built in" },
  { query: "cidr:10.", note: "Zones that name a 10.x range" },
  { query: "nodes:0", note: "Zones no binding trusts" },
];
