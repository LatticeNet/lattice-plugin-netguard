// @vitest-environment jsdom
/**
 * The Nodes filter, mounted. FilterSwitch is a radio group: only the checked
 * option is in the Tab order, and the arrow keys, Home and End move both the
 * choice and the focus. The counts come from viewState.ts nodeFilterOptions
 * and are drawn only when they are numbers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick, ref, type App as VueApp } from "vue";

import FilterSwitch from "./components/FilterSwitch.vue";
import type { FilterOption } from "./viewState";

type Choice = "all" | "attention" | "stale";

const OPTIONS: FilterOption<Choice>[] = [
  { value: "all", label: "All", count: 33 },
  { value: "attention", label: "Needs attention", count: 8, tone: "error" },
  { value: "stale", label: "Stale", count: null },
];

let app: VueApp | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

function mount(start: Choice, options: FilterOption<Choice>[] = OPTIONS) {
  const value = ref<Choice>(start);
  const emitted: Choice[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(FilterSwitch, {
        modelValue: value.value,
        options,
        label: "Which nodes to show",
        // The generic component's emit is typed string at this call site.
        "onUpdate:modelValue": (next: string) => {
          emitted.push(next as Choice);
          value.value = next as Choice;
        },
      }),
  });
  app.mount(host);
  const radio = (choice: Choice) => host.querySelector<HTMLButtonElement>(`[data-value="${choice}"]`)!;
  return { value, emitted, host, radio };
}

/** Presses a key on an option; the event says whether the page scroll was held back. */
async function press(target: HTMLElement, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  await nextTick();
  return event;
}

describe("the Nodes filter, mounted", () => {
  it("is one radio group with only the checked option in the Tab order", () => {
    const { host, radio } = mount("attention");
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Which nodes to show");
    expect(radio("attention").getAttribute("aria-checked")).toBe("true");
    expect(radio("attention").tabIndex).toBe(0);
    for (const other of ["all", "stale"] as const) {
      expect(radio(other).getAttribute("aria-checked")).toBe("false");
      expect(radio(other).tabIndex).toBe(-1);
    }
  });

  it("moves the choice and the focus with ArrowRight and ArrowLeft, wrapping at the ends", async () => {
    const { value, emitted, radio } = mount("all");
    radio("all").focus();
    // Handled keys do not also scroll the page.
    expect((await press(radio("all"), "ArrowRight")).defaultPrevented).toBe(true);
    expect(value.value).toBe("attention");
    expect(document.activeElement).toBe(radio("attention"));
    expect(radio("attention").tabIndex).toBe(0);
    expect(radio("all").tabIndex).toBe(-1);

    await press(radio("attention"), "ArrowLeft");
    await press(radio("all"), "ArrowLeft");
    expect(value.value).toBe("stale");
    expect(document.activeElement).toBe(radio("stale"));

    await press(radio("stale"), "ArrowRight");
    expect(value.value).toBe("all");
    expect(emitted).toEqual(["attention", "all", "stale", "all"]);
  });

  it("jumps to the first and last option with Home and End", async () => {
    const { value, radio } = mount("attention");
    await press(radio("attention"), "End");
    expect(value.value).toBe("stale");
    expect(document.activeElement).toBe(radio("stale"));
    await press(radio("stale"), "Home");
    expect(value.value).toBe("all");
    expect(document.activeElement).toBe(radio("all"));
  });

  it("leaves every other key to the page", async () => {
    const { emitted, radio } = mount("all");
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    radio("all").dispatchEvent(event);
    await nextTick();
    expect(emitted).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("chooses on a click", async () => {
    const { value, radio } = mount("all");
    radio("attention").click();
    await nextTick();
    expect(value.value).toBe("attention");
    expect(radio("attention").getAttribute("aria-checked")).toBe("true");
  });

  it("draws a count only when it is a number, in the tone it was given", () => {
    const { radio } = mount("all");
    expect(radio("all").querySelector(".pc-count")?.textContent).toBe("33");
    expect(radio("all").querySelector(".pc-count")?.hasAttribute("data-tone")).toBe(false);
    expect(radio("attention").querySelector(".pc-count")?.getAttribute("data-tone")).toBe("error");
    expect(radio("stale").querySelector(".pc-count")).toBeNull();
  });
});
