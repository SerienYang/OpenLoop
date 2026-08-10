// The sidebar has no account or identity footer. Product destinations live in the primary
// navigation; Pending owns the aggregate attention badge.
import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("identity footer is absent and first-class navigation remains", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("account-row")).toHaveCount(0);
  await expect(page.getByTestId("account-menu")).toHaveCount(0);
  await expect(page.getByTestId("inbox-chip")).toHaveCount(0);
  await expect(page.getByTestId("nav-skills")).toBeVisible();
  await expect(page.getByTestId("nav-pending")).toBeVisible();
  await expect(page.getByTestId("nav-automations")).toBeVisible();
  await expect(page.getByTestId("nav-settings")).toContainText("⌘");
});

test("Pending carries attention and opens directly from primary navigation", async ({ page }) => {
  await page.goto("/");
  const pending = page.getByTestId("nav-pending");
  await expect(pending).toContainText(/\d/);
  await pending.click();
  await expect(page.getByText("Approve: run_shell")).toBeVisible();
});

test("Settings owns Privacy, Connectors, and MCP; Pending has no configuration", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Privacy & Security", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operation Log" })).toBeVisible();

  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  await expect(page.getByRole("button", { name: "MCP servers" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Messaging routing/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Activity", exact: true })).toHaveCount(0);

  await page.getByTestId("nav-pending").click();
  await expect(page.getByTestId("inbox-tab-configure")).toHaveCount(0);
  await expect(page.getByTestId("unrouted-section")).toHaveCount(0);
});
