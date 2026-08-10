import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionIntro } from "./SessionIntro";

afterEach(() => {
  cleanup();
});

describe("SessionIntro", () => {
  it("anchors the fresh session welcome with the OpenLoop logo in the title", async () => {
    const { container } = render(
      <SessionIntro
        sessionId="s1"
        onOpenSessionSettings={() => {}}
        onPrefill={() => {}}
      />,
    );

    expect(await screen.findByText("What should OpenLoop move forward today?")).toBeTruthy();
    expect(container.querySelector(".intro-title-logo svg")?.getAttribute("width")).toBe("42");
    expect(container.querySelector(".intro .greeting .mark")).toBeNull();
    expect(container.querySelector(".intro-eyebrow")).toBeNull();
    expect(container.querySelector(".intro-hint")).toBeNull();
    expect(container.querySelector(".intro-tasks")).toBeNull();
    expect(screen.queryByTestId("intro-task-folder")).toBeNull();
    expect(screen.queryByTestId("intro-task-report")).toBeNull();
    expect(screen.queryByTestId("intro-task-recurring")).toBeNull();
  });
});
