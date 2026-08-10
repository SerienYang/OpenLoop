import { test, expect } from "./fixtures";

// Session rows are single-line and title-only.
test("recent session rows render the title only", async ({ page }) => {
  await page.goto("/");
  const row = page
    .locator(".sidebar .group")
    .filter({ hasText: "Draft the launch note" })
    .first();
  await expect(row).toBeVisible();
  const text = (await row.innerText()).trim();
  expect(text).toBe("Draft the launch note");
});
