import { describe, expect, it } from "vitest";
import api from "./api.ts?raw";
import app from "./App.tsx?raw";
import sidebar from "./components/Sidebar.tsx?raw";

describe("unified OpenLoop runtime contract", () => {
  it("uses the single agents endpoint and removes persona routes", () => {
    expect(api).toContain("/v1/agents");
    expect(api).not.toContain("/v1/personas");
  });

  it("uses openloop as the only frontend agent id", () => {
    expect(app).toContain('useState("openloop")');
    expect(sidebar).toContain('key: "openloop"');
    expect(sidebar).not.toContain('key: "chat"');
    expect(sidebar).not.toContain('key: "code"');
  });

  it("removes role-switching and workspace gates from the unified runtime", () => {
    expect(app).not.toContain("gatesWorkspace");
    expect(app).not.toContain("<FolderGate");
    expect(sidebar).not.toContain("onSwitchAgent");
  });

  it("enables artifacts for the unified runtime", () => {
    expect(app).toContain("showArtifacts");
  });
});
