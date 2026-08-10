import { afterEach, expect, it, vi } from "vitest";
import { getHealth, Session } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("authenticates REST and session WebSocket calls with the launch token", async () => {
  vi.stubGlobal("__OPENLOOP_API_TOKEN__", "launch-token");
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("X-OpenLoop-Token")).toBe("launch-token");
    return { json: async () => ({ status: "ok" }) } as Response;
  });
  vi.stubGlobal("fetch", request);

  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readyState = FakeWebSocket.CONNECTING;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send = vi.fn();

    constructor(
      public readonly url: string,
      public readonly protocols?: string | string[],
    ) {}
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);

  await getHealth();
  expect(request).toHaveBeenCalledOnce();

  const session = new Session("s1", "/workspace", "code", { onEvent: vi.fn() });
  const socket = (session as unknown as { ws: FakeWebSocket }).ws;
  expect(socket.protocols).toEqual(["openloop", "launch-token"]);
});

it("passes project_id on session WebSocket URLs when present", () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readyState = FakeWebSocket.CONNECTING;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send = vi.fn();

    constructor(public readonly url: string) {}
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);

  const session = new Session(
    "s-project",
    "/workspace",
    "openloop",
    { onEvent: vi.fn() },
    { projectId: "p-test" },
  );
  const socket = (session as unknown as { ws: FakeWebSocket }).ws;
  expect(socket.url).toContain("workspace=%2Fworkspace");
  expect(socket.url).not.toContain("agent=");
  expect(socket.url).toContain("project_id=p-test");
});
