import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("fresh session shows the focused OpenLoop welcome", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("openloop:lang", "zh-CN");
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "今天想让 OpenLoop 推进什么？" }),
  ).toBeVisible();
  await expect(page.locator(".intro-title-logo svg")).toBeVisible();
  await expect(page.locator(".intro-eyebrow")).toHaveCount(0);
  await expect(page.locator(".intro-hint")).toHaveCount(0);
  await expect(page.locator(".intro-tasks")).toHaveCount(0);
  await expect(page.locator(".task-card")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Session access" })).toHaveCount(0);
  await expect(page.getByPlaceholder("描述目标、粘贴内容或拖入文件")).toHaveValue("");
  const inputBox = await page.getByPlaceholder("描述目标、粘贴内容或拖入文件").boundingBox();
  expect(inputBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(page.getByText("输入 / 可调用技能")).toHaveCount(0);
});
