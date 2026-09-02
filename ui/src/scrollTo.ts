/**
 * Bring an element to the top of the window on the surface's own motion
 * tokens.
 *
 * The browser's smooth scrolling has its own duration and curve, so the page
 * would move on a different clock from every other transition here. This
 * reads `--duration-base` and runs the expo-out curve itself; the reduced
 * motion media query sets that token to 0ms, which makes the move a jump. The
 * move is interruptible: the first wheel, touch or key from the operator
 * cancels it where it is.
 */

/** cubic-bezier(0.19, 1, 0.22, 1), close enough in one line. */
export function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/** The base duration in milliseconds as the stylesheet currently declares it. */
export function baseDuration(win: Window = window): number {
  const raw = win.getComputedStyle(win.document.documentElement).getPropertyValue("--duration-base").trim();
  const match = raw.match(/^([\d.]+)(ms|s)$/);
  if (!match) return 200;
  const value = Number(match[1]);
  return match[2] === "s" ? value * 1000 : value;
}

const INTERRUPTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** Above the target so the panel's own border is visible, not flush with the frame. */
const TOP_MARGIN = 12;

export function scrollToElement(target: HTMLElement | null | undefined, win: Window = window): void {
  if (!target) return;
  const from = win.scrollY;
  const to = Math.max(0, from + target.getBoundingClientRect().top - TOP_MARGIN);
  const duration = baseDuration(win);
  if (duration <= 0 || Math.abs(to - from) < 1) {
    win.scrollTo(0, to);
    return;
  }
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    for (const name of INTERRUPTS) win.removeEventListener(name, cancel);
  };
  for (const name of INTERRUPTS) win.addEventListener(name, cancel, { passive: true, once: true });
  const started = win.performance.now();
  const step = (now: number): void => {
    if (cancelled) return;
    const progress = Math.min(1, (now - started) / duration);
    win.scrollTo(0, from + (to - from) * easeOutExpo(progress));
    if (progress < 1) win.requestAnimationFrame(step);
    else cancel();
  };
  win.requestAnimationFrame(step);
}
