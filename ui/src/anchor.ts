/**
 * Where an overlay should open.
 *
 * The plugin frame has no viewport of its own, so an overlay cannot be centred
 * on screen: it has to be placed in document space, next to whatever the
 * operator clicked. This converts a trigger element into that offset.
 */
export function measureAnchor(event: Event, offset = -8): number {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return 0;
  const rect = target.getBoundingClientRect();
  return Math.max(0, rect.top + window.scrollY + offset);
}
