import { describe, expect, it } from "vitest";
import rightRail from "./components/RightRail.tsx?raw";
import tauriConfig from "../src-tauri/tauri.conf.json";

describe("artifact preview isolation", () => {
  it("keeps scripted HTML artifacts in an opaque sandbox", () => {
    expect(rightRail).toContain('sandbox="allow-scripts"');
    expect(rightRail).not.toContain("allow-same-origin");
    expect(rightRail).toContain('referrerPolicy="no-referrer"');
  });

  it("enables a restrictive application CSP", () => {
    expect(tauriConfig.app.security.csp).toBeTypeOf("string");
    expect(tauriConfig.app.security.csp).toContain("default-src 'self'");
    expect(tauriConfig.app.security.csp).toContain("frame-src 'self' data:");
  });
});
