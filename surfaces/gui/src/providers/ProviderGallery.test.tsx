// ProviderGallery interaction contract (spec §Settings Gallery):
// - Settings surface: two-row collapse, click/drag disambiguation at 6px, A/B
//   stable swap, keyboard reordering, and a polite live region.
// - Onboarding surface: the plain fixed grid — no collapse, no drag.
// jsdom has no layout engine, so column count is injected via `resolveColumns`
// and drag hit-testing rides the real pointer-event target (what the browser
// reports under the pointer), keeping the test faithful and deterministic.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { ProviderGallery } from "./ProviderGallery";
import type { ProviderSetupState } from "./ProviderSetup";
import type { ProviderInfo } from "../api";
import type { ProviderOrderState } from "./providerOrder";

vi.mock("../tauri", () => ({ openExternal: vi.fn(), setTrayLanguage: vi.fn() }));

beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: TestPointerEvent,
  });
});

afterEach(cleanup);

function info(name: string, configured = false): ProviderInfo {
  return {
    name,
    title: name.toUpperCase(),
    needs_key: true,
    fields: [],
    configured,
    values: {},
    suggested_models: [],
    recommended_model: null,
  };
}

const NAMES = ["anthropic", "openai", "gemini", "meta", "volcengine", "opencode-go", "ollama", "xai"];

function orderState(order: string[]): ProviderOrderState {
  return {
    acknowledged: [...order],
    optimistic: [...order],
    revision: 1,
    inFlight: null,
    pending: [],
    notice: null,
  };
}

function makePs(overrides: Partial<ProviderSetupState> = {}): ProviderSetupState {
  const ordered = (overrides.ordered as ProviderInfo[]) ?? NAMES.map((n) => info(n));
  return {
    providers: ordered,
    ordered,
    providerOrder: orderState(ordered.map((p) => p.name)),
    swapProviders: vi.fn(),
    clearProviderOrderNotice: vi.fn(),
    refreshProviders: async () => {},
    sel: null,
    info: undefined,
    fields: {},
    setFieldValue: () => {},
    dirty: false,
    verify: { state: "idle" },
    showEndpoint: false,
    setShowEndpoint: () => {},
    keylessOk: new Set(),
    credentialed: false,
    savedState: false,
    secretFilled: false,
    openProvider: vi.fn(),
    backToGallery: () => {},
    runTestAndSave: async () => true,
    removeKey: async () => {},
    cancelBackTimer: () => {},
    statusFor: () => null,
    saveField: async () => {},
    fieldSaved: null,
    ...overrides,
  };
}

function renderGallery(ps: ProviderSetupState, columns = 3, surface: "settings" | "onboarding" = "settings") {
  return render(
    <I18nProvider>
      <ProviderGallery ps={ps} tp="set" surface={surface} resolveColumns={() => columns} />
    </I18nProvider>,
  );
}

function card(name: string): HTMLElement {
  return screen.getByTestId(`set-provider-${name}`);
}

describe("ProviderGallery — click and drag disambiguation", () => {
  it("hover alone does not start a drag or hide the chevron", () => {
    const ps = makePs();
    renderGallery(ps);
    const a = card("anthropic");
    fireEvent.pointerEnter(a);
    fireEvent.pointerMove(a, { clientX: 0, clientY: 0 });
    expect(a.getAttribute("data-dragging")).not.toBe("true");
    expect(a.querySelector('[data-testid="set-chevron-anthropic"]')).toBeTruthy();
  });

  it("movement under 6px followed by click opens config exactly once", () => {
    const ps = makePs();
    renderGallery(ps);
    const a = card("anthropic");
    fireEvent.pointerDown(a, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 103, clientY: 103, pointerId: 1 }); // ~4.2px
    fireEvent.pointerUp(a, { clientX: 103, clientY: 103, pointerId: 1 });
    fireEvent.click(a);
    expect(ps.openProvider).toHaveBeenCalledTimes(1);
    expect(ps.openProvider).toHaveBeenCalledWith("anthropic");
  });

  it("6px Euclidean movement starts a drag and suppresses that click", () => {
    const ps = makePs();
    renderGallery(ps);
    const a = card("anthropic");
    fireEvent.pointerDown(a, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 105, clientY: 104, pointerId: 1 }); // ~6.4px
    expect(a.getAttribute("data-dragging")).toBe("true");
    fireEvent.pointerUp(a, { clientX: 105, clientY: 104, pointerId: 1 });
    fireEvent.click(a);
    expect(ps.openProvider).not.toHaveBeenCalled();
  });

  it("pointer cancel does not reorder and the next click still opens config", () => {
    const ps = makePs();
    renderGallery(ps);
    const a = card("anthropic");
    fireEvent.pointerDown(a, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 110, clientY: 100, pointerId: 1 });
    fireEvent.pointerCancel(a, { pointerId: 1 });
    expect(ps.swapProviders).not.toHaveBeenCalled();
    // A fresh, independent click must not be swallowed by the canceled sequence.
    fireEvent.pointerDown(a, { clientX: 100, clientY: 100, pointerId: 2 });
    fireEvent.pointerUp(a, { clientX: 100, clientY: 100, pointerId: 2 });
    fireEvent.click(a);
    expect(ps.openProvider).toHaveBeenCalledTimes(1);
  });

  it("release over B swaps only A and B", () => {
    const ps = makePs();
    renderGallery(ps);
    const a = card("anthropic");
    const b = card("gemini");
    fireEvent.pointerDown(a, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 110, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 300, clientY: 100, pointerId: 1 });
    expect(b.getAttribute("data-drop-target")).toBe("true");
    fireEvent.pointerUp(b, { clientX: 300, clientY: 100, pointerId: 1 });
    expect(ps.swapProviders).toHaveBeenCalledTimes(1);
    expect(ps.swapProviders).toHaveBeenCalledWith("anthropic", "gemini");
  });

  it("release without a target leaves order unchanged", () => {
    const ps = makePs();
    renderGallery(ps);
    const a = card("anthropic");
    fireEvent.pointerDown(a, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 120, clientY: 100, pointerId: 1 });
    // Release on the container gap, not over a card.
    fireEvent.pointerUp(window, { clientX: 500, clientY: 500, pointerId: 1 });
    expect(ps.swapProviders).not.toHaveBeenCalled();
  });

  it("only the target card shows the drop outline", () => {
    const ps = makePs();
    renderGallery(ps);
    const a = card("anthropic");
    const b = card("gemini");
    const c = card("openai");
    fireEvent.pointerDown(a, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 110, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 300, clientY: 100, pointerId: 1 });
    expect(b.getAttribute("data-drop-target")).toBe("true");
    expect(c.getAttribute("data-drop-target")).not.toBe("true");
    expect(a.getAttribute("data-drop-target")).not.toBe("true");
  });

  it("does not rerender unrelated memoized cards during an A/B drag", () => {
    const ps = makePs();
    const renders = new Map<string, number>();
    const observe = (name: string) =>
      renders.set(name, (renders.get(name) ?? 0) + 1);
    render(
      <I18nProvider>
        <ProviderGallery
          ps={ps}
          tp="set"
          surface="settings"
          resolveColumns={() => 3}
          renderObserver={observe}
        />
      </I18nProvider>,
    );
    renders.clear();

    const a = card("anthropic");
    const b = card("gemini");
    fireEvent.pointerDown(a, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 110, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 300, clientY: 100, pointerId: 1 });

    expect(renders.get("anthropic")).toBeGreaterThan(0);
    expect(renders.get("gemini")).toBeGreaterThan(0);
    expect(renders.get("openai")).toBeUndefined();
    expect(renders.get("meta")).toBeUndefined();
  });
});

describe("ProviderGallery — two-row collapse", () => {
  it("shows two rows (6 cards) at three columns and hides the rest", () => {
    const ps = makePs();
    renderGallery(ps, 3);
    expect(screen.getByTestId("set-provider-anthropic")).toBeTruthy();
    expect(screen.getByTestId("set-provider-opencode-go")).toBeTruthy(); // 6th
    expect(screen.queryByTestId("set-provider-ollama")).toBeNull(); // 7th hidden
    expect(screen.queryByTestId("set-provider-xai")).toBeNull();
  });

  it("shows two rows (4 cards) at two columns", () => {
    const ps = makePs();
    renderGallery(ps, 2);
    expect(screen.getByTestId("set-provider-meta")).toBeTruthy(); // 4th
    expect(screen.queryByTestId("set-provider-volcengine")).toBeNull(); // 5th hidden
  });

  it("expand shows all providers, then collapse hides them again", () => {
    const ps = makePs();
    renderGallery(ps, 3);
    fireEvent.click(screen.getByTestId("set-expand-providers"));
    expect(screen.getByTestId("set-provider-ollama")).toBeTruthy();
    expect(screen.getByTestId("set-provider-xai")).toBeTruthy();
    fireEvent.click(screen.getByTestId("set-expand-providers"));
    expect(screen.queryByTestId("set-provider-xai")).toBeNull();
  });

  it("omits the expand control when nothing overflows", () => {
    const ps = makePs({ ordered: NAMES.slice(0, 4).map((n) => info(n)) });
    renderGallery(ps, 3); // 4 cards, 6 visible slots → no overflow
    expect(screen.queryByTestId("set-expand-providers")).toBeNull();
  });
});

describe("ProviderGallery — keyboard reordering", () => {
  it("Enter opens configuration", () => {
    const ps = makePs();
    renderGallery(ps);
    fireEvent.keyDown(card("anthropic"), { key: "Enter" });
    expect(ps.openProvider).toHaveBeenCalledWith("anthropic");
  });

  it("Alt+ArrowRight swaps with the next visual card", () => {
    const ps = makePs();
    renderGallery(ps);
    fireEvent.keyDown(card("anthropic"), { key: "ArrowRight", altKey: true });
    expect(ps.swapProviders).toHaveBeenCalledWith("anthropic", "openai");
  });

  it("Alt+ArrowDown swaps with the card one row away", () => {
    const ps = makePs();
    renderGallery(ps, 3);
    fireEvent.keyDown(card("anthropic"), { key: "ArrowDown", altKey: true });
    expect(ps.swapProviders).toHaveBeenCalledWith("anthropic", "meta");
  });

  it("an invalid keyboard move does nothing", () => {
    const ps = makePs();
    renderGallery(ps, 3);
    fireEvent.keyDown(card("anthropic"), { key: "ArrowLeft", altKey: true });
    expect(ps.swapProviders).not.toHaveBeenCalled();
  });
});

describe("ProviderGallery — onboarding surface", () => {
  it("renders every card with no collapse or drag affordances", () => {
    const ps = makePs();
    render(
      <I18nProvider>
        <ProviderGallery ps={ps} tp="ob" surface="onboarding" resolveColumns={() => 3} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("ob-provider-xai")).toBeTruthy(); // all visible
    expect(screen.queryByTestId("ob-expand-providers")).toBeNull();
    const a = screen.getByTestId("ob-provider-anthropic");
    fireEvent.pointerDown(a, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 120, clientY: 100, pointerId: 1 });
    expect(a.getAttribute("data-dragging")).not.toBe("true");
  });
});

describe("ProviderGallery — save-failure announcement", () => {
  it("announces the failure notice in the live region", () => {
    const ps = makePs({
      providerOrder: { ...orderState(NAMES), notice: "failed" },
    });
    renderGallery(ps);
    const live = screen.getByTestId("set-order-live");
    expect(live.textContent && live.textContent.length).toBeTruthy();
  });
});
