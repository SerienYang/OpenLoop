import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { interpolate, translate, translateDynamic } from "./i18n";
import { zhCN } from "./translations/zh-CN";

declare const process: { cwd: () => string };

async function frontendSources(): Promise<string[]> {
  // @ts-expect-error Vitest runs this file in Node; the app intentionally omits Node types.
  const fs = await import("node:fs");
  // @ts-expect-error Vitest runs this file in Node; the app intentionally omits Node types.
  const path = await import("node:path");
  const root = path.join(process.cwd(), "src");
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (
        /\.(ts|tsx)$/.test(entry.name) &&
        !entry.name.includes(".test.") &&
        file !== path.join(root, "translations", "zh-CN.ts")
      ) {
        out.push(file);
      }
    }
  };
  visit(root);
  return out;
}

async function literalTranslationKeys(): Promise<Map<string, string[]>> {
  // @ts-expect-error Vitest runs this file in Node; the app intentionally omits Node types.
  const fs = await import("node:fs");
  // @ts-expect-error Vitest runs this file in Node; the app intentionally omits Node types.
  const path = await import("node:path");
  const keys = new Map<string, string[]>();
  for (const file of await frontendSources()) {
    const source = fs.readFileSync(file, "utf8");
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t" &&
        node.arguments.length > 0
      ) {
        const key = node.arguments[0];
        if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
          const places = keys.get(key.text) ?? [];
          const line = ast.getLineAndCharacterOfPosition(key.getStart(ast)).line + 1;
          places.push(`${path.relative(process.cwd(), file)}:${line}`);
          keys.set(key.text, places);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return keys;
}

async function literalJsxCopy(): Promise<Map<string, string[]>> {
  // @ts-expect-error Vitest runs this file in Node; the app intentionally omits Node types.
  const fs = await import("node:fs");
  // @ts-expect-error Vitest runs this file in Node; the app intentionally omits Node types.
  const path = await import("node:path");
  const copy = new Map<string, string[]>();
  for (const file of await frontendSources()) {
    if (!file.endsWith(".tsx")) continue;
    const source = fs.readFileSync(file, "utf8");
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      const attributeText =
        ts.isJsxAttribute(node) &&
        ["aria-label", "alt", "placeholder", "title"].includes(
          node.name.getText(ast),
        ) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
          ? node.initializer.text
          : "";
      if (ts.isJsxText(node) || attributeText) {
        const text = (attributeText || node.getText(ast))
          .replace(/\s+/g, " ")
          .trim();
        if (/[A-Za-z]{2}/.test(text)) {
          const places = copy.get(text) ?? [];
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          places.push(`${path.relative(process.cwd(), file)}:${line}`);
          copy.set(text, places);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return copy;
}

describe("i18n translate", () => {
  it("passes English keys through when the lang is en", () => {
    expect(translate("New chat", "en")).toBe("New chat");
  });

  it("translates known keys into zh-CN", () => {
    expect(translate("New chat", "zh-CN")).toBe("新建会话");
    expect(translate("Settings", "zh-CN")).toBe("设置");
  });

  it("falls back to the English key for untranslated strings", () => {
    expect(translate("Some string nobody translated", "zh-CN")).toBe(
      "Some string nobody translated",
    );
  });

  it("uses contextual Chinese fallback for untranslated API copy", () => {
    expect(
      translateDynamic(
        "Backend copy added after this release",
        "zh-CN",
        "服务说明",
      ),
    ).toBe("服务说明");
    expect(
      translateDynamic("Backend copy added after this release", "en", "服务说明"),
    ).toBe("Backend copy added after this release");
  });

  it("interpolates {{vars}} in the translated value", () => {
    expect(
      translate("approved · {{mode}}", "zh-CN", { mode: "manual" }),
    ).toBe("已批准 · manual");
  });

  it("interpolates {{vars}} even without a provider (default t)", () => {
    expect(interpolate("Delete {{name}}", { name: "weekly-report" })).toBe(
      "Delete weekly-report",
    );
  });

  it("has a Simplified Chinese entry for every literal frontend translation key", async () => {
    const keys = await literalTranslationKeys();
    const missing = [...keys.entries()]
      .filter(([key]) => !(key in zhCN))
      .map(([key, places]) => `${JSON.stringify(key)} @ ${places.join(", ")}`)
      .sort();

    expect(missing).toEqual([]);
  });

  it("does not bypass translation for literal user-facing JSX copy", async () => {
    const allowedTechnicalCopy = new Set([
      "/path/to/project",
      "BETA",
      "Esc",
      "Gmail",
      "GitHub",
      "HubSpot",
      "MB",
      "OpenLoop",
      "Slack",
      "W",
      "Whisper Base · English",
      "Windows 10 22H2/11 · x64",
      "filesystem",
      "macOS 12+ · Apple Silicon M1+",
    ]);
    const copy = await literalJsxCopy();
    const untranslated = [...copy.entries()]
      .filter(([text]) => !allowedTechnicalCopy.has(text))
      .map(([text, places]) => `${JSON.stringify(text)} @ ${places.join(", ")}`)
      .sort();

    expect(untranslated).toEqual([]);
  });
});
