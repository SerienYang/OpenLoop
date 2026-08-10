// First-run onboarding (UX-DECISIONS §24 → §29 → §39): folder → model → tools → go.
// §39: step 1 is a provider GALLERY (cards wear their own state; a card opens its key
// form inside a fixed-height swap region; Test verifies, SAVES, and returns) and step 2
// is a two-state tools page (why-paragraph + sign-in → mini connector gallery with live
// one-click connects). Entered here by simulating first-run state (`onboarded: false`);
// Settings no longer exposes a replay button.
import { expect } from "@playwright/test";
import { test } from "./fixtures";

async function openOnboarding(page, opts: { advanceFolder?: boolean } = {}) {
  const { advanceFolder = true } = opts;
  await page.addInitScript(() => {
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => (cmd === "pick_folder" ? "/tmp/openloop-work" : null),
      },
    };
  });
  await page.route("**/v1/settings", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        provider: "openai",
        model: "anthropic:claude-opus-4-8",
        models: ["anthropic:claude-opus-4-8", "gpt-5.5", "gpt-4o", "gpt-4o-mini", "o3-mini"],
        has_key: true,
        model_ready: true,
        source: "store",
        onboarded: false,
        experimental_connectors: false,
        nav_layout: "grouped",
        session_root: "~/OpenLoop",
        secrets_path: "/Users/test/.config/openloop/secrets.json",
        sessions_peek: 5,
        pdf_fallback: "text",
        pdf_max_pages: 2,
        pdf_max_mb: 10,
        model_labels: {
          "anthropic:claude-opus-4-8": "Claude Opus 4.8 · Anthropic",
          "zai:glm-5.2": "GLM-5.2 · Z AI",
        },
        model_context_windows: {
          "anthropic:claude-opus-4-8": 200000,
        },
      }),
    }),
  );
  await page.route("**/v1/settings/validate-folder", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, path: "/tmp/openloop-work", writable: true }),
    }),
  );
  await page.route("**/v1/settings/session-root", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, session_root: "/tmp/openloop-work" }),
    }),
  );
  await page.goto("/");
  await expect(page.getByTestId("ob-step-folder")).toBeVisible();
  if (advanceFolder) {
    await page.getByTestId("ob-choose-folder").click();
    await expect(page.getByTestId("ob-folder-path")).toContainText("/tmp/openloop-work");
    await page.getByTestId("ob-continue-folder").click();
    await expect(page.getByTestId("ob-step-model")).toBeVisible();
  }
}

test("folder step: choose a work folder before model setup", async ({ page }) => {
  await openOnboarding(page, { advanceFolder: false });

  await expect(page.getByRole("heading", { name: "Choose work folder" })).toBeVisible();
  await expect(page.getByTestId("ob-continue-folder")).toBeDisabled();
  await page.getByTestId("ob-choose-folder").click();
  await expect(page.getByTestId("ob-folder-path")).toContainText("/tmp/openloop-work");
  await expect(page.getByTestId("ob-continue-folder")).toBeEnabled();
  await page.getByTestId("ob-continue-folder").click();
  await expect(page.getByTestId("ob-step-model")).toBeVisible();
});

test("provider gallery: cards wear their state; Next arms off stored credentials", async ({
  page,
}) => {
  await openOnboarding(page);

  // Every card carries its own status with zero clicks (the 2026-07-16 confusion —
  // "is OpenAI already connected?" — is answered by the gallery itself).
  await expect(page.getByTestId("ob-provider-openai")).toContainText("✓ Connected");
  await expect(page.getByTestId("ob-provider-anthropic")).toContainText("✓ Connected");
  await expect(page.getByTestId("ob-provider-zai")).toContainText("Not set up");
  await expect(page.getByTestId("ob-provider-ollama")).toContainText("No key needed");
  // Recognition-first order: anthropic before openai before the OpenAI-compat tail.
  const names = await page
    .getByTestId("ob-provider-gallery")
    .locator("[data-testid^=ob-provider-]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(names.indexOf("ob-provider-anthropic")).toBeLessThan(names.indexOf("ob-provider-openai"));
  expect(names.indexOf("ob-provider-openai")).toBeLessThan(names.indexOf("ob-provider-zai"));

  // A configured provider already arms Next — no form visit required.
  await expect(page.getByTestId("ob-continue")).toBeEnabled();
  await page.getByTestId("ob-continue").click();
  await expect(page.getByTestId("ob-step-tools")).toBeVisible();
});

test("key form: Test verifies, saves, and returns to the gallery with the ✓", async ({
  page,
}) => {
  await openOnboarding(page);

  await page.getByTestId("ob-provider-zai").click();
  // The header stays put (§39 fixed frame): the welcome headline is still on screen.
  await expect(page.getByRole("heading", { name: "Welcome to OpenLoop" })).toBeVisible();
  // Optional endpoint is a quiet disclosure with no explainer copy (owner call 2026-07-18).
  await expect(page.getByTestId("ob-field-base_url")).toHaveCount(0);
  await page.getByTestId("ob-endpoint-link").click();
  await expect(page.getByTestId("ob-field-base_url")).toHaveValue(/api\.z\.ai/);

  // Bad key: the error is a line, not a navigation.
  await page.getByTestId("ob-field-api_key").fill("bad-key");
  await page.getByTestId("ob-test").click();
  await expect(page.getByText("Invalid API key.")).toBeVisible();

  // Good key: state lands IN the field ("✓ Tested & saved" pill), then the form
  // auto-returns to the gallery where the Z AI card now wears its ✓.
  await page.getByTestId("ob-field-api_key").fill("zk-good");
  await page.getByTestId("ob-test").click();
  await expect(page.getByTestId("ob-saved-pill")).toBeVisible();
  await expect(page.getByTestId("ob-provider-zai")).toContainText("✓ Connected", {
    timeout: 5_000,
  });
  await expect(page.getByTestId("ob-continue")).toBeEnabled();
});

test("key form: revisiting a connected provider shows the in-field saved state; drafts survive switching", async ({
  page,
}) => {
  await openOnboarding(page);

  // Revisit a configured provider: green in-field pill + masked placeholder — the old
  // empty-password-field-reads-as-not-set-up trap (owner complaint 2026-07-16) is gone.
  await page.getByTestId("ob-provider-openai").click();
  await expect(page.getByTestId("ob-saved-pill")).toBeVisible();
  await expect(page.getByTestId("ob-field-api_key")).toHaveAttribute("placeholder", "••••••••");

  // Typed-but-unsaved input survives a peek at another provider (drafts).
  await page.getByTestId("ob-back").click();
  await page.getByTestId("ob-provider-zai").click();
  await page.getByTestId("ob-field-api_key").fill("zk-draft");
  await page.getByTestId("ob-back").click();
  await page.getByTestId("ob-provider-openai").click();
  await expect(page.getByTestId("ob-saved-pill")).toBeVisible();
  await page.getByTestId("ob-back").click();
  await page.getByTestId("ob-provider-zai").click();
  await expect(page.getByTestId("ob-field-api_key")).toHaveValue("zk-draft");

  // Next from a dirty form auto-verifies and saves first (2026-07-12: no hidden
  // Test-then-Continue two-step), then advances.
  await page.getByTestId("ob-field-api_key").fill("zk-good");
  await page.getByTestId("ob-continue").click();
  await expect(page.getByTestId("ob-step-tools")).toBeVisible();
});

test("tools page explains local connector setup and continues", async ({
  page,
}) => {
  await openOnboarding(page);
  await page.getByTestId("ob-continue").click();
  await expect(page.getByTestId("ob-step-tools")).toBeVisible();

  await expect(page.getByText("Connections use credentials you provide")).toBeVisible();
  await expect(page.getByTestId("ob-tool-outlook")).toContainText("Stay on top of email");
  await expect(page.getByTestId("ob-tool-outlook")).toContainText("Configure in Connectors");
  await expect(page.getByTestId("ob-tool-attio")).toContainText("Track every relationship");
  await expect(page.getByText("Local by default")).toBeVisible();
  await expect(page.getByTestId("ob-continue-tools")).toBeEnabled();
  await page.getByTestId("ob-continue-tools").click();

  // Done step: the automation CTA lands on the Automations quickstart.
  await expect(page.getByTestId("ob-step-done")).toBeVisible();
  await page.getByTestId("ob-cta-automation").click();
  await expect(page.getByTestId("onboarding")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
});

test("tools page skips cleanly; Start working lands in a session", async ({
  page,
}) => {
  await openOnboarding(page);
  await page.getByTestId("ob-continue").click();
  await page.getByTestId("ob-continue-tools").click();
  await expect(page.getByTestId("ob-step-done")).toBeVisible();
  await page.getByTestId("ob-start").click();
  await expect(page.getByTestId("onboarding")).toHaveCount(0);
  await expect(page.getByText("Progress", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Session access" })).toHaveCount(0);
});
