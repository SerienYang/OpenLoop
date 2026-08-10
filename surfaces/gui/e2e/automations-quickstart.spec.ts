// The Automations quickstart (UX-DECISIONS §29): ONE template system — the former onboarding
// recipe (role templates, connection requirements, §25 consent) merged into the page's
// "Start from a template" grid. Cards carry §27's connector-dot vocabulary; picking one expands
// the configure card. The `ob-*` testids moved here with the machinery.
import { expect } from "@playwright/test";
import { test } from "./fixtures";

async function openAutomations(page) {
  await page.goto("/");
  await page.getByTestId("nav-automations").click();
  await expect(page.getByText("Recurring tasks OpenLoop runs on a schedule.")).toBeVisible();
}

// The fixtures seed one task, so the quickstart isn't on the bare list — surface it via the
// "+ New automation" toggle (empty state shows it without the toggle; covered indirectly by
// the delete test in automations-manage.spec.ts).
async function openQuickstart(page) {
  await openAutomations(page);
  await page.getByRole("button", { name: "+ New automation" }).click();
  await expect(page.getByText("Start from a template")).toBeVisible();
}

test("role recipe points missing connections to the local Connectors page", async ({
  page,
}) => {
  await openQuickstart(page);

  // Pipeline digest: Slack is connected in fixtures, HubSpot isn't. No recipe form yet.
  await page.getByTestId("qs-template-pipeline").click();
  const cfg = page.getByTestId("qs-configure");
  // §30: the card names its template — "SET UP · Pipeline digest" — instead of starting
  // abruptly after the grid.
  await expect(cfg).toContainText("Set up");
  await expect(cfg).toContainText("Pipeline digest");
  await expect(cfg.getByText("✓ Connected").first()).toBeVisible();
  await expect(page.getByTestId("ob-recipe")).toHaveCount(0);
  await expect(page.getByTestId("ob-create")).toBeDisabled();
  await expect(page.getByTestId("ob-create-hint")).toContainText("Connect HubSpot");

  // Missing connections never launch a broker flow.
  await page.getByTestId("ob-connect-hubspot").click();
  const pane = page.getByTestId("ob-local-connect-pane");
  await expect(pane).toContainText("Configure HubSpot from Connectors");
  await expect(pane).toContainText("Open Settings, choose Connectors");
  await expect(pane).not.toContainText("Open the OpenLoop menu");
  await expect(page.getByTestId("ob-create")).toBeDisabled();
});

test("read-only recipe (Morning brief) carries disclosure, not a grant", async ({ page }) => {
  await openQuickstart(page);
  await page.getByTestId("qs-template-brief").click();

  // Calendar + Gmail rows; no consent checkbox anywhere — reads never gate.
  await expect(page.getByText("Today's meetings and gaps")).toBeVisible();
  await expect(page.getByText("What arrived overnight")).toBeVisible();
  await expect(page.getByTestId("ob-consent")).toHaveCount(0);
});

test("no-connection template: When is editable and create opens the detail", async ({ page }) => {
  await openQuickstart(page);
  // The card says so on its face.
  await expect(page.getByTestId("qs-template-news")).toContainText("No connections needed");
  await page.getByTestId("qs-template-news").click();

  // No connect rows, no consent — just When (day × time) and an enabled Create.
  await expect(page.getByTestId("ob-consent")).toHaveCount(0);
  await expect(
    page.getByTestId("ob-recipe").getByRole("button", { name: "Day" }),
  ).toContainText("Every day");
  await expect(page.getByTestId("ob-create")).toBeEnabled();
  await page.getByTestId("ob-create").click();

  await expect(page.getByRole("button", { name: /Run now/ })).toBeVisible();
  await expect(page.getByText("Morning news briefing").first()).toBeVisible();
});
