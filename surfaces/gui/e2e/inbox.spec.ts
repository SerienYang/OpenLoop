import { test, expect } from "./fixtures";

// Pending holds actionable approvals/questions without a separate Configure tab.

async function openInbox(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("nav-pending").click();
  await expect(page.getByText("Approve: run_shell")).toBeVisible();
}

test("pending list has no filters or configure tab", async ({ page }) => {
  await openInbox(page);
  const question = "Which environment should I restart?";
  await expect(page.getByText(question)).toBeVisible();
  await expect(page.getByText("Approve: run_shell")).toBeVisible();
  await expect(page.getByTestId("inbox-filters")).toHaveCount(0);
  await expect(page.getByTestId("inbox-tab-configure")).toHaveCount(0);
  await expect(page.getByText("Configure")).toHaveCount(0);
});

test("resolving an approval removes its card; question options resolve on click", async ({ page }) => {
  await openInbox(page);

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approve: run_shell")).not.toBeVisible();

  // Single-select question: clicking an option resolves immediately.
  await page.getByRole("button", { name: "staging", exact: true }).click();
  await expect(page.getByText("Which environment should I restart?")).not.toBeVisible();
  await expect(page.getByText("Nothing pending.")).toBeVisible();
});
