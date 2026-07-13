export interface PortRange { from: number; to: number }
export interface Remote { kind: string; node_id?: string; cidr?: string; domain?: string; group_id?: string; zone_id?: string }
export interface GuardRule {
  id: string;
  comment?: string;
  action: "allow" | "deny";
  direction: "ingress" | "egress";
  protocol: "tcp" | "udp" | "icmp" | "icmpv6" | "any";
  ports: PortRange[];
  remote: Remote;
  log?: boolean;
  disabled?: boolean;
}
export interface SecurityGroup {
  id: string;
  name: string;
  description?: string;
  rules: GuardRule[];
  version: number;
  source?: string;
  node_id?: string;
}
export interface GuardZone {
  id: string;
  name: string;
  builtin?: boolean;
  interfaces?: string[];
  cidrs?: string[];
  description?: string;
}
export interface NodeBinding {
  node_id: string;
  group_ids: string[];
  overrides?: GuardRule[];
  zone_ids?: string[];
  managed: boolean;
  version: number;
  last_plan_sha?: string;
  last_applied_at?: string;
  last_error?: string;
  applied_table_sha?: string;
}
export interface GuardNode {
  node_id: string;
  node_name?: string;
  source: "stored" | "legacy";
  binding: NodeBinding;
  groups: SecurityGroup[];
  zones: GuardZone[];
}
export interface Overview { groups: SecurityGroup[]; zones: GuardZone[]; nodes: GuardNode[] }

export function parseRanges(value: string): PortRange[] {
  const ranges: PortRange[] = [];
  const seen = new Set<string>();
  for (const token of value.split(",")) {
    const part = token.trim();
    if (!part) continue;
    const match = part.match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
    if (!match) throw new Error(`Invalid port range: ${part}`);
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1 || to > 65535 || from > to) throw new Error(`Port range is outside 1-65535: ${part}`);
    const key = `${from}-${to}`;
    if (!seen.has(key)) {
      seen.add(key);
      ranges.push({ from, to });
    }
  }
  return ranges.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function formatRanges(ranges: PortRange[] | undefined): string {
  return (ranges ?? []).map((range) => range.from === range.to ? String(range.from) : `${range.from}-${range.to}`).join(", ");
}

export function remoteValue(remote: Remote): string {
  return remote.cidr || remote.node_id || remote.group_id || remote.zone_id || remote.domain || "";
}

export function buildRemote(kind: string, value: string): Remote {
  const remote: Remote = { kind };
  const clean = value.trim();
  if (kind === "cidr") remote.cidr = clean;
  if (kind === "node") remote.node_id = clean;
  if (kind === "group") remote.group_id = clean;
  if (kind === "zone") remote.zone_id = clean;
  if (kind === "domain") remote.domain = clean;
  return remote;
}

export function safeErrorMessage(value: unknown, fallback = "Request failed"): string {
  if (value instanceof Error && value.message.trim()) return value.message;
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}
