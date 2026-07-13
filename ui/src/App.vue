<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import {
  Boxes,
  CheckCircle2,
  CircleAlert,
  FileCode2,
  LoaderCircle,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  Trash2,
  X,
} from "@lucide/vue";

import { BridgeClient, canCall, type HostInit } from "./bridge";
import {
  buildRemote,
  formatRanges,
  parseRanges,
  remoteValue,
  safeErrorMessage,
  type GuardNode,
  type GuardRule,
  type GuardZone,
  type NodeBinding,
  type Overview,
  type SecurityGroup,
} from "./netguardModel";

const SERVICE = "latticenet.netguard/firewall";
const init = ref<HostInit>();
const overview = ref<Overview>({ nodes: [], groups: [], zones: [] });
const activeTab = ref<"nodes" | "groups" | "zones">("nodes");
const loading = ref(true);
const refreshing = ref(false);
const error = ref("");
const notice = ref("");
const bootError = ref("");

let bridge: BridgeClient | undefined;
try {
  bridge = new BridgeClient(window);
  bridge.init.then(async (value) => {
    init.value = value;
    await refresh();
  }).catch((cause) => {
    bootError.value = safeErrorMessage(cause, "Plugin host unavailable");
    loading.value = false;
  });
} catch (cause) {
  bootError.value = safeErrorMessage(cause, "Plugin host unavailable");
  loading.value = false;
}

const canAdmin = computed(() => ["upsert_group", "delete_group", "upsert_zone", "delete_zone", "upsert_binding", "adopt"].every((method) => canCall(init.value, SERVICE, method)));
const canPlan = computed(() => canCall(init.value, SERVICE, "plan"));
const managedNodes = computed(() => overview.value.nodes.filter((node) => node.binding.managed).length);
const legacyNodes = computed(() => overview.value.nodes.filter((node) => node.source === "legacy").length);
const ruleCount = computed(() => overview.value.groups.reduce((sum, group) => sum + (group.rules?.length ?? 0), 0));
const customZones = computed(() => overview.value.zones.filter((zone) => !zone.builtin).length);

async function call<T>(method: string, payload: unknown = {}): Promise<T> {
  if (!bridge || !canCall(init.value, SERVICE, method)) throw new Error(`Method ${method} is not available for this session`);
  return bridge.call<T>(SERVICE, method, payload).promise;
}

async function refresh(background = false): Promise<void> {
  if (!init.value) return;
  if (background) refreshing.value = true;
  else loading.value = true;
  error.value = "";
  try {
    overview.value = await call<Overview>("overview");
  } catch (cause) {
    error.value = safeErrorMessage(cause, "NetGuard overview could not be loaded");
  } finally {
    loading.value = false;
    refreshing.value = false;
    await resize();
  }
}

type EditableRule = GuardRule & { portsText: string; remoteValue: string };
const groupDialogOpen = ref(false);
const groupSaving = ref(false);
const groupForm = reactive<{ id: string; name: string; description: string; version: number; rules: EditableRule[] }>({ id: "", name: "", description: "", version: 0, rules: [] });

function blankRule(): EditableRule {
  return {
    id: `rule-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    action: "allow", direction: "ingress", protocol: "tcp", ports: [], portsText: "",
    remote: { kind: "any" }, remoteValue: "", comment: "", disabled: false,
  };
}

function openGroup(group?: SecurityGroup): void {
  groupForm.id = group?.id ?? "";
  groupForm.name = group?.name ?? "";
  groupForm.description = group?.description ?? "";
  groupForm.version = group?.version ?? 0;
  groupForm.rules = (group?.rules ?? [blankRule()]).map((rule) => ({
    ...rule,
    ports: rule.ports ?? [],
    portsText: formatRanges(rule.ports),
    remote: rule.remote ?? { kind: "any" },
    remoteValue: remoteValue(rule.remote ?? { kind: "any" }),
  }));
  groupDialogOpen.value = true;
}

async function saveGroup(): Promise<void> {
  if (!groupForm.name.trim() || groupSaving.value) return;
  groupSaving.value = true;
  error.value = "";
  try {
    const rules: GuardRule[] = groupForm.rules.map((rule) => ({
      id: rule.id.trim() || `rule-${Date.now()}`,
      comment: rule.comment?.trim(), action: rule.action, direction: rule.direction,
      protocol: rule.protocol, ports: parseRanges(rule.portsText),
      remote: buildRemote(rule.remote.kind, rule.remoteValue), disabled: rule.disabled,
    }));
    await call("upsert_group", {
      id: groupForm.id.trim(), name: groupForm.name.trim(), description: groupForm.description.trim(),
      version: groupForm.version, rules,
    });
    notice.value = `Security group ${groupForm.name.trim()} saved`;
    groupDialogOpen.value = false;
    await refresh(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Security group could not be saved");
  } finally {
    groupSaving.value = false;
  }
}

const zoneDialogOpen = ref(false);
const zoneSaving = ref(false);
const zoneForm = reactive({ id: "", name: "", description: "", interfaces: "", cidrs: "" });
function openZone(zone?: GuardZone): void {
  Object.assign(zoneForm, {
    id: zone?.id ?? "", name: zone?.name ?? "", description: zone?.description ?? "",
    interfaces: (zone?.interfaces ?? []).join(", "), cidrs: (zone?.cidrs ?? []).join(", "),
  });
  zoneDialogOpen.value = true;
}
function splitList(value: string): string[] { return [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))]; }
async function saveZone(): Promise<void> {
  if (!zoneForm.id.trim() || !zoneForm.name.trim() || zoneSaving.value) return;
  zoneSaving.value = true;
  try {
    await call("upsert_zone", {
      id: zoneForm.id.trim(), name: zoneForm.name.trim(), description: zoneForm.description.trim(),
      interfaces: splitList(zoneForm.interfaces), cidrs: splitList(zoneForm.cidrs),
    });
    notice.value = `Zone ${zoneForm.name.trim()} saved`;
    zoneDialogOpen.value = false;
    await refresh(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Zone could not be saved");
  } finally {
    zoneSaving.value = false;
  }
}

const bindingNode = ref<GuardNode>();
const bindingSaving = ref(false);
const bindingForm = reactive<{ groups: string[]; zones: string[]; managed: boolean; version: number }>({ groups: [], zones: [], managed: true, version: 0 });
function openBinding(node: GuardNode): void {
  bindingNode.value = node;
  bindingForm.groups = [...(node.binding.group_ids ?? [])];
  bindingForm.zones = [...(node.binding.zone_ids ?? [])];
  bindingForm.managed = node.binding.managed;
  bindingForm.version = node.binding.version;
}
function toggleSelection(values: string[], id: string, checked: boolean): void {
  const next = new Set(values);
  if (checked) next.add(id); else next.delete(id);
  values.splice(0, values.length, ...next);
}
async function saveBinding(): Promise<void> {
  if (!bindingNode.value || bindingSaving.value) return;
  bindingSaving.value = true;
  try {
    await call("upsert_binding", {
      node_id: bindingNode.value.node_id, group_ids: bindingForm.groups, zone_ids: bindingForm.zones,
      managed: bindingForm.managed, version: bindingForm.version, overrides: bindingNode.value.binding.overrides ?? [],
    });
    notice.value = `${bindingNode.value.node_name || bindingNode.value.node_id} binding saved`;
    bindingNode.value = undefined;
    await refresh(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Node binding could not be saved");
  } finally {
    bindingSaving.value = false;
  }
}

async function adopt(node: GuardNode): Promise<void> {
  try {
    await call("adopt", { node_id: node.node_id });
    notice.value = `${node.node_name || node.node_id} adopted into NetGuard`;
    await refresh(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Legacy baseline could not be adopted");
  }
}

interface Finding { code: string; severity: string; message: string }
interface Approval { id: string; node_id: string; plugin: string; action: string; plan: string; status: string; created_at?: string }
const planNode = ref<GuardNode>();
const acceptLockoutRisk = ref(false);
const planning = ref(false);
const planResult = ref<{ approval: Approval; findings: Finding[] }>();
async function createPlan(): Promise<void> {
  if (!planNode.value || planning.value) return;
	planning.value = true;
	try {
		const result = await call<{ approval: Approval; findings: Finding[] }>("plan", { node_id: planNode.value.node_id, accept_lockout_risk: acceptLockoutRisk.value });
		planResult.value = result;
		notice.value = `Approval ${result.approval.id} created`;
    planNode.value = undefined;
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Plan was blocked or could not be created");
  } finally {
    planning.value = false;
    await resize();
  }
}

const deleteTarget = ref<{ type: "group" | "zone"; id: string; label: string }>();
async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  try {
    await call(deleteTarget.value.type === "group" ? "delete_group" : "delete_zone", { id: deleteTarget.value.id });
    notice.value = `${deleteTarget.value.label} deleted`;
    deleteTarget.value = undefined;
    await refresh(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Object could not be deleted; it may still be referenced by a node");
  }
}

function groupNames(binding: NodeBinding): string { return binding.group_ids?.map((id) => overview.value.groups.find((group) => group.id === id)?.name ?? id).join(", ") || "None"; }
function zoneNames(binding: NodeBinding): string { return binding.zone_ids?.map((id) => overview.value.zones.find((zone) => zone.id === id)?.name ?? id).join(", ") || "None"; }
function remoteLabel(rule: GuardRule): string { const value = remoteValue(rule.remote); return value ? `${rule.remote.kind}:${value}` : rule.remote.kind; }

async function resize(): Promise<void> { await nextTick(); bridge?.resize(document.documentElement.scrollHeight); }
let observer: ResizeObserver | undefined;
let poller: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  observer = new ResizeObserver(() => { void resize(); });
  observer.observe(document.body);
  poller = setInterval(() => { if (!loading.value && !groupDialogOpen.value && !zoneDialogOpen.value && !bindingNode.value && !planNode.value) void refresh(true); }, 20_000);
  void resize();
});
onBeforeUnmount(() => { observer?.disconnect(); if (poller) clearInterval(poller); bridge?.dispose(); });
</script>

<template>
  <main class="workspace">
    <header class="page-header">
      <div class="title-mark"><Shield :size="19" /></div>
      <div class="title-copy"><div class="title-line"><h1>NetGuard</h1><span class="plugin-label">nftables plugin</span></div><p>Security groups, trusted zones and per-node default-drop policy.</p></div>
      <button class="button secondary" type="button" :disabled="loading || refreshing" @click="refresh(true)"><LoaderCircle v-if="refreshing" class="spin" :size="15" /><RefreshCw v-else :size="15" />Refresh</button>
    </header>

    <div v-if="bootError || error" class="alert" role="alert"><CircleAlert :size="17" /><span>{{ bootError || error }}</span><button class="icon-button" type="button" aria-label="Dismiss error" @click="error = ''; bootError = ''"><X :size="15" /></button></div>
    <div v-if="notice" class="alert success" aria-live="polite"><CheckCircle2 :size="17" /><span>{{ notice }}</span><button class="icon-button" type="button" aria-label="Dismiss notice" @click="notice = ''"><X :size="15" /></button></div>

    <section class="summary-strip"><div><span>Visible nodes</span><strong>{{ overview.nodes.length }}</strong></div><div><span>Managed</span><strong>{{ managedNodes }}</strong></div><div><span>Security rules</span><strong>{{ ruleCount }}</strong></div><div><span>Custom zones</span><strong>{{ customZones }}</strong></div></section>

    <div class="tabbar" role="tablist" aria-label="NetGuard workspace"><button type="button" :aria-selected="activeTab === 'nodes'" @click="activeTab = 'nodes'"><Network :size="15" />Nodes <span>{{ overview.nodes.length }}</span></button><button type="button" :aria-selected="activeTab === 'groups'" @click="activeTab = 'groups'"><Boxes :size="15" />Security groups <span>{{ overview.groups.length }}</span></button><button type="button" :aria-selected="activeTab === 'zones'" @click="activeTab = 'zones'"><ShieldCheck :size="15" />Trusted zones <span>{{ overview.zones.length }}</span></button></div>

    <div v-if="loading" class="loading-state"><LoaderCircle class="spin" :size="20" />Loading firewall state</div>

    <template v-else-if="activeTab === 'nodes'">
      <section v-if="legacyNodes" class="advisory"><CircleAlert :size="17" /><div><strong>{{ legacyNodes }} legacy baseline{{ legacyNodes === 1 ? '' : 's' }}</strong><p>Legacy records remain observe-only until explicitly adopted. Planning is disabled for unmanaged nodes.</p></div></section>
      <section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Node</th><th>Authority</th><th>Security groups</th><th>Trusted zones</th><th>Drift anchor</th><th class="actions">Actions</th></tr></thead><tbody><tr v-for="node in overview.nodes" :key="node.node_id"><td><strong>{{ node.node_name || node.node_id }}</strong><small>{{ node.node_id }}</small></td><td><span class="status" :data-tone="node.binding.managed ? 'healthy' : 'warning'">{{ node.binding.managed ? 'managed' : 'observe only' }}</span><small>{{ node.source }}</small></td><td>{{ groupNames(node.binding) }}</td><td>{{ zoneNames(node.binding) }}</td><td class="mono">{{ node.binding.applied_table_sha ? node.binding.applied_table_sha.slice(0, 12) : 'not applied' }}<small v-if="node.binding.last_error" class="error-text">{{ node.binding.last_error }}</small></td><td class="actions"><div class="action-row"><button v-if="node.source === 'legacy' && canAdmin" class="button secondary compact" type="button" @click="adopt(node)">Adopt</button><button v-if="canAdmin && node.source !== 'legacy'" class="icon-button bordered" type="button" aria-label="Edit binding" title="Edit binding" @click="openBinding(node)"><Pencil :size="14" /></button><button v-if="canPlan && node.binding.managed" class="icon-button bordered primary-icon" type="button" aria-label="Create plan" title="Create plan" @click="planNode = node; acceptLockoutRisk = false"><Play :size="14" /></button></div></td></tr></tbody></table></div><div v-if="!overview.nodes.length" class="empty-state"><Network :size="28" /><strong>No firewall baselines</strong><span>Node guard state appears after a baseline or binding is created.</span></div></section>
    </template>

    <template v-else-if="activeTab === 'groups'">
      <section class="toolbar"><div><h2>Reusable security groups</h2><p>Ordered ingress and egress rules attach to one or more nodes.</p></div><button v-if="canAdmin" class="button primary" type="button" @click="openGroup()"><Plus :size="15" />New group</button></section>
      <section class="object-grid"><article v-for="group in overview.groups" :key="group.id" class="object-panel"><header><div><h3>{{ group.name }}</h3><p>{{ group.description || group.id }}</p></div><span class="source">{{ group.source || 'stored' }}</span></header><div class="rule-list"><div v-for="rule in group.rules" :key="rule.id" class="rule-row" :data-disabled="rule.disabled"><span class="rule-action" :data-tone="rule.action">{{ rule.action }}</span><strong>{{ rule.direction }} / {{ rule.protocol }}</strong><span class="mono">{{ formatRanges(rule.ports) || 'all ports' }}</span><span>{{ remoteLabel(rule) }}</span><small>{{ rule.comment || rule.id }}</small></div><p v-if="!group.rules.length" class="empty-inline">No rules. The base policy remains default-drop.</p></div><footer><span>v{{ group.version }} / {{ group.rules.length }} rules</span><div v-if="canAdmin" class="action-row"><button class="icon-button bordered" type="button" aria-label="Edit group" title="Edit group" @click="openGroup(group)"><Pencil :size="14" /></button><button class="icon-button bordered destructive" type="button" aria-label="Delete group" title="Delete group" @click="deleteTarget = { type: 'group', id: group.id, label: group.name }"><Trash2 :size="14" /></button></div></footer></article></section>
      <div v-if="!overview.groups.length" class="empty-state standalone"><Boxes :size="28" /><strong>No security groups</strong><span>Create a reusable rule set, then attach it to a managed node.</span></div>
    </template>

    <template v-else>
      <section class="toolbar"><div><h2>Trusted zones</h2><p>Interfaces and CIDRs accepted before security-group evaluation.</p></div><button v-if="canAdmin" class="button primary" type="button" @click="openZone()"><Plus :size="15" />New zone</button></section>
      <section class="zone-grid"><article v-for="zone in overview.zones" :key="zone.id" class="zone-row"><div class="zone-icon"><ShieldCheck :size="17" /></div><div><h3>{{ zone.name }}</h3><p>{{ zone.description || zone.id }}</p></div><div><span>Interfaces</span><strong class="mono">{{ zone.interfaces?.join(', ') || 'resolved per node' }}</strong></div><div><span>CIDRs</span><strong class="mono">{{ zone.cidrs?.join(', ') || 'resolved per node' }}</strong></div><span class="source">{{ zone.builtin ? 'built-in' : 'custom' }}</span><div v-if="canAdmin && !zone.builtin" class="action-row"><button class="icon-button bordered" type="button" aria-label="Edit zone" title="Edit zone" @click="openZone(zone)"><Pencil :size="14" /></button><button class="icon-button bordered destructive" type="button" aria-label="Delete zone" title="Delete zone" @click="deleteTarget = { type: 'zone', id: zone.id, label: zone.name }"><Trash2 :size="14" /></button></div></article></section>
    </template>

    <div v-if="groupDialogOpen" class="modal-backdrop" @mousedown.self="groupDialogOpen = false"><section class="modal wide" role="dialog" aria-modal="true"><header><div><h2>{{ groupForm.version ? 'Edit security group' : 'New security group' }}</h2><p>Rules are evaluated in order after trusted zones and node overrides.</p></div><button class="icon-button" type="button" aria-label="Close" @click="groupDialogOpen = false"><X :size="17" /></button></header><div class="form-grid"><label class="field"><span>Group ID</span><input v-model="groupForm.id" type="text" :disabled="groupForm.version > 0" placeholder="sg-web" /></label><label class="field"><span>Name</span><input v-model="groupForm.name" type="text" /></label><label class="field wide-field"><span>Description</span><input v-model="groupForm.description" type="text" /></label></div><div class="rule-editor"><header><div><h3>Ordered rules</h3><p>Empty ports means all ports for the selected protocol.</p></div><button class="button secondary compact" type="button" @click="groupForm.rules.push(blankRule())"><Plus :size="14" />Add rule</button></header><div v-for="(rule, index) in groupForm.rules" :key="rule.id" class="rule-edit-row"><span class="order">{{ index + 1 }}</span><label><span>Action</span><select v-model="rule.action"><option value="allow">Allow</option><option value="deny">Deny</option></select></label><label><span>Direction</span><select v-model="rule.direction"><option value="ingress">Ingress</option><option value="egress">Egress</option></select></label><label><span>Protocol</span><select v-model="rule.protocol"><option v-for="protocol in ['tcp','udp','icmp','icmpv6','any']" :key="protocol" :value="protocol">{{ protocol }}</option></select></label><label><span>Ports</span><input v-model="rule.portsText" type="text" placeholder="22, 443, 9009-9013" /></label><label><span>Remote</span><select v-model="rule.remote.kind"><option v-for="kind in ['any','zone','cidr','node','group','domain']" :key="kind" :value="kind">{{ kind }}</option></select></label><label><span>Remote value</span><input v-model="rule.remoteValue" type="text" :disabled="rule.remote.kind === 'any'" /></label><label class="comment"><span>Comment</span><input v-model="rule.comment" type="text" /></label><label class="check"><input v-model="rule.disabled" type="checkbox" /><span>Disabled</span></label><button class="icon-button destructive" type="button" aria-label="Remove rule" title="Remove rule" @click="groupForm.rules.splice(index, 1)"><Trash2 :size="14" /></button></div></div><footer><button class="button secondary" type="button" @click="groupDialogOpen = false">Cancel</button><button class="button primary" type="button" :disabled="groupSaving || !groupForm.name.trim()" @click="saveGroup"><LoaderCircle v-if="groupSaving" class="spin" :size="15" />Save group</button></footer></section></div>

    <div v-if="zoneDialogOpen" class="modal-backdrop" @mousedown.self="zoneDialogOpen = false"><section class="modal" role="dialog" aria-modal="true"><header><div><h2>{{ overview.zones.some((zone) => zone.id === zoneForm.id) ? 'Edit zone' : 'New trusted zone' }}</h2><p>At least one interface or CIDR is required.</p></div><button class="icon-button" type="button" aria-label="Close" @click="zoneDialogOpen = false"><X :size="17" /></button></header><div class="form-grid"><label class="field"><span>Zone ID</span><input v-model="zoneForm.id" type="text" placeholder="tailscale" /></label><label class="field"><span>Name</span><input v-model="zoneForm.name" type="text" /></label><label class="field wide-field"><span>Interfaces</span><input v-model="zoneForm.interfaces" type="text" placeholder="tailscale0, wg0" /></label><label class="field wide-field"><span>CIDRs</span><input v-model="zoneForm.cidrs" type="text" placeholder="100.64.0.0/10, fd7a:115c:a1e0::/48" /></label><label class="field wide-field"><span>Description</span><input v-model="zoneForm.description" type="text" /></label></div><footer><button class="button secondary" type="button" @click="zoneDialogOpen = false">Cancel</button><button class="button primary" type="button" :disabled="zoneSaving || !zoneForm.id.trim() || !zoneForm.name.trim()" @click="saveZone">Save zone</button></footer></section></div>

    <div v-if="bindingNode" class="modal-backdrop" @mousedown.self="bindingNode = undefined"><section class="modal" role="dialog" aria-modal="true"><header><div><h2>Node binding</h2><p>{{ bindingNode.node_name || bindingNode.node_id }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="bindingNode = undefined"><X :size="17" /></button></header><div class="binding-editor"><label class="managed-toggle"><input v-model="bindingForm.managed" type="checkbox" /><span><strong>Managed by NetGuard</strong><small>Only managed bindings can produce an apply plan.</small></span></label><fieldset><legend>Security groups</legend><label v-for="group in overview.groups" :key="group.id"><input type="checkbox" :checked="bindingForm.groups.includes(group.id)" @change="toggleSelection(bindingForm.groups, group.id, ($event.target as HTMLInputElement).checked)" /><span>{{ group.name }}<small>{{ group.rules.length }} rules</small></span></label></fieldset><fieldset><legend>Trusted zones</legend><label v-for="zone in overview.zones.filter((item) => item.id !== 'public' && item.id !== 'loopback')" :key="zone.id"><input type="checkbox" :checked="bindingForm.zones.includes(zone.id)" @change="toggleSelection(bindingForm.zones, zone.id, ($event.target as HTMLInputElement).checked)" /><span>{{ zone.name }}<small>{{ zone.interfaces?.join(', ') || zone.cidrs?.join(', ') || 'resolved per node' }}</small></span></label></fieldset></div><footer><button class="button secondary" type="button" @click="bindingNode = undefined">Cancel</button><button class="button primary" type="button" :disabled="bindingSaving" @click="saveBinding">Save binding</button></footer></section></div>

    <div v-if="planNode" class="modal-backdrop" @mousedown.self="planNode = undefined"><section class="modal" role="dialog" aria-modal="true"><header><div><h2>Create nftables plan</h2><p>{{ planNode.node_name || planNode.node_id }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="planNode = undefined"><X :size="17" /></button></header><div class="plan-warning"><CircleAlert :size="18" /><div><strong>Default-drop policy</strong><p>The server compiles and lints the full `table inet lattice_guard` ruleset. This action creates a pending approval; it does not apply changes.</p></div></div><label class="risk-toggle"><input v-model="acceptLockoutRisk" type="checkbox" /><span><strong>Allow a plan with blocking management-path findings</strong><small>Acceptance is audited. Review SSH and overlay access before approval.</small></span></label><footer><button class="button secondary" type="button" @click="planNode = undefined">Cancel</button><button class="button primary" type="button" :disabled="planning" @click="createPlan"><LoaderCircle v-if="planning" class="spin" :size="15" /><FileCode2 v-else :size="15" />Compile plan</button></footer></section></div>

    <div v-if="planResult" class="modal-backdrop" @mousedown.self="planResult = undefined"><section class="modal wide plan-review" role="dialog" aria-modal="true"><header><div><h2>Plan ready for approval</h2><p>{{ planResult.approval.id }} / {{ planResult.approval.status }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="planResult = undefined"><X :size="17" /></button></header><div v-if="planResult.findings?.length" class="findings"><div v-for="finding in planResult.findings" :key="finding.code" :data-tone="finding.severity"><strong>{{ finding.severity }} / {{ finding.code }}</strong><p>{{ finding.message }}</p></div></div><pre>{{ planResult.approval.plan }}</pre><footer><button class="button primary" type="button" @click="planResult = undefined">Done</button></footer></section></div>

    <div v-if="deleteTarget" class="modal-backdrop" @mousedown.self="deleteTarget = undefined"><section class="modal small" role="alertdialog" aria-modal="true"><header><div><h2>Delete {{ deleteTarget.type }}</h2><p>Attached objects must be removed from node bindings first.</p></div></header><p class="confirm-copy">Delete <strong>{{ deleteTarget.label }}</strong>?</p><footer><button class="button secondary" type="button" @click="deleteTarget = undefined">Cancel</button><button class="button danger" type="button" @click="confirmDelete"><Trash2 :size="15" />Delete</button></footer></section></div>
  </main>
</template>
