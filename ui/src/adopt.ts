/**
 * What adopting a legacy baseline leads to, before the operator agrees to it.
 *
 * Adopting (server `handleNetGuardAdopt`) saves the node's imported baseline
 * as a stored security group, binds it to the node and turns management on.
 * Nothing reaches the node then: the next approved apply installs the
 * compiled table, whose chain policy is drop, with established replies and
 * loopback accepted (lattice-server internal/network/nft.go). So the preview
 * is the baseline's rules, the zones the node trusts, and the ports open now
 * that no rule accepts, which that apply would close.
 *
 * The server does not compile a baseline before it is adopted (the review of
 * a legacy node carries a compile error, not a ruleset), so the exact nft
 * text is not available here; Review and apply shows it, with the diff,
 * before any approval exists.
 */
import { formatProcesses, formatSpan, ruleSentence, type ExposureContext } from "./exposure";
import type { ExposureRowView } from "./overview";

export interface AdoptPreview {
  /** The baseline group(s) the node's rules come from. */
  groupNames: string[];
  rules: { key: string; sentence: string; disabled: boolean; comment?: string }[];
  /** Zones the node trusts before any rule runs. */
  zones: string[];
  /** Whether the dropped list can be believed: the node's snapshot is fresh and was read. */
  evidence: "fresh" | "stale" | "none" | "reading";
  /** Open to the internet now, accepted by no rule, so the first apply closes them. */
  dropped: string[];
  /** Open now with a bind the snapshot does not report; the apply may close them. */
  uncertain: string[];
}

export function adoptPreview(view: ExposureRowView, ctx: ExposureContext): AdoptPreview {
  const intent = view.row.intent;
  const groups = intent?.groups ?? [];
  const rules = groups.flatMap((group) =>
    (group.rules ?? []).map((rule) => ({
      key: `${group.id}/${rule.id}`,
      sentence: ruleSentence(rule, ctx),
      disabled: Boolean(rule.disabled),
      comment: rule.comment,
    })),
  );
  const zoneIds = intent?.binding?.zone_ids ?? [];
  const zones = (intent?.zones?.length ? intent.zones : ctx.zones.filter((zone) => zoneIds.includes(zone.id))).map((zone) => zone.name || zone.id);

  const evidence: AdoptPreview["evidence"] =
    view.row.snapshotStatus === "unknown"
      ? "none"
      : view.exposure.evidence === "stale" || view.row.snapshotStatus === "stale"
        ? "stale"
        : view.detail === "loaded"
          ? "fresh"
          : "reading";
  const name = (span: (typeof view.exposure.open)[number]) => [`${formatSpan(span)}/${span.protocol}`, formatProcesses(span)].filter(Boolean).join(" ");
  const fresh = evidence === "fresh";
  return {
    groupNames: groups.map((group) => group.name || group.id),
    rules,
    zones,
    evidence,
    dropped: fresh ? view.exposure.open.filter((span) => span.verdict === "unexplained").map(name) : [],
    uncertain: fresh ? view.exposure.open.filter((span) => span.verdict === "unknown").map(name) : [],
  };
}
