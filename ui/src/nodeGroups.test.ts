import { describe, expect, it } from "vitest";

import type { NodeGroupBinding, NodeGroupPlanResult, SecurityGroup } from "./netguardModel";
import {
  bindableGroups,
  membersLine,
  moveItem,
  nodeGroupsBySecurityGroup,
  planFollowUp,
  planGroupLabel,
  planHeadline,
  unboundNodeGroups,
} from "./nodeGroups";

function binding(over: Partial<NodeGroupBinding>): NodeGroupBinding {
  return { group_id: "grp_web", group_name: "web", security_group_ids: [], version: 1, members: [], ...over };
}

function group(id: string, name: string, over: Partial<SecurityGroup> = {}): SecurityGroup {
  return { id, name, rules: [], version: 1, ...over };
}

describe("node group bindings", () => {
  it("counts compiled and unmanaged members", () => {
    expect(membersLine(binding({}))).toBe("no members");
    expect(membersLine(binding({ members: [
      { node_id: "a", state: "active" },
      { node_id: "b", state: "active" },
      { node_id: "c", state: "inactive", reason: "group binding inactive: node not managed" },
    ] }))).toBe("2 compiled, 1 not managed");
    expect(membersLine(binding({ members: [{ node_id: "c", state: "inactive" }] }))).toBe("1 not managed");
  });

  it("names the node groups that bind each security group", () => {
    const by = nodeGroupsBySecurityGroup([
      binding({ group_id: "grp_web", group_name: "web", security_group_ids: ["sg-ssh", "sg-web"] }),
      binding({ group_id: "grp_edge", group_name: "edge", security_group_ids: ["sg-ssh"] }),
    ]);
    expect(by.get("sg-ssh")).toEqual(["edge", "web"]);
    expect(by.get("sg-web")).toEqual(["web"]);
    expect(by.has("sg-db")).toBe(false);
  });

  // A node's adopted baseline is that node's alone; binding it to a node
  // group would copy one machine's ports onto every member.
  it("offers stored groups that are not listed and not a node's baseline", () => {
    const groups = [group("sg-web", "web"), group("sg-legacy-tokyo", "tokyo baseline"), group("sg-ssh", "ssh"), group("cd-nas", "nas", { source: "legacy" })];
    expect(bindableGroups(groups, ["sg-web"]).map((g) => g.id)).toEqual(["sg-ssh"]);
  });

  it("lists node groups without a binding for a new one", () => {
    const choices = [{ id: "grp_web", name: "web", members: [] }, { id: "grp_edge", name: "edge", members: [] }, { id: "grp_db", name: "db", members: [] }];
    const bindings = [binding({ group_id: "grp_web", security_group_ids: ["sg-web"] }), binding({ group_id: "grp_db", security_group_ids: [] })];
    expect(unboundNodeGroups(choices, bindings).map((c) => c.id)).toEqual(["grp_edge", "grp_db"]);
  });

  // Position is meaning: the first deny turns off the fast path.
  it("moves an item one place and leaves the edges alone", () => {
    expect(moveItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("says what a plan did and what is left to do", () => {
    const empty: NodeGroupPlanResult = { affected: [], unchanged: [], conflicts: [], inactive: [] };
    expect(planHeadline(empty)).toContain("Nothing to plan");
    expect(planFollowUp(empty)).toBe("");
    const result: NodeGroupPlanResult = {
      affected: [{ node_id: "a", approval_id: "apr_1", added: [], removed: [], order: [] }, { node_id: "b", approval_id: "apr_2", added: [], removed: [], order: [] }],
      unchanged: [{ node_id: "c", reason: "matches its last apply" }],
      conflicts: [{ node_id: "d", reason: "compile failed" }],
      inactive: [{ node_id: "e", reason: "group binding inactive: node not managed" }],
    };
    expect(planHeadline(result)).toBe("Planned 2 nodes, could not plan 1 node, 1 node already matches, 1 member is not managed.");
    expect(planFollowUp(result)).toContain("Each node keeps its current rules");
  });

  it("labels a derived group with the node group it comes through", () => {
    expect(planGroupLabel({ id: "sg-web", name: "web" })).toBe("web");
    expect(planGroupLabel({ id: "sg-web", name: "web", via_node_group: { id: "grp_edge", name: "edge" } })).toBe("web via node group edge");
    expect(planGroupLabel({ id: "sg-web", via_node_group: { id: "grp_edge" } })).toBe("sg-web via node group grp_edge");
  });
});
