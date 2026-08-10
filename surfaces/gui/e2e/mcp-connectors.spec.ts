// MCP-backed connectors (UX-DECISIONS §42): monday/asana/jira connect through the
// vendor's hosted MCP server via a fully local OAuth flow, and agents get only
// the pinned tool subset, surfaced on the
// connector detail page like any other curated tool set.
import { expect } from "@playwright/test";
import { test } from "./fixtures";

async function openConnectors(page) {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
}

test("monday: local MCP connect flips the card connected", async ({
  page,
}) => {
  await openConnectors(page);

  await page
    .getByTestId("connector-monday")
    .getByRole("button", { name: "Connect" })
    .click();
  const modal = page.getByTestId("add-connection-modal");
  await expect(modal).toBeVisible();
  // MCP-only: no pane switcher, just the local OAuth action.
  await expect(modal.getByTestId("modal-pane-manual")).toHaveCount(0);
  await expect(modal.getByTestId("inline-cloud-sign-in")).toHaveCount(0);
  await expect(modal.getByText("Sign-in is fully local")).toBeVisible();

  await modal.getByTestId("modal-mcp-one-click").click();
  // The mock flow completes instantly; the modal's poll closes it and the card flips.
  await expect(page.getByTestId("add-connection-modal")).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByTestId("connector-monday")).toContainText("Connected");
});

test("jira: local MCP action and manual token fields share one form", async ({
  page,
}) => {
  await openConnectors(page);
  // jira sits past the available-list fold.
  await page.getByRole("button", { name: "show all" }).click();
  await page
    .getByTestId("connector-jira")
    .getByRole("button", { name: "Connect" })
    .click();
  const modal = page.getByTestId("add-connection-modal");

  await expect(modal.getByTestId("modal-mcp-one-click")).toBeVisible();

  // Manual Atlassian token fields remain available below.
  await expect(modal.getByText("Atlassian site URL")).toBeVisible();
  await expect(modal.getByText("API token")).toBeVisible();
});

test("monday detail page shows the pinned tool subset with approval badges", async ({
  page,
}) => {
  await openConnectors(page);
  await page.getByTestId("connector-monday").click();
  await expect(page.getByText("2 tools this connector adds")).toBeVisible();
  await page.getByText("View", { exact: true }).click();
  await expect(page.getByText("Read board", { exact: true })).toBeVisible();
  await expect(page.getByText("Create item", { exact: true })).toBeVisible();
});
