import { describe, expect, it } from "vitest";
import translations from "./translations/zh-CN.ts?raw";
import integrationsView from "./components/IntegrationsView.tsx?raw";
import inboxConfigure from "./components/InboxConfigure.tsx?raw";
import onboarding from "./components/Onboarding.tsx?raw";
import composer from "./components/Composer.tsx?raw";
import settingsView from "./components/SettingsView.tsx?raw";
import app from "./App.tsx?raw";

const USER_COPY_SOURCES: Record<string, string> = {
  "translations/zh-CN.ts": translations,
  "components/IntegrationsView.tsx": integrationsView,
  "components/InboxConfigure.tsx": inboxConfigure,
  "components/Onboarding.tsx": onboarding,
  "components/Composer.tsx": composer,
  "components/SettingsView.tsx": settingsView,
};

const RETIRED_STEMS = [
  ["open", "worker"],
  ["co", "work"],
].map((parts) => parts.join(""));

const compact = (value: string) => value.toLowerCase().replace(/[\s_-]/g, "");

describe("OpenLoop brand copy", () => {
  it("does not expose retired naming in user-facing copy", () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(USER_COPY_SOURCES)) {
      source.split("\n").forEach((line: string, index: number) => {
        if (RETIRED_STEMS.some((stem) => compact(line).includes(stem))) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("uses OpenLoop in the default session composer placeholder", () => {
    expect(app).toContain("Ask OpenLoop…  (drop or paste files)");
  });

  it("routes the unified OpenLoop runtime to the branded fresh-session intro", () => {
    expect(app).toMatch(/<SessionIntro\s+sessionId=\{sessionId\}/);
    expect(app).not.toContain('agent !== "chat" ? (');
    expect(app).not.toContain("Let's build something.");
  });
});
