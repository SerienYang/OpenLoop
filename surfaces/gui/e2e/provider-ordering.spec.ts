import { expect, test } from "./fixtures";

async function openModels(page, language: "en" | "zh-CN" = "en") {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page
    .getByRole("button", {
      name: language === "zh-CN" ? "模型" : "Models",
      exact: true,
    })
    .click();
  await expect(page.getByTestId("set-provider-openai")).toBeVisible();
}

async function visibleOrder(page): Promise<string[]> {
  return page
    .locator("[data-provider]")
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-provider") || ""),
    );
}

test("Settings gallery shows two rows and preserves expansion through a form visit", async ({
  page,
}) => {
  await openModels(page);

  await expect(page.locator("[data-provider]")).toHaveCount(6);
  await expect(page.getByTestId("set-expand-providers")).toHaveText(
    "Show all 8",
  );
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.locator("[data-provider]")).toHaveCount(4);
  await page.getByTestId("set-expand-providers").click();
  await expect(page.locator("[data-provider]")).toHaveCount(8);
  await expect(page.getByTestId("set-expand-providers")).toHaveText("Show less");

  await page.getByTestId("set-provider-opencode-go").click();
  await page.getByTestId("set-back").click();
  await expect(page.locator("[data-provider]")).toHaveCount(8);
  await expect(page.getByTestId("set-expand-providers")).toHaveText("Show less");
});

test("5px remains a click; 6px A/B drag persists without disturbing unrelated cards", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("openloop:lang", "zh-CN");
    localStorage.setItem("openwork-theme", "dark");
  });
  await openModels(page, "zh-CN");

  const clickCard = page.getByTestId("set-provider-openai");
  const clickBox = await clickCard.boundingBox();
  if (!clickBox) throw new Error("OpenAI card has no layout box");
  await page.mouse.move(clickBox.x + clickBox.width / 2, clickBox.y + clickBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    clickBox.x + clickBox.width / 2 + 3,
    clickBox.y + clickBox.height / 2 + 4,
  );
  await page.mouse.up();
  await expect(page.getByTestId("set-field-api_key")).toBeVisible();
  await page.getByTestId("set-back").click();

  const before = await visibleOrder(page);
  const sourceName = "openai";
  const targetName = "zai";
  const source = page.getByTestId(`set-provider-${sourceName}`);
  const target = page.getByTestId(`set-provider-${targetName}`);
  const unrelated = page.getByTestId("set-provider-anthropic");
  const unrelatedBox = await unrelated.boundingBox();
  const unrelatedNode = await unrelated.elementHandle();
  const unrelatedIcon = await unrelated.locator("img").elementHandle();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox || !unrelatedBox || !unrelatedNode || !unrelatedIcon) {
    throw new Error("provider cards are missing layout or icon nodes");
  }

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2 + 6,
    sourceBox.y + sourceBox.height / 2,
  );
  await expect(source).toHaveAttribute("data-dragging", "true");
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
  );
  await expect(target).toHaveAttribute("data-drop-target", "true");
  await page.screenshot({
    path: testInfo.outputPath("provider-gallery-drag-target.png"),
    fullPage: true,
  });

  expect(await visibleOrder(page)).toEqual(before);
  expect(await unrelated.boundingBox()).toEqual(unrelatedBox);
  const unrelatedNodeAfter = await unrelated.elementHandle();
  const unrelatedIconAfter = await unrelated.locator("img").elementHandle();
  expect(
    await unrelatedNode.evaluate((node, other) => node === other, unrelatedNodeAfter),
  ).toBe(true);
  expect(
    await unrelatedIcon.evaluate((node, other) => node === other, unrelatedIconAfter),
  ).toBe(true);

  const saved = page.waitForRequest(
    (request) =>
      request.url().endsWith("/v1/providers/order") &&
      request.method() === "PUT",
  );
  await page.mouse.up();
  const savedRequest = await saved;

  const after = [...before];
  const sourceIndex = before.indexOf(sourceName);
  const targetIndex = before.indexOf(targetName);
  [after[sourceIndex], after[targetIndex]] = [
    after[targetIndex],
    after[sourceIndex],
  ];
  expect(
    savedRequest.postDataJSON().providers.slice(0, before.length),
  ).toEqual(after);
  await expect.poll(() => visibleOrder(page)).toEqual(after);

  await openModels(page, "zh-CN");
  await expect.poll(() => visibleOrder(page)).toEqual(after);
});

test("keyboard ordering uses the same persistent save path", async ({ page }) => {
  await openModels(page);
  const before = await visibleOrder(page);
  const source = page.getByTestId("set-provider-openai");
  await source.focus();
  const saved = page.waitForRequest(
    (request) =>
      request.url().endsWith("/v1/providers/order") &&
      request.method() === "PUT",
  );
  await page.keyboard.press("Alt+ArrowRight");
  await saved;
  await expect(page.getByTestId("set-order-live")).not.toHaveText("");

  const after = [...before];
  [after[0], after[1]] = [after[1], after[0]];
  await expect.poll(() => visibleOrder(page)).toEqual(after);
  await openModels(page);
  await expect.poll(() => visibleOrder(page)).toEqual(after);
});

test("rapid keyboard swaps coalesce while the first PUT is in flight", async ({
  page,
}) => {
  let puts = 0;
  await page.route("**/v1/providers/order*", async (route) => {
    if (route.request().method() === "PUT") {
      puts += 1;
      if (puts === 1) await page.waitForTimeout(200);
    }
    await route.fallback();
  });
  await openModels(page);
  const before = await visibleOrder(page);
  const source = page.getByTestId("set-provider-openai");
  await source.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+ArrowRight");

  const after = [...before];
  [after[0], after[1]] = [after[1], after[0]];
  [after[1], after[2]] = [after[2], after[1]];
  await expect.poll(() => visibleOrder(page)).toEqual(after);
  await expect.poll(() => puts).toBe(2);

  await openModels(page);
  await expect.poll(() => visibleOrder(page)).toEqual(after);
});

test("OpenCode Go exposes all official models and first connection promotes it", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("openloop:lang", "zh-CN");
    localStorage.setItem("openwork-theme", "dark");
  });
  await openModels(page, "zh-CN");
  await expect(page.getByTestId("set-expand-providers")).toHaveText(
    "显示全部 8 个",
  );
  await page.screenshot({
    path: testInfo.outputPath("provider-gallery-collapsed.png"),
    fullPage: true,
  });
  await page.getByTestId("set-expand-providers").click();
  await page.screenshot({
    path: testInfo.outputPath("provider-gallery-expanded.png"),
    fullPage: true,
  });

  await page.getByTestId("set-provider-opencode-go").click();
  await expect(page.getByTestId("set-field-api_key")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /opencode\.ai\/auth/ }),
  ).toBeVisible();
  const models = page.locator('[data-testid="model-preview"] .space-y-1 > div');
  await expect(models).toHaveCount(19);
  await expect(
    page.getByText("DeepSeek V4 Flash · OpenCode Go", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("opencode-go-form.png"),
    fullPage: true,
  });

  await page.getByTestId("set-field-api_key").fill("opencode-real-key");
  await page.getByTestId("set-test").click();
  await expect(page.getByTestId("set-provider-opencode-go")).toContainText(
    "✓ 已连接",
    { timeout: 5_000 },
  );
  const order = await visibleOrder(page);
  expect(order[0]).toBe("opencode-go");
});
