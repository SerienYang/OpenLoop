import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("desktop navigation and connector setup stay local-only", async ({ page }) => {
  const forbidden: string[] = [];
  page.on("request", (request) => {
    if (
      /\/v1\/cloud(?:\/|$)/.test(request.url()) ||
      /\/connect-managed(?:\?|$)/.test(request.url()) ||
      /\/(?:auth|oauth)\/callback(?:\?|$)/.test(request.url())
    ) {
      forbidden.push(request.url());
    }
  });

  await page.goto("/");

  const sidebar = page.locator(".sidebar");
  await expect(sidebar).not.toContainText("Not signed in");
  await expect(sidebar).not.toContainText("OpenLoop Cloud");
  await expect(sidebar.getByTestId("account-sign-in")).toHaveCount(0);

  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  await page
    .getByTestId("connector-gmail")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  const modal = page.getByTestId("add-connection-modal");
  await expect(modal.getByTestId("managed-connect")).toHaveCount(0);
  await expect(modal.locator("input[type=password]")).toBeVisible();

  expect(forbidden).toEqual([]);
});
