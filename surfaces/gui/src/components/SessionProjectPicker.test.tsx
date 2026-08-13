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

function jsonResponse(body: unknown) {
  return Promise.resolve({ json: async () => body });
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens the folder picker on 'New project…' and backfills path + name", async () => {
    chooseFolderMock.mockResolvedValue("/tmp/my-project");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ ok: true, project: null })),
    );
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

  it("selecting a folder already registered as a project assigns the existing project", async () => {
    chooseFolderMock.mockResolvedValue("/tmp/content");
    const onProjectSelected = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/projects/by-path")) {
        return jsonResponse({ ok: true, project: PROJECTS[0] });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
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
    fireEvent.click(screen.getByRole("menuitem", { name: "New project…" }));

    await waitFor(() => expect(onProjectSelected).toHaveBeenCalledWith(PROJECTS[0]));
    expect(screen.queryByPlaceholderText("Project name")).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/v1/projects/by-path")),
    ).toBe(true);
  });

  it("reopens an exact hidden project before assigning it", async () => {
    chooseFolderMock.mockResolvedValue("/tmp/removed");
    const reopenedProject = { ...PROJECTS[1], hidden: false };
    const onProjectSelected = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/projects/by-path")) {
        return jsonResponse({ ok: true, project: PROJECTS[1] });
      }
      if (url.includes("/v1/projects/p-removed") && init?.method === "PATCH") {
        return jsonResponse({ ok: true, project: reopenedProject });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
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
    fireEvent.click(screen.getByRole("menuitem", { name: "New project…" }));

    await waitFor(() =>
      expect(onProjectSelected).toHaveBeenCalledWith(reopenedProject),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes("/v1/projects/p-removed") &&
          (init as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toBe(true);
  });

  it("fails closed when the existing-project lookup fails", async () => {
    chooseFolderMock.mockResolvedValue("/tmp/content");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({ ok: false, error: "lookup unavailable" }),
      ),
    );
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "This session belongs to" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New project…" }));

    await screen.findByText("lookup unavailable");
    expect(screen.queryByPlaceholderText("Project name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create & assign" })).toBeNull();
  });

  it("offers to relocate one missing project instead of creating a duplicate", async () => {
    const missingProject = {
      ...PROJECTS[0],
      project_id: "p-missing",
      name: "content",
      path: "/tmp/old/content",
      path_exists: false,
    };
    const relocatedProject = {
      ...missingProject,
      path: "/tmp/new/content",
      path_exists: true,
    };
    chooseFolderMock.mockResolvedValue("/tmp/new/content");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onProjectSelected = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/projects/by-path")) {
        return jsonResponse({ ok: true, project: null });
      }
      if (url.includes("/v1/projects/p-missing") && init?.method === "PATCH") {
        return jsonResponse({ ok: true, project: relocatedProject });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SessionProjectPicker
        sessionId="s1"
        projects={[missingProject]}
        onProjectsChanged={() => {}}
        onProjectSelected={onProjectSelected}
        initialProjectId={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "This session belongs to" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New project…" }));

    await waitFor(() =>
      expect(onProjectSelected).toHaveBeenCalledWith(relocatedProject),
    );
    expect(window.confirm).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Project name")).toBeNull();
  });
});
