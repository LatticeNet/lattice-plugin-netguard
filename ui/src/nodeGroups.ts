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

/** "2 compiled, 1 not managed", "no members". */
export function membersLine(binding: NodeGroupBinding): string {
  const active = binding.members.filter((member) => member.state === "active").length;
  const inactive = binding.members.length - active;
  if (!binding.members.length) return "no members";
  const parts = [];
  if (active) parts.push(`${active} compiled`);
  if (inactive) parts.push(`${inactive} not managed`);
  return parts.join(", ");
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

/** The node groups that have no binding yet, for a new one; sorted by name. */
export function unboundNodeGroups(choices: readonly NodeGroupChoice[], bindings: readonly NodeGroupBinding[]): NodeGroupChoice[] {
  const bound = new Set(bindings.filter((binding) => binding.security_group_ids.length).map((binding) => binding.group_id));
  return choices.filter((choice) => !bound.has(choice.id));
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
