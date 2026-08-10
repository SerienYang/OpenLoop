import { test, expect } from "./fixtures";

test("app loads with the OpenLoop nav and composer", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("OpenLoop").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /New session/i })).toBeVisible();
  await expect(page.getByPlaceholder(/Ask OpenLoop|Describe the outcome/)).toBeVisible();
  await expect(page.getByText("Ops", { exact: true })).toHaveCount(0);
});
