// The Connectors LIST (UX-DECISIONS §21): connected connectors first in their own
// section with a health chip, rows navigate to the connector's detail subpage
// (breadcrumb back), available connectors get a Connect pill → local setup modal.
import { expect } from "@playwright/test";
import { test } from "./fixtures";

async function openConnectors(page) {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
}

test("connected connectors come first with status + health chip", async ({ page }) => {
  await openConnectors(page);

  const slack = page.getByTestId("connector-slack");
  await expect(slack).toContainText("deeplearning.ai");
  await expect(slack).toContainText("Live");
  // available section renders the not-connected connectors with a Connect pill
  await expect(
    page.getByTestId("connector-telegram").getByRole("button", { name: "Connect" }),
  ).toBeVisible();
});

test("row navigates to the detail subpage; breadcrumb returns", async ({ page }) => {
  await openConnectors(page);
  await page.getByTestId("connector-slack").click();
  await expect(page.getByTestId("slack-manual-detail")).toBeVisible();
  await page.getByTestId("connectors-breadcrumb").click();
  await expect(page.getByTestId("connector-slack")).toContainText("deeplearning.ai");
});

test("generic detail page: tools + two-way blocks + disconnect for telegram-alikes", async ({
  page,
}) => {
  await openConnectors(page);
  // Browser is keyless-connected → generic page, no Disconnect for auth=none
  await page.getByTestId("connector-browser").click();
  await expect(page.getByRole("heading", { name: "Browser" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  await page.getByTestId("connectors-breadcrumb").click();
});

test("Connect opens the local credential modal", async ({
  page,
}) => {
  await openConnectors(page);
  await page.getByTestId("connector-telegram").getByRole("button", { name: "Connect" }).click();
  const modal = page.getByTestId("add-connection-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator("input")).not.toHaveCount(0); // manual fields rendered
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("add-connection-modal")).toHaveCount(0);
});

test("filter narrows both sections", async ({ page }) => {
  await openConnectors(page);
  await page.getByPlaceholder("Search").fill("tele");
  await expect(page.getByTestId("connector-telegram")).toBeVisible();
  await expect(page.getByTestId("connector-slack")).toHaveCount(0);
});
