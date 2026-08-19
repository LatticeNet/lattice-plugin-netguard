# Sidecar security review, 2026-08-19

Coverage note for the Go sidecar in this repo. Written as part of the org-wide
plugin trust-boundary review, whose main result was three findings in
lattice-plugin-sub-store. This repo produced none of that class, and the reason
is worth recording rather than leaving as silence.

Reviewed against `origin/integration` at `d1a6edf` (0.1.0-alpha.13).

## What was opened

`system-go/main.go` in full. That is the entire sidecar: one file, 120 lines,
no other non-test Go source in `system-go/`.

`manifest.json` in full, including all 10 declared methods on the single
`latticenet.netguard/firewall` interface.

`tools/pluginpack/pluginpack.go`, checked for archive path handling only. It is
byte-identical across all four plugin repos and already refuses `..`, absolute
paths, and `.` at line 125.

The test suite was run per-test. Everything passes except
`TestDescribeMatchesManifestContract`, which is a version drift and is covered
below.

## What was deliberately not opened

`ui/` was out of scope; a separate lane owned the plugin UIs and the bridge.

The server-side implementations of the 10 declared methods were not reviewed
here. Every interface in this manifest is `backing: core`, so those methods live
in lattice-server, not in this repo. Nothing in this note says anything about
whether their in-core implementations honour their declared scopes. That is a
real gap in coverage of the plugin's total surface, and it belongs to whoever
reviews the server, not to this file.

## The four questions

**Does any method declare a scope narrower than what it actually reaches?**

No, and structurally it cannot. Every one of the 10 declared methods is
`backing: core`, and the sidecar answers only the three lifecycle actions
(`describe`, `health`, `plan`). It serves none of the scoped methods at all, so
there is no behaviour here for a declared scope to be narrower than.

This is checked rather than assumed. `TestManifestInterfacesAreServedAsDeclared`
asserts that a core-backed method is *not* answered by the artifact, and it
passes for all 10. `TestUnsupportedActionFailsClosed` passes, so anything
outside the three lifecycle actions is refused rather than mishandled.

This is the exact class that produced all three sub-store findings, where a
method declared `substore:read` ran caller-supplied JavaScript with the host
egress broker attached. Nothing of that shape can exist here, because the
sidecar runs no caller-supplied anything.

**Does the sidecar perform its own network I/O or DNS?**

No. There are zero call sites for any SDK host method (`rpc.call`, `http.do`,
`http.operator.do`, `kv.*`, `secret.*`, `notify.send`, `log.write`) and no
imports of `net/http`, no `net.Dial`, and no `net.Lookup*`. The handler is
registered with the host client parameter explicitly discarded
(`main.go:44-48`), so it holds no client to misuse.

**Does any credential or secret reach a log line, an error string, or a reply?**

This is the one real gap in this repo, and it is minor.

`renderPlan` (`main.go:106-119`) echoes every key and value of the plan payload
into the returned plan text with no filtering. The sibling plugins do not agree
with it: lattice-plugin-wireguard uses a field allowlist plus a sensitive-name
denylist (`main.go:34-47`, `main.go:137-149`), and sub-store's own `renderPlan`
redacts anything whose key contains url, secret, token, password or key. Two of
the four redact and two do not, written by the same hands.

Rated low, and the reasoning matters because it is why this is not a finding
worth a release. The plan payload echoes back to the caller who supplied it, so
a caller only ever sees their own input, and a grep of lattice-server shows
`Action: "plan"` occurring only in tests, so no production path feeds
credential-bearing data into it. This repo's domain is firewall zones, groups
and bindings, which do not carry credentials in the first place.

The residual risk, and the reason it is worth fixing rather than closing: if a
plan is ever persisted into an approval that a second operator reviews, the echo
stops being self-directed. Adopting wireguard's allowlist here is a few lines
and removes the question permanently.

Nothing else leaks. The `describe` response is a static literal. Error strings
are `fmt.Errorf` over the action name and a JSON decode error, neither of which
carries payload content.

**Does anything reach a shell, a file path, or a generated config from an
operator-supplied or upstream-supplied string?**

No. There is no `os/exec`, no `exec.Command`, no file read or write, no
`filepath` use, and no `text/template` or `html/template` anywhere in the
sidecar. The plan text is string concatenation into a comment block that is
returned, not executed and not written anywhere.

The authoritative artifact this plugin fronts, the `table inet lattice_guard`
nftables ruleset, is compiled in core by `internal/netguard`, lint-checked for
management-path lockout, bound to an approval by `plan_sha256`, and applied by
the node agent under a dead-man watchdog. None of that is in this repo, and the
package documentation says so at `main.go:10-16`. I did not verify those claims
against the server; see the coverage gap noted above.

## Open, not fixed here

`TestDescribeMatchesManifestContract` fails on `origin/integration`. The
describe-time constant is `0.1.0-alpha.10` (`main.go:32`) while the signed
manifest is `0.1.0-alpha.13`, so the artifact reports a version three alphas
behind what the host enforces against. The guard that exists to catch this is
already present and already red, which makes it a release-process decision
rather than something to patch quietly. sub-store had the same drift with no
guard at all; that one has since been fixed and pinned.
