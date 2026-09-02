import { describe, expect, it } from "vitest";

import { baseDuration, easeOutExpo, scrollToElement } from "./scrollTo";

interface FakeWindow {
  scrollY: number;
  frames: ((now: number) => void)[];
  listeners: Record<string, (() => void)[]>;
  token: string;
}

function fakeWindow(token: string): Window & FakeWindow {
  const fake: FakeWindow & Record<string, unknown> = {
    scrollY: 0,
    frames: [],
    listeners: {},
    token,
    document: { documentElement: {} },
    performance: { now: () => 0 },
    getComputedStyle: () => ({ getPropertyValue: () => fake.token }),
    scrollTo: (_x: number, y: number) => {
      fake.scrollY = y;
    },
    requestAnimationFrame: (cb: (now: number) => void) => {
      fake.frames.push(cb);
      return fake.frames.length;
    },
    addEventListener: (name: string, cb: () => void) => {
      (fake.listeners[name] ??= []).push(cb);
    },
    removeEventListener: () => {},
  };
  return fake as unknown as Window & FakeWindow;
}

const target = (top: number) => ({ getBoundingClientRect: () => ({ top }) }) as unknown as HTMLElement;

describe("scrollToElement", () => {
  it("reads the base duration from the stylesheet token", () => {
    expect(baseDuration(fakeWindow("200ms"))).toBe(200);
    expect(baseDuration(fakeWindow("0.2s"))).toBe(200);
    expect(baseDuration(fakeWindow("0ms"))).toBe(0);
    expect(baseDuration(fakeWindow(""))).toBe(200);
  });

  it("jumps when the token is zero, which is what reduced motion sets", () => {
    const win = fakeWindow("0ms");
    scrollToElement(target(2579), win);
    expect(win.scrollY).toBe(2579 - 12);
    expect(win.frames).toHaveLength(0);
  });

  it("animates on the expo-out curve and lands exactly", () => {
    const win = fakeWindow("200ms");
    scrollToElement(target(1000), win);
    expect(win.frames).toHaveLength(1);
    win.frames[0]!(100);
    // Half way in time is well past half way in distance on this curve.
    expect(win.scrollY).toBeGreaterThan(900);
    expect(win.scrollY).toBeLessThan(988);
    win.frames[1]!(200);
    expect(win.scrollY).toBe(988);
    expect(win.frames).toHaveLength(2);
  });

  it("stops where it is when the operator scrolls", () => {
    const win = fakeWindow("200ms");
    scrollToElement(target(1000), win);
    win.frames[0]!(50);
    const before = win.scrollY;
    win.listeners.wheel![0]!();
    win.frames[1]!(150);
    expect(win.scrollY).toBe(before);
  });

  it("does nothing without a target", () => {
    const win = fakeWindow("200ms");
    scrollToElement(null, win);
    expect(win.frames).toHaveLength(0);
  });

  it("curve ends at one", () => {
    expect(easeOutExpo(1)).toBe(1);
    expect(easeOutExpo(0)).toBeCloseTo(0, 3);
  });
});
