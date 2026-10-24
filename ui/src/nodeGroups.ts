/**
 * Security groups bound to node groups (design 32 S4): the words and the
 * small decisions the bindings table, its editor and the batch plan dialog
 * share. A binding never adopts a node. A member NetGuard manages compiles the
 * groups after its own, once a plan for it is approved; a member it does not
 * manage stays inactive, and nothing is planned for it.
 */

import type {
  NodeGroupBinding,
  NodeGroupChoice,
  NodeGroupPlanResult,
  PlanGroupRef,
  SecurityGroup,
} from "./netguardModel";

/** The prefix of a node's adopted baseline group, which binds only to that node. */
const LEGACY_GROUP_PREFIX = "sg-legacy-";

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "2 managed, 1 not managed", "no members". Managed says NetGuard compiles the
 * groups there once a plan is approved, not that a plan is in force.
 */
export function membersLine(binding: NodeGroupBinding): string {
  const active = binding.members.filter((member) => member.state === "active").length;
  const inactive = binding.members.length - active;
  if (!binding.members.length) return "no members";
  const parts = [];
  if (active) parts.push(`${active} managed`);
  if (inactive) parts.push(`${inactive} not managed`);
  return parts.join(", ");
}

/** A node group in the binding picker: "lab (2 members, none managed)". */
export function nodeGroupChoiceLabel(choice: NodeGroupChoice, managed: ReadonlySet<string>): string {
  const total = choice.members.length;
  const managedCount = choice.members.filter((id) => managed.has(id)).length;
  const members = count(total, "member", "members");
  if (!total) return `${choice.name} (no members)`;
  return `${choice.name} (${members}, ${managedCount ? `${managedCount} managed` : "none managed"})`;
}

/**
 * The Used by cell: direct nodes, then node groups as a count, so one long
 * name cannot widen the column; the names go in the cell's title.
 * "3 nodes", "3 nodes · node group web", "1 node · 2 node groups".
 */
export function usedByLabel(direct: number, through: readonly string[], nodeGroupsUnknown = false): string {
  const parts = direct || (!through.length && !nodeGroupsUnknown) ? [count(direct, "node", "nodes")] : [];
  if (through.length === 1) parts.push(`node group ${through[0]}`);
  else if (through.length > 1) parts.push(count(through.length, "node group", "node groups"));
  if (nodeGroupsUnknown) parts.push("node groups not read");
  return parts.join(" · ");
}

/**
 * Why a security group cannot be deleted yet, or undefined: NetGuard refuses
 * the delete while a node or a node group binds it.
 */
export function deleteBlockedReason(direct: number, through: readonly string[]): string | undefined {
  const holders: string[] = [];
  if (direct) holders.push(count(direct, "node", "nodes"));
  if (through.length) holders.push(`${through.length === 1 ? "node group" : "node groups"} ${through.join(", ")}`);
  if (!holders.length) return undefined;
  return `Bound to ${holders.join(" and ")}; detach it there first`;
}

/** The node groups that bind each security group, by security group id, names sorted. */
export function nodeGroupsBySecurityGroup(bindings: readonly NodeGroupBinding[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const binding of bindings) {
    for (const id of binding.security_group_ids) {
      const names = out.get(id) ?? [];
      names.push(binding.group_name || binding.group_id);
      out.set(id, names);
    }
  }
  for (const names of out.values()) names.sort((a, b) => a.localeCompare(b));
  return out;
}

/** The security groups a binding may add: stored ones that are not a node's adopted baseline, minus those already listed. */
export function bindableGroups(groups: readonly SecurityGroup[], listed: readonly string[]): SecurityGroup[] {
  return groups
    .filter((group) => group.source !== "legacy" && !group.id.startsWith(LEGACY_GROUP_PREFIX) && !listed.includes(group.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The node groups that bind no security group, for a new binding. A stored
 * binding whose list is empty counts as unbound; saving over it carries its
 * version (storedVersion).
 */
export function unboundNodeGroups(choices: readonly NodeGroupChoice[], bindings: readonly NodeGroupBinding[]): NodeGroupChoice[] {
  const bound = new Set(bindings.filter((binding) => binding.security_group_ids.length).map((binding) => binding.group_id));
  return choices.filter((choice) => !bound.has(choice.id));
}

/** The version a write for groupId must carry: its stored binding's, even an empty one, or 0. */
export function storedVersion(bindings: readonly NodeGroupBinding[], groupId: string): number {
  return bindings.find((binding) => binding.group_id === groupId)?.version ?? 0;
}

/** The list with the item at `index` moved by `delta`, or the list unchanged at an edge. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  const out = [...list];
  if (index < 0 || index >= out.length || target < 0 || target >= out.length) return out;
  const [item] = out.splice(index, 1);
  out.splice(target, 0, item!);
  return out;
}

/** A group in a plan's words: "web", "web via node group edge". */
export function planGroupLabel(ref: PlanGroupRef): string {
  const name = ref.name || ref.id;
  if (!ref.via_node_group) return name;
  return `${name} via node group ${ref.via_node_group.name || ref.via_node_group.id}`;
}

/** The plan's outcome in one sentence, counting each list. */
export function planHeadline(result: NodeGroupPlanResult): string {
  const parts: string[] = [];
  if (result.affected.length) parts.push(`planned ${count(result.affected.length, "node", "nodes")}`);
  if (result.conflicts.length) parts.push(`could not plan ${count(result.conflicts.length, "node", "nodes")}`);
  if (result.unchanged.length) parts.push(count(result.unchanged.length, "node already matches", "nodes already match"));
  if (result.inactive.length) parts.push(`${count(result.inactive.length, "member is", "members are")} not managed`);
  if (!parts.length) return "Nothing to plan: no managed node derives a group from these bindings.";
  const sentence = parts.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
}

/** What the plan leaves to the operator: nothing changes on a node until its approval is approved. */
export function planFollowUp(result: NodeGroupPlanResult): string {
  if (!result.affected.length) return "";
  return result.affected.length === 1
    ? "The node keeps its current rules until its approval is approved in Approvals."
    : "Each node keeps its current rules until its approval is approved in Approvals.";
}
