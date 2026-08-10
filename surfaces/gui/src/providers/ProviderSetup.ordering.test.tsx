import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../api";

const api = vi.hoisted(() => ({
  getProviderOrder: vi.fn(),
  getProviders: vi.fn(),
  putProviderOrder: vi.fn(),
  removeProvider: vi.fn(),
  setProvider: vi.fn(),
  verifyProvider: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, ...api };
});
vi.mock("../tauri", () => ({ openExternal: vi.fn() }));

import { useProviderSetup } from "./ProviderSetup";

const provider = (
  name: string,
  configured = name !== "deepseek",
): ProviderInfo => ({
  name,
  title: name,
  needs_key: true,
  fields: [
    {
      key: "api_key",
      label: "API key",
      secret: true,
      required: true,
      help: "",
      placeholder: "",
    },
  ],
  configured,
  values: {},
  suggested_models: [],
  recommended_model: null,
});

const canonical = [
  provider("xai"),
  provider("openai"),
  provider("anthropic"),
  provider("deepseek", false),
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getProviders.mockResolvedValue(canonical);
  api.getProviderOrder.mockResolvedValue({
    providers: canonical.map((item) => item.name),
    revision: 4,
    requestApplied: null,
  });
  api.putProviderOrder.mockResolvedValue({
    kind: "ok",
    providers: canonical.map((item) => item.name),
    revision: 5,
    requestId: "request-1",
  });
  api.removeProvider.mockResolvedValue({ ok: true });
  api.verifyProvider.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useProviderSetup ordering views", () => {
  it("uses backend canonical order in Settings without providerRank sorting", async () => {
    const { result } = renderHook(() =>
      useProviderSetup({ surface: "settings" }),
    );

    await waitFor(() => expect(result.current.providers).toHaveLength(4));
    expect(result.current.ordered.map((item) => item.name)).toEqual([
      "xai",
      "openai",
      "anthropic",
      "deepseek",
    ]);
    expect(result.current.providerOrder?.revision).toBe(4);
  });

  it("keeps built-in recommendation order in onboarding", async () => {
    const { result } = renderHook(() =>
      useProviderSetup({ surface: "onboarding" }),
    );

    await waitFor(() => expect(result.current.providers).toHaveLength(4));
    expect(result.current.ordered.map((item) => item.name)).toEqual([
      "anthropic",
      "openai",
      "deepseek",
      "xai",
    ]);
    expect(api.getProviderOrder).not.toHaveBeenCalled();
  });

  it("adopts first-connection order and revision from the save response", async () => {
    const promoted = [
      provider("deepseek", true),
      provider("xai"),
      provider("openai"),
      provider("anthropic"),
    ];
    api.getProviders
      .mockResolvedValueOnce(canonical)
      .mockResolvedValueOnce(promoted);
    api.setProvider.mockResolvedValue({
      ok: true,
      provider: "deepseek",
      provider_order: promoted.map((item) => item.name),
      provider_order_revision: 5,
    });
    const { result } = renderHook(() =>
      useProviderSetup({ surface: "settings" }),
    );
    await waitFor(() => expect(result.current.providers).toHaveLength(4));

    act(() => {
      result.current.openProvider("deepseek");
    });
    act(() => {
      result.current.setFieldValue("api_key", "ds-key");
    });
    await act(async () => {
      await result.current.runTestAndSave();
    });

    expect(result.current.ordered.map((item) => item.name)).toEqual([
      "deepseek",
      "xai",
      "openai",
      "anthropic",
    ]);
    expect(result.current.providerOrder?.revision).toBe(5);
  });
});
