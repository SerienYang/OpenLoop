import { test, expect } from "./fixtures";

// Sidebar session lifecycle: peek cap, reversible archive, pinning, and two-step delete.

test("new session is a single OpenLoop button", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "New session" })).toBeVisible();
});

test("session list caps at the peek count with Show more", async ({ page }) => {
  await page.goto("/");
  // The OpenLoop group includes seven weekly plans, the Slack-origin session, and Ops triage.
  await expect(page.getByTitle("Weekly plan 1")).toBeVisible();
  await expect(page.getByTitle("Weekly plan 5")).toBeVisible();
  await expect(page.getByTitle("Weekly plan 6")).toHaveCount(0);

  await page.getByRole("button", { name: "Show more (4)" }).click();
  await expect(page.getByTitle("Weekly plan 6")).toBeVisible();
  await expect(page.getByTitle("Weekly plan 7")).toBeVisible();
});

test("archive via the row menu is reversible from Settings > Conversations", async ({ page }) => {
  await page.goto("/");
  const row = page.getByTitle("Weekly plan 2");
  await expect(row).toBeVisible();

  await row.hover();
  await row.getByTestId("row-menu").click();
  await row.getByTestId("row-menu-archive").click();

  // Gone from the sidebar; archived conversations are managed from Settings, not a sidebar disclosure.
  await expect(page.getByTitle("Weekly plan 2")).toHaveCount(0);

  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await expect(page.getByTestId("archived-conversations-card").getByText("Weekly plan 2").first()).toBeVisible();
  await page.getByTestId("restore-session-wp-2").click();
  await expect(page.getByTitle("Weekly plan 2")).toBeVisible();
});

test("mention-spawned sessions list in Recent with the platform icon — no From Slack band (§31 rev)", async ({
  page,
}) => {
  // Flat chronological layout.
  await page.route("**/v1/settings", (r) => r.fulfill({ json: { nav_layout: "flat" } }));
  await page.goto("/");
  await expect(page.getByTitle("Weekly plan 1")).toBeVisible();

  // No collapsed band; the session sits directly in Recent, exactly once.
  await expect(page.getByTestId("from-slack-toggle")).toHaveCount(0);
  const row = page.getByTitle("#general — check the deploy?");
  await expect(row).toBeVisible();
  await expect(page.getByTitle("#general — check the deploy?")).toHaveCount(1);
  // …wearing the Slack logo (hover-hidden cluster, so assert attachment not visibility).
  await expect(row.locator('[data-logo="slack"]')).toHaveCount(1);
});

test("pin via the row menu moves the session to the Pinned band and back", async ({ page }) => {
  await page.goto("/");
  const row = page.getByTitle("Weekly plan 4");
  await expect(row).toBeVisible();

  await row.hover();
  await row.getByTestId("row-menu").click();
  await expect(row.getByTestId("row-menu-pin")).toHaveText("Pin");
  await row.getByTestId("row-menu-pin").click();

  // Pinned rows live only in the Pinned band, with no duplicate in the body.
  const pinnedBand = page.getByText("Pinned", { exact: true }).locator("..");
  await expect(pinnedBand.getByTitle("Weekly plan 4")).toBeVisible();
  await expect(page.getByTitle("Weekly plan 4")).toHaveCount(1);

  const pinnedRow = pinnedBand.getByTitle("Weekly plan 4");
  await pinnedRow.hover();
  await pinnedRow.getByTestId("row-menu").click();
  await expect(pinnedRow.getByTestId("row-menu-pin")).toHaveText("Unpin");
  await pinnedRow.getByTestId("row-menu-pin").click();
  await expect(pinnedBand.getByTitle("Weekly plan 4")).toHaveCount(0);
  await expect(page.getByTitle("Weekly plan 4")).toHaveCount(1);
});

test("delete is two-step: the menu's Delete arms, Delete? confirms", async ({ page }) => {
  await page.goto("/");
  const row = page.getByTitle("Weekly plan 3");
  await expect(row).toBeVisible();

  await row.hover();
  await row.getByTestId("row-menu").click();
  await row.getByTestId("row-menu-delete").click();
  // First click only ARMS — the menu stays open showing the confirm affordance, the row remains.
  await expect(row.getByTestId("row-menu-delete")).toHaveText("Delete?");
  await expect(page.getByTitle("Weekly plan 3")).toHaveCount(1);

  await row.getByTestId("row-menu-delete").click();
  await expect(page.getByTitle("Weekly plan 3")).toHaveCount(0);
});
