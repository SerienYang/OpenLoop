import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RightRail } from "./RightRail";

afterEach(() => cleanup());

describe("RightRail", () => {
  it("shows progress without session access controls", () => {
    render(
      <RightRail
        active
        sessionId="s1"
        refreshKey={0}
        toolNames={[]}
        todo={[]}
        running={false}
        showArtifacts={false}
      />,
    );

    expect(screen.getByText("Progress")).toBeTruthy();
    expect(screen.queryByTestId("access-section")).toBeNull();
    expect(screen.queryByText("访问权限")).toBeNull();
    expect(screen.queryByText("Session access")).toBeNull();
  });
});
