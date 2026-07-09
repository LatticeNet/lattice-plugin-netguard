# lattice-plugin-netguard

Official LatticeNet **netguard** system plugin: security-group-grade nftables
firewall control for a Lattice fleet.

> Status: **alpha, unsigned.** The manifest carries no `digest_sha256` or
> `signature_ed25519` yet — see [Releasing](#releasing). A host-risk plugin
> without a trusted-publisher signature is refused by the loader unless the
> operator sets `allow_unsigned_host_risk` (dev only). That is the intended
> fail-closed behavior; do not work around it.

Designed in [`lattice/docs/designs/design-13`](https://github.com/LatticeNet/lattice/blob/main/docs/designs/design-13-wireguard-and-netguard-plugins.md).

## What it manages

- **Zones** — named trust surfaces built from interfaces and/or CIDRs. The
  builtin `public`, `loopback`, `wireguard`, and `tailscale` zones resolve
  per-node facts. Trusting an overlay zone renders `iifname "tailscale0"
  accept` *before* the broad service allows, so hardening a node cannot sever
  the overlay its management path rides on.
- **Security groups** — named, reusable, ordered rule sets attachable to any
  number of nodes. A rule is `{direction, action, protocol, port_ranges,
  remote}` where the remote is a CIDR, a node, a group, a zone, a domain
  (egress only), or `any`. Group-as-remote resolves to member nodes' current
  addresses at compile time — the cloud "source: sg-xxx" semantic.
- **Node bindings** — effective firewall = base scaffold + trusted zones +
  per-node overrides + attached groups, in that order, with provenance.
- **Reality-first authoring** — the node reports its live listeners and live
  ruleset; the server diffs intent against reality and proposes changes.
  Nothing is ever applied silently.
- **Lockout linting** — a default-drop plan with no path to the management
  port is refused *before* it reaches a node. Overriding is explicit and
  audited.

## What it does not do

This subprocess **never mutates a host.** It answers `describe`, `health`, and
`plan` over the system-plugin stdio contract, and nothing else. Every host
change flows through the in-core `plan → approve → apply` pipeline and the node
agent:

```
compile (core) → lint → approval + plan_sha256 → operator review
              → bounded agent task → nft -c → snapshot
              → dead-man watchdog → nft -f → control-plane selfcheck
```

The compiler, the single `table inet lattice_guard` renderer, the approval
flow, the watchdog, and the task executor are all **core** (ADR-001 D5/D6,
design-13 D2). The plugin owns the domain model, the RPC read surface, and the
dashboard information architecture — not the trust base.

## Interfaces

Declared in `manifest.json` and served by in-core handlers registered on the
server's RPC bus, reachable through the audited, scope-checked gateway
`POST /api/plugins/call`:

| Service | Methods | Scopes |
|---|---|---|
| `latticenet.netguard/groups` | `list` | `netguard:read` |
| `latticenet.netguard/zones` | `list` | `netguard:read` |
| `latticenet.netguard/nodes` | `list` | `netguard:read` |

Mutations (`upsert`, `delete`, `adopt`, `plan`) remain on the core REST surface
under `/api/netguard/*` behind `netguard:admin` + `network:plan` until the
dashboard contribution slice lands.

## Building

```sh
cd system-go
go test ./...
go build -trimpath -ldflags='-s -w' -o lattice-plugin-netguard .
```

Zero dependencies, pure Go, no CGO — the same posture as the rest of Lattice.

## Releasing

The manifest must be signed by a **trusted publisher** before a host-risk
plugin will load. The publisher's ed25519 seed is operator-held and is never
committed:

```sh
# from a lattice-server checkout
go run ./cmd/pluginsign \
  -manifest ../lattice-plugin-netguard/manifest.json \
  -artifact ../lattice-plugin-netguard/system-go/lattice-plugin-netguard \
  -seed /path/to/latticenet-seed.bin \
  -update-digest -write
```

`pluginsign` reuses the server's own `plugin.SigningPayload`, so the signed
bytes match the verifier byte-for-byte (including the `ui`/`interfaces`
extension), then self-verifies before writing.

Alpha releases must be cut as prereleases (`v0.1.0-alpha.N`) and must not
become GitHub `Latest`.

## Install

Installation is deliberately **not** remote. Drop the verified bundle on disk:

```
<LATTICE_PLUGIN_DIR>/netguard/manifest.json
<LATTICE_PLUGIN_DIR>/netguard/artifact      # the built binary, fixed filename
```

The loader re-verifies the digest at start, stages a 0700 copy, and executes
that copy in a confined working directory with an environment allowlist. The
marketplace index is a discovery CDN, never a trust root.

## License

MIT — see [LICENSE](LICENSE).
