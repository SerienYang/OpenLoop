import { describe, expect, it } from "vitest";
import auditView from "./components/AuditView.tsx?raw";
import composer from "./components/Composer.tsx?raw";
import inboxConfigure from "./components/InboxConfigure.tsx?raw";
import inboxItemCard from "./components/InboxItemCard.tsx?raw";
import manageTabs from "./components/ManageTabs.tsx?raw";
import settingsView from "./components/SettingsView.tsx?raw";
import sidebar from "./components/Sidebar.tsx?raw";
import skillsTab from "./components/SkillsTab.tsx?raw";
import updateBanner from "./components/UpdateBanner.tsx?raw";
import connectorsUi from "./components/connectors/ui.ts?raw";
import providerSetup from "./providers/ProviderSetup.tsx?raw";

declare const process: { cwd: () => string };

const ACCENT_SOURCE_FILES: Record<string, string> = {
  "components/AuditView.tsx": auditView,
  "components/Composer.tsx": composer,
  "components/InboxConfigure.tsx": inboxConfigure,
  "components/InboxItemCard.tsx": inboxItemCard,
  "components/ManageTabs.tsx": manageTabs,
  "components/SettingsView.tsx": settingsView,
  "components/Sidebar.tsx": sidebar,
  "components/SkillsTab.tsx": skillsTab,
  "components/UpdateBanner.tsx": updateBanner,
  "components/connectors/ui.ts": connectorsUi,
  "providers/ProviderSetup.tsx": providerSetup,
};

async function readProjectFile(rel: string): Promise<string> {
  // @ts-expect-error This test runs in Vitest's Node runtime; the app intentionally does not ship Node types.
  const fs = await import("node:fs");
  // @ts-expect-error This test runs in Vitest's Node runtime; the app intentionally does not ship Node types.
  const path = await import("node:path");
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("OpenLoop monochrome theme", () => {
  it("uses neutral accent tokens instead of the old cobalt blue", async () => {
    const stylesCss = await readProjectFile("src/styles.css");

    expect(stylesCss).not.toMatch(/#2563eb|#4c8dff|#e9f0fd|#1c2a44/i);
    expect(stylesCss).toMatch(/--accent:\s*oklch\(/);
    expect(stylesCss).toMatch(/--accent-soft:\s*oklch\(/);
    expect(stylesCss).toMatch(/--on-accent:\s*oklch\(/);
  });

  it("renders semantic checkboxes and radios with one aligned brand control system", async () => {
    const stylesCss = await readProjectFile("src/styles.css");

    expect(stylesCss).toMatch(
      /input\[type="checkbox"\],\s*input\[type="radio"\]\s*{[^}]*appearance:\s*none;/s,
    );
    expect(stylesCss).toMatch(
      /input\[type="checkbox"\],\s*input\[type="radio"\]\s*{[^}]*width:\s*16px;[^}]*height:\s*16px;/s,
    );
    expect(stylesCss).toContain('input[type="checkbox"]:checked');
    expect(stylesCss).toContain('input[type="radio"]:checked');
    expect(stylesCss).toContain('input[type="checkbox"]:focus-visible');
    expect(stylesCss).toContain('input[type="radio"]:focus-visible');
    expect(stylesCss).toContain('input[type="checkbox"]:disabled');
    expect(stylesCss).toContain('input[type="radio"]:disabled');
    expect(settingsView).toContain("grid-cols-[20px_minmax(0,1fr)]");
    expect(settingsView).not.toMatch(
      /type="(?:checkbox|radio)"\s+className="mt-0\.5"/,
    );
  });

  it("uses the shared shield icon for Privacy & Security", () => {
    expect(settingsView).toContain(
      '{ key: "privacy", label: "Privacy & Security", icon: "shield" }',
    );
    expect(settingsView).not.toContain(
      '{ key: "privacy", label: "Privacy & Security", icon: "sparkle" }',
    );
  });

  it("does not pair accent backgrounds with hard-coded white text", () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(ACCENT_SOURCE_FILES)) {
      source.split("\n").forEach((line: string, index: number) => {
        if (/bg-accent[^\n]*text-white|text-white[^\n]*bg-accent/.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
