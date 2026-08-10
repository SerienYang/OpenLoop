import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntegrationsView } from "./IntegrationsView";
import { McpTab } from "./ManageTabs";

type Call = { url: string; method: string; body: any };

function stubFetch(routes: { match: string; method?: string; json: any }[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const r of routes) {
      if (url.includes(r.match) && (!r.method || r.method === method)) {
        return { ok: true, json: async () => r.json } as Response;
      }
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("McpTab", () => {
  it("does not repeat the MCP server explainer inside the MCP page", async () => {
    stubFetch([
      { match: "/v1/connectors", method: "GET", json: { connectors: [] } },
      { match: "/v1/mcp", method: "GET", json: { servers: [] } },
    ]);
    render(<IntegrationsView />);

    fireEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    await screen.findByText("No MCP servers configured.");

    expect(
      screen.getAllByText(/External tool servers \(stdio or HTTP\), shared across all agents/).length,
    ).toBe(1);
  });

  it("lets users name a server when pasting a bare MCP config", async () => {
    const calls = stubFetch([
      { match: "/v1/mcp", method: "GET", json: { servers: [] } },
      { match: "/v1/mcp", method: "POST", json: { ok: true } },
    ]);
    render(<McpTab />);

    fireEvent.click(await screen.findByText("Add a server"));
    fireEvent.change(screen.getByLabelText("Server name"), {
      target: { value: "filesystem" },
    });
    fireEvent.change(screen.getByLabelText("Server JSON"), {
      target: {
        value: JSON.stringify({
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          enabled: true,
        }),
      },
    });
    fireEvent.click(screen.getByText("Add"));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/mcp"));
      expect(post?.body).toMatchObject({
        name: "filesystem",
        config: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          enabled: true,
        },
      });
    });
  });
});
