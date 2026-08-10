import { describe, expect, it, vi } from "vitest";
import {
  createProviderOrderState,
  providerOrderConflict,
  providerOrderReconciled,
  providerOrderSaved,
  providerOrderServerUpdated,
  providerOrderTransportFailed,
  providerOrderValidationFailed,
  queueProviderSwap,
  swapProviderIds,
  type ProviderOrderState,
} from "./providerOrder";

const swap = (aProviderId: string, bProviderId: string) => ({
  aProviderId,
  bProviderId,
});

describe("provider order swaps", () => {
  it("swaps only the two named providers", () => {
    expect(swapProviderIds(["a", "b", "c", "d"], swap("b", "d"))).toEqual({
      order: ["a", "d", "c", "b"],
      applied: true,
    });
  });

  it("keeps one PUT in flight and coalesces newer swaps", () => {
    const initial = createProviderOrderState(["a", "b", "c"], 4);
    const first = queueProviderSwap(initial, swap("a", "b"), () => "request-1");
    const unusedRequestId = vi.fn(() => "request-2");
    const second = queueProviderSwap(
      first.state,
      swap("a", "c"),
      unusedRequestId,
    );

    expect(first.command).toMatchObject({
      type: "put",
      request: {
        requestId: "request-1",
        baseRevision: 4,
        providers: ["b", "a", "c"],
      },
    });
    expect(second.state.optimistic).toEqual(["b", "c", "a"]);
    expect(second.state.inFlight?.requestId).toBe("request-1");
    expect(second.state.pending).toEqual([swap("a", "c")]);
    expect(second.command).toEqual({ type: "none" });
    expect(unusedRequestId).not.toHaveBeenCalled();
  });

  it("success removes only covered swaps and submits the latest pending order", () => {
    const first = queueProviderSwap(
      createProviderOrderState(["a", "b", "c"], 4),
      swap("a", "b"),
      () => "request-1",
    );
    const second = queueProviderSwap(
      first.state,
      swap("a", "c"),
      () => "unused",
    );
    const saved = providerOrderSaved(
      second.state,
      "request-1",
      { providers: ["b", "a", "c"], revision: 5 },
      () => "request-2",
    );

    expect(saved.state.acknowledged).toEqual(["b", "a", "c"]);
    expect(saved.state.optimistic).toEqual(["b", "c", "a"]);
    expect(saved.state.inFlight?.swaps).toEqual([swap("a", "c")]);
    expect(saved.state.pending).toEqual([]);
    expect(saved.command).toMatchObject({
      type: "put",
      request: {
        requestId: "request-2",
        baseRevision: 5,
        providers: ["b", "c", "a"],
      },
    });
  });
});

describe("provider order reconciliation", () => {
  const queuedState = (): ProviderOrderState => {
    const first = queueProviderSwap(
      createProviderOrderState(["a", "b", "c"], 4),
      swap("a", "b"),
      () => "request-1",
    );
    return queueProviderSwap(
      first.state,
      swap("a", "c"),
      () => "unused",
    ).state;
  };

  it("reconciles a committed lost response and replays only newer swaps", () => {
    const failed = providerOrderTransportFailed(queuedState(), "request-1");
    expect(failed.command).toEqual({
      type: "reconcile",
      requestId: "request-1",
      baseRevision: 4,
    });

    const reconciled = providerOrderReconciled(
      failed.state,
      "request-1",
      {
        providers: ["b", "a", "c"],
        revision: 5,
        requestApplied: true,
      },
      () => "request-2",
    );

    expect(reconciled.state.acknowledged).toEqual(["b", "a", "c"]);
    expect(reconciled.state.optimistic).toEqual(["b", "c", "a"]);
    expect(reconciled.state.inFlight?.swaps).toEqual([swap("a", "c")]);
  });

  it("retries an unapplied request with the same id and exact payload", () => {
    const state = queuedState();
    const original = state.inFlight;
    const reconciled = providerOrderReconciled(
      state,
      "request-1",
      {
        providers: ["a", "b", "c"],
        revision: 4,
        requestApplied: false,
      },
      () => "unused",
    );

    expect(reconciled.state.inFlight).toEqual({
      ...original,
      attempt: 2,
    });
    expect(reconciled.command).toEqual({
      type: "put",
      request: { ...original, attempt: 2 },
    });
  });

  it("does not replay an ambiguous in-flight swap", () => {
    const reconciled = providerOrderReconciled(
      queuedState(),
      "request-1",
      {
        providers: ["c", "a", "b"],
        revision: 8,
        requestApplied: "unknown",
      },
      () => "request-2",
    );

    expect(reconciled.state.acknowledged).toEqual(["c", "a", "b"]);
    expect(reconciled.state.optimistic).toEqual(["a", "c", "b"]);
    expect(reconciled.state.inFlight?.swaps).toEqual([swap("a", "c")]);
    expect(reconciled.state.notice).toBe("unknown");
  });

  it("rebases all unacknowledged swaps after a revision conflict", () => {
    const conflict = providerOrderConflict(
      queuedState(),
      "request-1",
      { providers: ["p", "a", "b", "c"], revision: 5 },
      () => "request-2",
    );

    expect(conflict.state.acknowledged).toEqual(["p", "a", "b", "c"]);
    expect(conflict.state.optimistic).toEqual(["p", "b", "c", "a"]);
    expect(conflict.state.inFlight?.swaps).toEqual([
      swap("a", "b"),
      swap("a", "c"),
    ]);
    expect(conflict.command).toMatchObject({
      type: "put",
      request: { requestId: "request-2", baseRevision: 5 },
    });
  });

  it("drops only swaps whose provider disappeared", () => {
    const conflict = providerOrderConflict(
      queuedState(),
      "request-1",
      { providers: ["a", "b"], revision: 5 },
      () => "request-2",
    );

    expect(conflict.state.optimistic).toEqual(["b", "a"]);
    expect(conflict.state.inFlight?.swaps).toEqual([swap("a", "b")]);
    expect(conflict.state.notice).toBe("missing-provider");
  });

  it("stops after three consecutive attempts and adopts server state", () => {
    const state = queuedState();
    const exhausted: ProviderOrderState = {
      ...state,
      inFlight: state.inFlight
        ? { ...state.inFlight, attempt: 3 }
        : null,
    };
    const conflict = providerOrderConflict(
      exhausted,
      "request-1",
      { providers: ["p", "a", "b", "c"], revision: 9 },
      () => "unused",
    );

    expect(conflict.state.acknowledged).toEqual(["p", "a", "b", "c"]);
    expect(conflict.state.optimistic).toEqual(["p", "a", "b", "c"]);
    expect(conflict.state.inFlight).toBeNull();
    expect(conflict.state.pending).toEqual([]);
    expect(conflict.state.notice).toBe("failed");
    expect(conflict.command).toEqual({ type: "none" });
  });

  it("rolls back to acknowledged order after validation failure", () => {
    const failed = providerOrderValidationFailed(
      queuedState(),
      "request-1",
    );

    expect(failed.state.optimistic).toEqual(["a", "b", "c"]);
    expect(failed.state.inFlight).toBeNull();
    expect(failed.state.pending).toEqual([]);
    expect(failed.state.notice).toBe("failed");
  });
});

describe("provider connection promotion", () => {
  it("rebases pending intent and ignores the invalidated PUT response", () => {
    const first = queueProviderSwap(
      createProviderOrderState(["a", "b", "c", "p"], 4),
      swap("a", "b"),
      () => "request-1",
    );
    const queued = queueProviderSwap(
      first.state,
      swap("a", "c"),
      () => "unused",
    );
    const promoted = providerOrderServerUpdated(
      queued.state,
      { providers: ["p", "a", "b", "c"], revision: 5 },
      () => "request-2",
    );

    expect(promoted.state.acknowledged).toEqual(["p", "a", "b", "c"]);
    expect(promoted.state.optimistic).toEqual(["p", "b", "c", "a"]);
    expect(promoted.state.inFlight?.requestId).toBe("request-2");

    const stale = providerOrderSaved(
      promoted.state,
      "request-1",
      { providers: ["b", "a", "c", "p"], revision: 5 },
      () => "unused",
    );
    expect(stale).toEqual({
      state: promoted.state,
      command: { type: "none" },
    });
  });
});
