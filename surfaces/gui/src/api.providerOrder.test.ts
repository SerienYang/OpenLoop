import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProviderOrder,
  putProviderOrder,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

const response = (
  status: number,
  body: Record<string, unknown>,
): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe("provider order API", () => {
  it("gets canonical state and optional request reconciliation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          providers: ["openai", "anthropic"],
          revision: 4,
          request_applied: null,
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          providers: ["anthropic", "openai"],
          revision: 5,
          request_applied: "unknown",
        }),
      );
    vi.stubGlobal("fetch", request);

    await expect(getProviderOrder()).resolves.toEqual({
      providers: ["openai", "anthropic"],
      revision: 4,
      requestApplied: null,
    });
    await expect(
      getProviderOrder({
        requestId: "00000000-0000-4000-8000-000000000001",
        baseRevision: 4,
      }),
    ).resolves.toEqual({
      providers: ["anthropic", "openai"],
      revision: 5,
      requestApplied: "unknown",
    });

    expect(request.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8765/v1/providers/order",
    );
    expect(request.mock.calls[1][0]).toBe(
      "http://127.0.0.1:8765/v1/providers/order" +
        "?request_id=00000000-0000-4000-8000-000000000001&base_revision=4",
    );
  });

  it("returns discriminated success, conflict, and validation results", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          ok: true,
          providers: ["anthropic", "openai"],
          revision: 5,
          request_id: "request-1",
          request_applied: true,
        }),
      )
      .mockResolvedValueOnce(
        response(409, {
          ok: false,
          conflict: true,
          providers: ["openai", "anthropic"],
          revision: 6,
        }),
      )
      .mockResolvedValueOnce(
        response(422, {
          detail: "providers must be a non-empty array",
        }),
      );
    vi.stubGlobal("fetch", request);
    const payload = {
      providers: ["anthropic", "openai"],
      revision: 4,
      requestId: "request-1",
    };

    await expect(putProviderOrder(payload)).resolves.toEqual({
      kind: "ok",
      providers: ["anthropic", "openai"],
      revision: 5,
      requestId: "request-1",
    });
    await expect(putProviderOrder(payload)).resolves.toEqual({
      kind: "conflict",
      providers: ["openai", "anthropic"],
      revision: 6,
    });
    await expect(putProviderOrder(payload)).resolves.toEqual({
      kind: "invalid",
      error: "providers must be a non-empty array",
    });

    const init = request.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      providers: ["anthropic", "openai"],
      revision: 4,
      request_id: "request-1",
    });
  });
});
