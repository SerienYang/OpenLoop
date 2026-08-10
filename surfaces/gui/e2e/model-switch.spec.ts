// Model-layer roadmap item 3 (2026-07-22): the model picker stays actionable for the
// session's whole life (supersedes the 2026-07-04 lock that hid it after the first turn).
// A mid-session switch drops a persisted info marker into the transcript, and later
// messages ride the new model.
import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("mid-session model switch shows the marker and later turns use the new model", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByText("Draft the launch note").first().click();
  const box = page.getByPlaceholder(/Ask OpenLoop|Describe the outcome/);
  await box.fill("hello there");
  await box.press("Enter");
  await expect(page.getByText("Echo: hello there", { exact: false }).first()).toBeVisible();

  // The picker is still in the composer after the first turn (the old lock hid it).
  const picker = page.locator(".dd").filter({ hasText: "Claude Opus 4.8" });
  await expect(picker).toBeVisible();
  await picker.locator(".pill").click();
  await page.locator(".dd-item").filter({ hasText: "GPT-5.5" }).click();

  // The switch marker lands in the transcript…
  await expect(page.getByText(/Model switched to gpt-5.5/).first()).toBeVisible();

  // …and the next message carries the new model (the fixture echoes it back).
  await box.fill("after the switch");
  await box.press("Enter");
  await expect(
    page.getByText("Echo: after the switch [model=gpt-5.5]", { exact: false }).first(),
  ).toBeVisible();
});

test("a long model picker stays inside the viewport and scrolls", async ({ page }) => {
  const models = Array.from({ length: 32 }, (_, index) => `provider:model-${index + 1}`);
  await page.route("**/v1/settings", (route) =>
    route.fulfill({
      json: {
        model: models[0],
        models,
        model_labels: Object.fromEntries(
          models.map((model, index) => [model, `Model ${index + 1} · Provider`]),
        ),
        has_key: true,
        model_ready: true,
        onboarded: true,
        nav_layout: "flat",
      },
    }),
  );

  await page.goto("/");
  await page.locator(".dd .pill").click();

  const menu = page.locator(".dd-menu");
  await expect(menu).toBeVisible();
  const dimensions = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });
  expect(dimensions.top).toBeGreaterThanOrEqual(8);
  expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.viewportHeight - 8);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  await menu.hover();
  await page.mouse.wheel(0, 800);
  await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
