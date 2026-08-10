// §38 project assignment — "New project…" must START from the OS folder picker (Codex
// parity, owner bug report 2026-08-03: picking New project only expanded a blank form and
// never asked for a folder). The chosen folder backfills the path AND the project name
// (folder basename), so Create & assign is one click away.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionProjectPicker } from "./SessionProjectPicker";

const { chooseFolderMock } = vi.hoisted(() => ({ chooseFolderMock: vi.fn() }));

vi.mock("../tauri", () => ({
  chooseFolder: (...args: unknown[]) => chooseFolderMock(...args),
}));

function renderPicker() {
  return render(
    <SessionProjectPicker
      sessionId="s1"
      projects={[]}
      onProjectsChanged={() => {}}
      initialProjectId={null}
    />,
  );
}

const PROJECTS = [
  {
    project_id: "p-content",
    name: "内容策略平台",
    path: "/tmp/content",
    description: "",
    hidden: false,
    path_exists: true,
    n_sessions: 0,
    last_used: null,
  },
  {
    project_id: "p-removed",
    name: "已移除项目",
    path: "/tmp/removed",
    description: "",
    hidden: true,
    path_exists: true,
    n_sessions: 0,
    last_used: null,
  },
];

describe("SessionProjectPicker", () => {
  afterEach(() => {
    cleanup();
    chooseFolderMock.mockReset();
  });

  it("opens the folder picker on 'New project…' and backfills path + name", async () => {
    chooseFolderMock.mockResolvedValue("/tmp/my-project");
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "This session belongs to" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New project…" }));

    await waitFor(() => expect(chooseFolderMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByPlaceholderText("/path/to/project") as HTMLInputElement).value).toBe(
        "/tmp/my-project",
      ),
    );
    expect((screen.getByPlaceholderText("Project name") as HTMLInputElement).value).toBe(
      "my-project",
    );

    // Both fields filled → Create & assign is enabled (no dead-end form).
    const create = screen.getByRole("button", { name: "Create & assign" });
    expect((create as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the form for manual entry when the folder picker is cancelled", async () => {
    chooseFolderMock.mockResolvedValue(null);
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "This session belongs to" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New project…" }));

    await waitFor(() => expect(chooseFolderMock).toHaveBeenCalledTimes(1));
    expect((screen.getByPlaceholderText("/path/to/project") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Create & assign" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("opens the assignment menu upward in a fixed portal and hides removed projects", () => {
    render(
      <SessionProjectPicker
        sessionId="s1"
        projects={PROJECTS}
        onProjectsChanged={() => {}}
        initialProjectId={null}
        menuBelow
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "This session belongs to" }));

    const menu = screen.getByTestId("session-project-menu");
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.bottom).not.toBe("");
    expect(menu.style.top).toBe("");
    expect(menu.dataset.placement).toBe("top");
    expect(screen.getByRole("menuitem", { name: "内容策略平台" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "已移除项目" })).toBeNull();
  });

  it("selecting a project tells the app to switch this fresh session to that project workspace", async () => {
    const onProjectSelected = vi.fn();
    render(
      <SessionProjectPicker
        sessionId="s1"
        projects={PROJECTS}
        onProjectsChanged={() => {}}
        onProjectSelected={onProjectSelected}
        initialProjectId={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "This session belongs to" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "内容策略平台" }));

    expect(onProjectSelected).toHaveBeenCalledWith(PROJECTS[0]);
  });
});
