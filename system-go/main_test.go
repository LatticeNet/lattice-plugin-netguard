package main

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

type manifestContract struct {
	ID           string   `json:"id"`
	Version      string   `json:"version"`
	Type         string   `json:"type"`
	Capabilities []string `json:"capabilities"`
	Interfaces   []struct {
		Service string `json:"service"`
	} `json:"interfaces"`
}

func loadManifest(t *testing.T) manifestContract {
	t.Helper()
	raw, err := os.ReadFile("../manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest manifestContract
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func TestDescribeMatchesManifestContract(t *testing.T) {
	manifest := loadManifest(t)

	resp := handle(request{Action: "describe"})
	if !resp.OK {
		t.Fatalf("describe ok = false, error = %q", resp.Error)
	}
	var body struct {
		ID           string   `json:"id"`
		Version      string   `json:"version"`
		Capabilities []string `json:"capabilities"`
	}
	if err := json.Unmarshal(resp.Result, &body); err != nil {
		t.Fatal(err)
	}
	if body.ID != manifest.ID {
		t.Fatalf("id %q != manifest %q", body.ID, manifest.ID)
	}
	if body.Version != manifest.Version {
		t.Fatalf("version %q != manifest %q", body.Version, manifest.Version)
	}
	if !reflect.DeepEqual(body.Capabilities, manifest.Capabilities) {
		t.Fatalf("capabilities %v != manifest %v", body.Capabilities, manifest.Capabilities)
	}
}

// This plugin declares no interfaces yet, and that is a security decision, not
// an oversight.
//
// netguard's read models are node-scoped. The plugin gateway checks an
// interface's declared scopes with rbac.Allows(principal, scope, "") — and with
// an empty node id, a principal restricted to a subset of nodes passes. The
// RPCHandler signature carries no principal, so an in-core handler cannot
// re-apply the per-node allowlist the REST handlers enforce. Declaring
// `netguard/nodes.list` today would therefore let a node-restricted PAT read
// the whole fleet's firewall posture through the gateway.
//
// Until the gateway can express per-node authorization, node-scoped reads stay
// on the core REST surface (/api/netguard/*), which filters correctly. Any
// future interface must either be fleet-global or arrive with a
// principal-aware handler contract.
//
// If interfaces are ever added, they must be namespaced under the plugin id —
// the server enforces that at load; asserting it here catches a bad manifest
// before a release is cut.
func TestManifestDeclaresNoUnauthorizableInterfaces(t *testing.T) {
	manifest := loadManifest(t)
	if manifest.Type != "system" {
		t.Fatalf("host-risk capabilities require type=system, got %q", manifest.Type)
	}
	if len(manifest.Interfaces) != 0 {
		for _, iface := range manifest.Interfaces {
			if !strings.HasPrefix(iface.Service, manifest.ID+"/") {
				t.Fatalf("service %q is not namespaced under %q", iface.Service, manifest.ID)
			}
		}
		t.Fatalf("node-scoped interfaces must not be exposed through the plugin gateway "+
			"until it can enforce per-node allowlists; got %+v", manifest.Interfaces)
	}
	if resp := handle(request{Action: "call"}); resp.OK {
		t.Fatal("this subprocess must not answer gateway calls")
	}
}

func TestHealthAndPlan(t *testing.T) {
	if resp := handle(request{Action: "health"}); !resp.OK {
		t.Fatalf("health ok = false: %q", resp.Error)
	}
	resp := handle(request{Action: "plan", Payload: map[string]any{"node_id": "node-a", "zone": "tailscale"}})
	if !resp.OK {
		t.Fatalf("plan ok = false: %q", resp.Error)
	}
	// The plan is a dry run and must say so; it must never claim to have
	// changed a host.
	if !strings.Contains(resp.Plan, "dry run") {
		t.Fatalf("plan must be labelled a dry run:\n%s", resp.Plan)
	}
	for _, want := range []string{"# node_id = node-a", "# zone = tailscale"} {
		if !strings.Contains(resp.Plan, want) {
			t.Fatalf("plan missing %q:\n%s", want, resp.Plan)
		}
	}
	// Payload keys are rendered in a stable order so a plan hash is stable.
	first := handle(request{Action: "plan", Payload: map[string]any{"b": 2, "a": 1, "c": 3}}).Plan
	for i := 0; i < 20; i++ {
		if got := handle(request{Action: "plan", Payload: map[string]any{"c": 3, "a": 1, "b": 2}}).Plan; got != first {
			t.Fatalf("plan rendering is not deterministic:\n%s\n---\n%s", first, got)
		}
	}
}

func TestUnsupportedActionFailsClosed(t *testing.T) {
	resp := handle(request{Action: "apply"})
	if resp.OK {
		t.Fatal("an unknown action must fail closed; this subprocess never applies anything")
	}
	if !strings.Contains(resp.Error, "unsupported action") {
		t.Fatalf("error = %q", resp.Error)
	}
}
