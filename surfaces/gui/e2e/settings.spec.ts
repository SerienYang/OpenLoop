import { test, expect } from "./fixtures";

// Guards the Settings-as-page refactor (§13, IA per UX-021): the ⚙ menu opens a full-page
// surface with a left sub-nav — General · Models · Voice input — and each section renders.
// General is grouped by user-facing concerns; low-value maintenance/internal cards stay out.
test("Settings opens as a full page and navigates sections", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          if (cmd === "get_autostart") return true;
          if (cmd === "get_awake_rule") return "while_running";
          if (cmd === "check_for_update") return null;
          return false;
        },
      },
    };
  });
  await page.goto("/");

  await page.getByTestId("nav-settings").click();

  // Full-page: left sub-nav + the General section (no modal backdrop).
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  for (const label of ["General", "Privacy & Security", "Conversations", "Models", "Voice input"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  // File storage is part of General rather than a separate tab.
  await expect(page.getByRole("button", { name: "Files", exact: true })).toHaveCount(0);

  await expect(page.getByText("Appearance & language", { exact: true })).toBeVisible();
  await expect(page.getByText("File storage", { exact: true })).toBeVisible();
  await expect(page.getByTestId("file-storage-card")).toContainText("~/OpenLoop");
  await expect(page.getByText("Session interface", { exact: true })).toBeVisible();
  await expect(page.getByText("System runtime", { exact: true })).toBeVisible();
  await expect(page.getByText("Wake rule", { exact: true })).toBeVisible();
  await expect(page.getByText(/Wake only while tasks run/)).toBeVisible();
  await expect(page.getByText("Updates", { exact: true })).toBeVisible();
  await expect(page.getByText("Trusted workspaces")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run setup again" })).toHaveCount(0);

  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByTestId("set-provider-openai")).toBeVisible();
  await page.getByRole("button", { name: "Privacy & Security", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operation Log" })).toBeVisible();
});

test("Chinese Settings is fully localized and keeps form controls aligned", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("openloop:lang", "zh-CN");
    localStorage.setItem("openwork-theme", "dark");
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          if (cmd === "get_autostart") return true;
          if (cmd === "get_awake_rule") return "while_running";
          if (cmd === "check_for_update") return null;
          return false;
        },
      },
    };
  });
  await page.goto("/");

  await page.getByTestId("nav-settings").click();

  await expect(page.getByRole("heading", { name: "通用" })).toBeVisible();
  await expect(page.getByRole("button", { name: "隐私与安全", exact: true })).toBeVisible();
  await expect(page.getByText("文件存储", { exact: true })).toBeVisible();
  await expect(page.getByText("File storage", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Privacy & Security", { exact: true })).toHaveCount(0);

  const controlBoxes = await Promise.all([
    page.getByRole("checkbox", { name: /登录时打开/ }).boundingBox(),
    page.getByRole("radio", { name: /无唤醒规则/ }).boundingBox(),
    page.getByRole("radio", { name: /仅任务运行时唤醒/ }).boundingBox(),
    page.getByRole("radio", { name: /始终唤醒/ }).boundingBox(),
  ]);
  expect(controlBoxes.every(Boolean)).toBe(true);
  const x = controlBoxes[0]!.x;
  for (const box of controlBoxes) {
    expect(box!.width).toBe(16);
    expect(box!.height).toBe(16);
  }
  for (const box of controlBoxes.slice(1)) {
    expect(Math.abs(box!.x - x)).toBeLessThan(0.5);
  }
  const autostart = page.getByRole("checkbox", { name: /登录时打开/ });
  const controlStyles = await autostart.evaluate((input) => {
    const control = getComputedStyle(input);
    const row = getComputedStyle(input.closest("label")!);
    const accentReference = document.createElement("span");
    accentReference.style.backgroundColor = "var(--accent)";
    document.body.appendChild(accentReference);
    const accent = getComputedStyle(accentReference).backgroundColor;
    accentReference.remove();
    return {
      background: control.backgroundColor,
      accent,
      columns: row.gridTemplateColumns,
    };
  });
  expect(controlStyles.columns.split(" ")[0]).toBe("20px");
  expect(controlStyles.background).toBe(controlStyles.accent);
  await page.keyboard.press("Tab");
  await autostart.focus();
  expect(
    await autostart.evaluate((input) => input.matches(":focus-visible")),
  ).toBe(true);
  expect(
    await autostart.evaluate((input) => getComputedStyle(input).boxShadow),
  ).not.toBe("none");

  const activeRadio = page.getByRole("radio", { name: /仅任务运行时唤醒/ });
  const inactiveRadio = page.getByRole("radio", { name: /无唤醒规则/ });
  const radioStyles = await activeRadio.evaluate((input) => {
    const accentReference = document.createElement("span");
    accentReference.style.backgroundColor = "var(--accent)";
    document.body.appendChild(accentReference);
    const accent = getComputedStyle(accentReference).backgroundColor;
    accentReference.remove();
    return {
      border: getComputedStyle(input).borderColor,
      dot: getComputedStyle(input, "::before").transform,
      columns: getComputedStyle(input.closest("label")!).gridTemplateColumns,
      accent,
    };
  });
  const inactiveDot = await inactiveRadio.evaluate(
    (input) => getComputedStyle(input, "::before").transform,
  );
  expect(radioStyles.columns.split(" ")[0]).toBe("20px");
  expect(radioStyles.border).toBe(radioStyles.accent);
  expect(radioStyles.dot).not.toBe(inactiveDot);
  await page.keyboard.press("Tab");
  await activeRadio.focus();
  expect(
    await activeRadio.evaluate((input) => input.matches(":focus-visible")),
  ).toBe(true);
  expect(
    await activeRadio.evaluate((input) => getComputedStyle(input).boxShadow),
  ).not.toBe("none");

  await page.screenshot({
    path: testInfo.outputPath("settings-zh-general-after.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "隐私与安全", exact: true }).click();
  await expect(page.getByRole("heading", { name: "操作日志" })).toBeVisible();
  await expect(page.getByRole("button", { name: "清除日志" })).toBeVisible();
  await expect(page.getByText("Operation Log", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Clear log", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("settings-zh-privacy-after.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByTestId("set-provider-zai").click();
  await expect(page.getByText("连接 Z AI (GLM) 提供的模型。")).toBeVisible();
  await expect(page.getByText("配置项：api_key")).toBeVisible();
  await expect(
    page.getByText(/Uses Z AI's OpenAI-compatible API/),
  ).toHaveCount(0);
});

test("Settings: File storage changes the session root", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => (cmd === "pick_folder" ? "/tmp/changed-root" : null),
      },
    };
  });
  await page.goto("/");

  await page.getByTestId("nav-settings").click();

  const req = page.waitForRequest(
    (r) => r.url().endsWith("/v1/settings/session-root") && r.method() === "POST",
  );
  await page.getByTestId("settings-change-session-root").click();
  expect((await req).postDataJSON()).toEqual({ path: "/tmp/changed-root" });
  await expect(page.getByTestId("file-storage-card")).toContainText("/tmp/changed-root");
  await expect(page.getByRole("button", { name: "Show in Finder" })).toBeVisible();
});

test("New ordinary session is blocked when the work folder is missing", async ({ page }) => {
  await page.route("**/v1/settings", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        provider: "openai",
        model: "anthropic:claude-opus-4-8",
        models: ["anthropic:claude-opus-4-8"],
        has_key: true,
        model_ready: true,
        source: "store",
        onboarded: true,
        experimental_connectors: false,
        nav_layout: "grouped",
        session_root: "",
        secrets_path: "/Users/test/.config/openloop/secrets.json",
        sessions_peek: 5,
        pdf_fallback: "text",
        pdf_max_pages: 2,
        pdf_max_mb: 10,
        model_labels: {},
        model_context_windows: {},
      }),
    }),
  );
  await page.goto("/");

  let message = "";
  page.once("dialog", async (dialog) => {
    message = dialog.message();
    await dialog.accept();
  });
  await page.getByRole("button", { name: "New session" }).click();
  expect(message).toContain("Choose a work folder");

  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  await expect(page.getByTestId("file-storage-card")).toBeVisible();
});

test("Settings: Conversations manages archived conversations and removed projects", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Conversations" })).toBeVisible();
  await expect(page.getByText("Archived conversations", { exact: true })).toBeVisible();
  await expect(page.getByText("Removed projects", { exact: true })).toBeVisible();
  await expect(page.getByTestId("archived-conversations-card").getByText("Weekly plan 2")).toBeVisible();
  await expect(page.getByTestId("archived-session-regular-archived")).toContainText("普通归档");
  await expect(page.getByTestId("restore-session-regular-archived")).toHaveText("Restore");
  await expect(page.getByTestId("removed-projects-card").getByText("内容策略平台")).toBeVisible();
  await expect(page.getByTestId("removed-projects-card").getByText("旧素材实验")).toBeVisible();
  await expect(page.getByTestId("removed-projects-card").getByText("Folder missing")).toBeVisible();
});

test("Settings: restoring an archived conversation can also reopen its removed project", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("removed project");
    await dialog.accept();
  });
  const reopenReq = page.waitForRequest(
    (r) => r.url().includes("/v1/projects/p-content") && r.method() === "PATCH",
  );
  const restoreReq = page.waitForRequest(
    (r) => r.url().includes("/v1/sessions/weekly-2") && r.method() === "PATCH",
  );
  await page.getByTestId("restore-session-weekly-2").click();
  expect((await reopenReq).postDataJSON()).toEqual({ hidden: false });
  expect((await restoreReq).postDataJSON()).toEqual({ archived: false });
});

test("Settings: restore archived conversation and reopen removed project", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();

  const reopenReq = page.waitForRequest(
    (r) => r.url().includes("/v1/projects/p-content") && r.method() === "PATCH",
  );
  await page.getByTestId("reopen-project-p-content").click();
  expect((await reopenReq).postDataJSON()).toEqual({ hidden: false });

  const restoreReq = page.waitForRequest(
    (r) => r.url().includes("/v1/sessions/weekly-2") && r.method() === "PATCH",
  );
  await page.getByTestId("restore-session-weekly-2").click();
  expect((await restoreReq).postDataJSON()).toEqual({ archived: false });
});

// UX-021: Settings ▸ Models is the shared provider gallery (§39 components). Cards wear
// their own state (✓ Connected · used …); a vendor card opens the shared key form with the
// prefilled endpoint behind the disclosure; unconfigured providers preview their models.
test("Models: provider gallery states; vendor form previews models", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Models", exact: true }).click();

  // Card states from the fixtures: openai configured+used, anthropic configured, zai not.
  await expect(page.getByTestId("set-provider-openai")).toContainText("✓ Connected · used 2h ago");
  await expect(page.getByTestId("set-provider-anthropic")).toContainText("✓ Connected");
  await expect(page.getByTestId("set-provider-zai")).toContainText("Not set up");
  await expect(page.getByTestId("set-provider-ollama")).toContainText("No key needed");

  // The composer-picker card lists the curated models with provider tags.
  const picker = page.getByTestId("composer-picker");
  await expect(picker).toContainText("In the composer's picker");

  // Vendor form: blurb renders; the prefilled endpoint hides behind the disclosure.
  await page.getByTestId("set-provider-zai").click();
  await expect(page.getByText(/Uses Z AI's OpenAI-compatible API/)).toBeVisible();
  await page.getByTestId("set-endpoint-link").click();
  await expect(page.getByTestId("set-field-base_url")).toHaveValue("https://api.z.ai/api/paas/v4");

  // Unconfigured providers still preview their curated models (read-only, matrix labels).
  const preview = page.getByTestId("model-preview");
  await expect(preview).toContainText("Included models");
  await expect(preview).toContainText("GLM-5.2 · Z AI");

  // Back to the gallery via the crumb.
  await page.getByTestId("set-back").click();
  await expect(page.getByTestId("set-provider-openai")).toBeVisible();
});

// UX-021: a configured provider's form shows the in-field saved state and the Remove key…
// affordance; removing reverts the card to "Not set up".
test("Models: Remove key reverts a configured provider", async ({ page }) => {
  await page.goto("/");
  page.on("dialog", (d) => d.accept());
  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Models", exact: true }).click();

  await page.getByTestId("set-provider-anthropic").click();
  await expect(page.getByTestId("set-saved-pill")).toContainText("Tested & saved");
  await page.getByTestId("set-remove-key").click();

  // Back on the gallery, the card has forgotten its key.
  await expect(page.getByTestId("set-provider-anthropic")).toContainText("Not set up");
});

// Token savings (owner ask 2026-07-17; moved under Models by UX-021): the card renders with
// the PDF fallback segmented control + attach thresholds, and edits POST through.
test("Settings: Token savings card edits PDF fallback and thresholds", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "Models", exact: true }).click();

  const card = page.getByTestId("token-savings-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("Token savings")).toBeVisible();

  // Fallback mode: fixture says "text"; switching marks "Send page images" active.
  const seg = page.getByTestId("pdf-fallback");
  await expect(seg.getByRole("button", { name: "Extract text" })).toHaveClass(/active/);
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith("/v1/settings/pdf") && r.method() === "POST"),
    seg.getByRole("button", { name: "Send page images" }).click(),
  ]);
  expect(req.postDataJSON()).toEqual({ pdf_fallback: "images" });
  await expect(seg.getByRole("button", { name: "Send page images" })).toHaveClass(/active/);

  // Thresholds: fixture starts at 2 pages / 10 MB; editing pages POSTs the clamped value.
  await expect(card.getByTestId("pdf-max-pages")).toHaveValue("2");
  await expect(card.getByTestId("pdf-max-mb")).toHaveValue("10");
  const [req2] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith("/v1/settings/pdf") && r.method() === "POST"),
    card.getByTestId("pdf-max-pages").fill("30"),
  ]);
  expect(req2.postDataJSON()).toEqual({ pdf_max_pages: 30 });
});
