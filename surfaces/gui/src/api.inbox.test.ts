import { afterEach, expect, it, vi } from "vitest";
import { getInbox } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("returns an empty inbox when an older sidecar does not expose the pending endpoint", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ detail: "Not Found" }),
    })) as unknown as typeof fetch,
  );

  await expect(getInbox("legacy-session", "pending")).resolves.toEqual([]);
});
