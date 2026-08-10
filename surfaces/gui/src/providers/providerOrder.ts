export type ProviderSwap = {
  aProviderId: string;
  bProviderId: string;
};

export type ProviderOrderNotice =
  | "failed"
  | "missing-provider"
  | "unknown"
  | null;

export type SaveRequest = {
  requestId: string;
  baseRevision: number;
  providers: string[];
  swaps: ProviderSwap[];
  attempt: number;
};

export type ProviderOrderState = {
  acknowledged: string[];
  optimistic: string[];
  revision: number;
  inFlight: SaveRequest | null;
  pending: ProviderSwap[];
  notice: ProviderOrderNotice;
};

export type ProviderOrderCommand =
  | { type: "none" }
  | { type: "put"; request: SaveRequest }
  | {
      type: "reconcile";
      requestId: string;
      baseRevision: number;
    };

export type ProviderOrderTransition = {
  state: ProviderOrderState;
  command: ProviderOrderCommand;
};

export type ProviderOrderServerState = {
  providers: string[];
  revision: number;
};

export type ProviderOrderReconciliation = ProviderOrderServerState & {
  requestApplied: true | false | "unknown";
};

type RequestIdFactory = () => string;

const NONE: ProviderOrderCommand = { type: "none" };

export function createProviderOrderState(
  providers: string[],
  revision: number,
): ProviderOrderState {
  return {
    acknowledged: [...providers],
    optimistic: [...providers],
    revision,
    inFlight: null,
    pending: [],
    notice: null,
  };
}

export function swapProviderIds(
  providers: string[],
  operation: ProviderSwap,
): { order: string[]; applied: boolean } {
  const a = providers.indexOf(operation.aProviderId);
  const b = providers.indexOf(operation.bProviderId);
  if (a < 0 || b < 0 || a === b) {
    return { order: [...providers], applied: false };
  }
  const order = [...providers];
  [order[a], order[b]] = [order[b], order[a]];
  return { order, applied: true };
}

function replayProviderSwaps(
  providers: string[],
  operations: ProviderSwap[],
): {
  order: string[];
  applied: ProviderSwap[];
  dropped: ProviderSwap[];
} {
  let order = [...providers];
  const applied: ProviderSwap[] = [];
  const dropped: ProviderSwap[] = [];
  for (const operation of operations) {
    const swapped = swapProviderIds(order, operation);
    if (!swapped.applied) {
      dropped.push(operation);
      continue;
    }
    order = swapped.order;
    applied.push(operation);
  }
  return { order, applied, dropped };
}

function makeRequest(
  providers: string[],
  revision: number,
  swaps: ProviderSwap[],
  requestId: string,
  attempt = 1,
): SaveRequest {
  return {
    requestId,
    baseRevision: revision,
    providers: [...providers],
    swaps: [...swaps],
    attempt,
  };
}

function transition(
  state: ProviderOrderState,
  command: ProviderOrderCommand = NONE,
): ProviderOrderTransition {
  return { state, command };
}

function adoptServerAndReplay(
  server: ProviderOrderServerState,
  operations: ProviderSwap[],
  requestId: RequestIdFactory,
  notice: ProviderOrderNotice = null,
  attempt = 1,
): ProviderOrderTransition {
  const replayed = replayProviderSwaps(server.providers, operations);
  const nextNotice =
    notice || (replayed.dropped.length ? "missing-provider" : null);
  if (!replayed.applied.length) {
    return transition({
      acknowledged: [...server.providers],
      optimistic: [...server.providers],
      revision: server.revision,
      inFlight: null,
      pending: [],
      notice: nextNotice,
    });
  }
  const request = makeRequest(
    replayed.order,
    server.revision,
    replayed.applied,
    requestId(),
    attempt,
  );
  return transition(
    {
      acknowledged: [...server.providers],
      optimistic: replayed.order,
      revision: server.revision,
      inFlight: request,
      pending: [],
      notice: nextNotice,
    },
    { type: "put", request },
  );
}

export function queueProviderSwap(
  state: ProviderOrderState,
  operation: ProviderSwap,
  requestId: RequestIdFactory,
): ProviderOrderTransition {
  const swapped = swapProviderIds(state.optimistic, operation);
  if (!swapped.applied) {
    return transition({
      ...state,
      notice: "missing-provider",
    });
  }
  if (state.inFlight) {
    return transition({
      ...state,
      optimistic: swapped.order,
      pending: [...state.pending, operation],
      notice: null,
    });
  }
  const request = makeRequest(
    swapped.order,
    state.revision,
    [operation],
    requestId(),
  );
  return transition(
    {
      ...state,
      optimistic: swapped.order,
      inFlight: request,
      pending: [],
      notice: null,
    },
    { type: "put", request },
  );
}

export function providerOrderSaved(
  state: ProviderOrderState,
  requestId: string,
  server: ProviderOrderServerState,
  nextRequestId: RequestIdFactory,
): ProviderOrderTransition {
  if (!state.inFlight || state.inFlight.requestId !== requestId) {
    return transition(state);
  }
  return adoptServerAndReplay(
    server,
    state.pending,
    nextRequestId,
  );
}

export function providerOrderTransportFailed(
  state: ProviderOrderState,
  requestId: string,
): ProviderOrderTransition {
  if (!state.inFlight || state.inFlight.requestId !== requestId) {
    return transition(state);
  }
  return transition(state, {
    type: "reconcile",
    requestId,
    baseRevision: state.inFlight.baseRevision,
  });
}

export function providerOrderReconciled(
  state: ProviderOrderState,
  requestId: string,
  server: ProviderOrderReconciliation,
  nextRequestId: RequestIdFactory,
): ProviderOrderTransition {
  const active = state.inFlight;
  if (!active || active.requestId !== requestId) {
    return transition(state);
  }
  if (server.requestApplied === true) {
    return adoptServerAndReplay(
      server,
      state.pending,
      nextRequestId,
    );
  }
  if (server.requestApplied === "unknown") {
    return adoptServerAndReplay(
      server,
      state.pending,
      nextRequestId,
      "unknown",
    );
  }
  if (active.attempt >= 3) {
    return transition({
      acknowledged: [...server.providers],
      optimistic: [...server.providers],
      revision: server.revision,
      inFlight: null,
      pending: [],
      notice: "failed",
    });
  }
  const request = { ...active, attempt: active.attempt + 1 };
  return transition(
    {
      ...state,
      inFlight: request,
    },
    { type: "put", request },
  );
}

export function providerOrderConflict(
  state: ProviderOrderState,
  requestId: string,
  server: ProviderOrderServerState,
  nextRequestId: RequestIdFactory,
): ProviderOrderTransition {
  const active = state.inFlight;
  if (!active || active.requestId !== requestId) {
    return transition(state);
  }
  if (active.attempt >= 3) {
    return transition({
      acknowledged: [...server.providers],
      optimistic: [...server.providers],
      revision: server.revision,
      inFlight: null,
      pending: [],
      notice: "failed",
    });
  }
  return adoptServerAndReplay(
    server,
    [...active.swaps, ...state.pending],
    nextRequestId,
    null,
    active.attempt + 1,
  );
}

export function providerOrderValidationFailed(
  state: ProviderOrderState,
  requestId: string,
): ProviderOrderTransition {
  if (!state.inFlight || state.inFlight.requestId !== requestId) {
    return transition(state);
  }
  return transition({
    ...state,
    optimistic: [...state.acknowledged],
    inFlight: null,
    pending: [],
    notice: "failed",
  });
}

export function providerOrderReconciliationFailed(
  state: ProviderOrderState,
  requestId: string,
): ProviderOrderTransition {
  return providerOrderValidationFailed(state, requestId);
}

export function providerOrderServerUpdated(
  state: ProviderOrderState,
  server: ProviderOrderServerState,
  nextRequestId: RequestIdFactory,
): ProviderOrderTransition {
  const operations = state.inFlight
    ? [...state.inFlight.swaps, ...state.pending]
    : [...state.pending];
  return adoptServerAndReplay(
    server,
    operations,
    nextRequestId,
  );
}
