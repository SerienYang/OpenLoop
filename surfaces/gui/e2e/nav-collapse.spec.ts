// Left-nav polish: collapse controls and the grouped/chronological layout switch.
import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("collapse hides the sidebar; hover-peek stays footer-free and docks back", async ({
  page,
}) => {
  await page.goto("/");
  const app = page.locator(".app");
  await expect(page.locator(".sidebar")).toBeVisible();

  // Collapse via the brand button.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(app).toHaveClass(/nav-collapsed/);
  await page.locator(".nav-hover-zone").hover();
  await expect(app).toHaveClass(/nav-peek/);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByTestId("account-row")).toHaveCount(0);
  await expect(page.getByTestId("inbox-chip")).toHaveCount(0);
  await page.getByRole("button", { name: "Dock sidebar" }).click();
  await expect(app).not.toHaveClass(/nav-collapsed/);
});

test("⌘B toggles the sidebar collapse", async ({ page }) => {
  await page.goto("/");
  const app = page.locator(".app");
  await expect(app).not.toHaveClass(/boot-splash/);
  const initiallyCollapsed = await app.evaluate((node) =>
    node.classList.contains("nav-collapsed"),
  );
  await page.keyboard.press("Meta+b");
  if (initiallyCollapsed) await expect(app).not.toHaveClass(/nav-collapsed/);
  else await expect(app).toHaveClass(/nav-collapsed/);
  await page.keyboard.press("Meta+b");
  if (initiallyCollapsed) await expect(app).toHaveClass(/nav-collapsed/);
  else await expect(app).not.toHaveClass(/nav-collapsed/);
});

test("RECENT header layout popover switches to chronological", async ({
  page,
}) => {
  await page.goto("/");
  const header = page.getByTestId("recent-header");
  await expect(header).toContainText("Recent");

  await header.getByRole("button", { name: "Group and filter conversations" }).click();
  const menu = page.getByTestId("group-filter-menu");
  await expect(menu).toContainText("Group by");
  await expect(menu).toContainText("OpenLoop");
  await expect(menu).not.toContainText("Filter by");

  // Switch to Chronological: the OpenLoop group header leaves and sessions list directly.
  await menu.getByText("Chronological").click();
  await expect(page.getByTestId("recent-header")).toHaveCount(0);
  await expect(page.getByText("Projects", { exact: true })).toBeVisible();
  await expect(page.getByText("Recent", { exact: true })).toBeVisible();
});
