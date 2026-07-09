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
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

const (
	pluginID      = "latticenet.netguard"
	pluginName    = "NetGuard (nftables security groups)"
	pluginVersion = "0.1.0-alpha.3"
)

// capabilities mirrors the manifest. netguard:read/netguard:admin are core RBAC
// scopes enforced by the in-core engine, not plugin capabilities, so they are
// declared on the manifest's interfaces rather than here.
var capabilities = []string{"node:read", "network:plan", "network:apply", "task:run"}

type request struct {
	Action  string         `json:"action"`
	Payload map[string]any `json:"payload"`
}

type response struct {
	OK      bool            `json:"ok"`
	Plan    string          `json:"plan,omitempty"`
	Message string          `json:"message,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			write(response{OK: false, Error: "invalid request: " + err.Error()})
			continue
		}
		write(handle(req))
	}
}

func handle(req request) response {
	switch req.Action {
	case "describe":
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
		return response{OK: true, Result: body, Message: "netguard capability surface"}
	case "health":
		return response{OK: true, Message: "netguard plugin healthy"}
	case "plan":
		return response{OK: true, Plan: renderPlan(req.Payload), Message: "netguard dry-run plan"}
	default:
		return response{OK: false, Error: fmt.Sprintf("unsupported action %q", req.Action)}
	}
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

func write(resp response) { _ = json.NewEncoder(os.Stdout).Encode(resp) }
