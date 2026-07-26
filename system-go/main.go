// Command lattice-plugin-netguard is the official LatticeNet netguard system
// plugin: security-group-grade firewall control (zones, reusable security
// groups, per-node bindings, reality-first authoring, and drift detection).
//
// It implements the Lattice system-plugin stdio contract: newline-delimited
// JSON {action,payload} on stdin, {ok,plan,message,result,error} on stdout. The
// Lattice system runner executes this artifact for the plugin lifecycle
// (describe/health/plan).
//
// The engine stays in lattice-server (ADR-001 D5/D6, design-13 D2): the
// compiler, the approval flow, the plan-hash binding, the dead-man watchdog,
// and the node task executor are core. This subprocess never mutates a host —
// host changes flow through the in-core plan->approve->apply pipeline and the
// node agent. This plugin is the officially-maintained, signed, registered
// front for that capability surface, and it owns the domain's dashboard
// information architecture.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	latticeplugin "github.com/LatticeNet/lattice-sdk/plugin"
)

const (
	pluginID      = "latticenet.netguard"
	pluginName    = "NetGuard (nftables security groups)"
	pluginVersion = "0.1.0-alpha.7"
)

// capabilities mirrors the manifest. netguard:read/netguard:admin are core RBAC
// scopes enforced by the in-core engine, not plugin capabilities, so they are
// declared on the manifest's interfaces rather than here.
var capabilities = []string{"node:read", "network:plan", "network:apply", "task:run"}

type request = latticeplugin.Request
type response = latticeplugin.Response

func main() {
	_ = latticeplugin.Serve(context.Background(), latticeplugin.HandlerFunc(
		func(_ context.Context, req latticeplugin.Request, _ *latticeplugin.HostClient) latticeplugin.Response {
			return handle(req)
		},
	))
}

func handle(req request) response {
	switch req.Action {
	case latticeplugin.ActionDescribe:
		body, _ := json.Marshal(map[string]any{
			"id":           pluginID,
			"name":         pluginName,
			"version":      pluginVersion,
			"capabilities": capabilities,
			"manages": []string{
				"guard zones (trusted interfaces and CIDRs, incl. overlay zones)",
				"reusable security groups with port ranges and cidr/node/group/zone remotes",
				"per-node bindings composing zones, overrides, and attached groups",
				"reality-first authoring: listener + live-ruleset reporting, suggestions, drift",
				"pre-plan lockout linting before a policy-drop ruleset reaches a node",
			},
			"engine": "lattice-server (core); this plugin is the official front",
			"safety": []string{
				"the single `table inet lattice_guard` renderer stays core",
				"apply is validate -> snapshot -> dead-man watchdog -> commit -> selfcheck",
				"this subprocess never mutates a host",
			},
		})
		return latticeplugin.RawResultResponse(body, "netguard capability surface")
	case latticeplugin.ActionHealth:
		return latticeplugin.MessageResponse("netguard plugin healthy")
	case latticeplugin.ActionPlan:
		payload, err := payloadMap(req.Payload)
		if err != nil {
			return latticeplugin.ErrorResponse(err)
		}
		return latticeplugin.PlanResponse(renderPlan(payload), "netguard dry-run plan")
	default:
		return latticeplugin.ErrorResponse(fmt.Errorf("unsupported action %q", req.Action))
	}
}

func payloadMap(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("invalid payload: %w", err)
	}
	if payload == nil {
		payload = map[string]any{}
	}
	return payload, nil
}

// renderPlan summarizes, as an auditable dry-run, what a netguard apply would
// do for the given payload. It never mutates a host: the real ruleset is
// compiled in core by internal/netguard, linted for lockout risk, bound to an
// approval by plan_sha256, and applied by the node agent under a dead-man
// watchdog.
func renderPlan(payload map[string]any) string {
	lines := []string{"# netguard plan (dry run — no host changes made here)"}
	keys := make([]string, 0, len(payload))
	for k := range payload {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		lines = append(lines, fmt.Sprintf("# %s = %v", k, payload[k]))
	}
	lines = append(lines,
		"# the authoritative lattice_guard ruleset is compiled in core (internal/netguard),",
		"# linted for management-path lockout, then applied via plan->approve->apply.")
	return strings.Join(lines, "\n")
}
