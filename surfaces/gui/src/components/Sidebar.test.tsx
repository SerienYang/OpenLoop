import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import type { SessionInfo } from "../types";

const { chooseFolderMock } = vi.hoisted(() => ({ chooseFolderMock: vi.fn() }));

vi.mock("../tauri", () => ({
  chooseFolder: (...args: unknown[]) => chooseFolderMock(...args),
}));

// Hermetic fetch stub routing by URL substring + method; records calls for POST assertions.
type Call = { url: string; method: string; body: any };

function stubFetch(routes: { match: string; method?: string; json: any }[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const r of routes) {
      if (url.includes(r.match) && (!r.method || r.method === method)) {
        return { ok: true, json: async () => r.json } as Response;
      }
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const SESSIONS: SessionInfo[] = [
  { session_id: "s-incident-1", title: "incident watch", workspace: "/w", agent: "openloop", model: "m", mode: "interactive", updated_at: "2026-06-29", messages: 2 },
  { session_id: "s-general-1", title: "hi there", workspace: "", agent: "openloop", model: "m", mode: "interactive", updated_at: "2026-06-29", messages: 1 },
];

const baseProps = {
  agent: "openloop",
  workspace: "",
  sessions: SESSIONS,
  projects: [],
  projectIndex: [],
  activeSession: "s-general-1",
  onNewSession: vi.fn(),
  onNewProjectSession: vi.fn(),
  onSelectSession: vi.fn(),
  onRenameSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onArchiveSession: vi.fn(),
  onTogglePin: vi.fn(),
  onManage: vi.fn(),
  onOpenScheduled: vi.fn(),
  onOpenAutomation: vi.fn(),
  onOpenInbox: vi.fn(),
  onOpenSkills: vi.fn(),
  scheduledActive: false,
  inboxActive: false,
  skillsActive: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  chooseFolderMock.mockReset();
  vi.clearAllMocks();
});

describe("Sidebar group/filter control", () => {
  it("grouped layout exposes the group/filter control and can switch to chronological", async () => {
    const calls = stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "grouped" } },
      { match: "/v1/settings/nav-layout", method: "POST", json: { ok: true, nav_layout: "flat" } },
    ]);
    render(<Sidebar {...baseProps} />);

    // In grouped mode the RECENT header owns grouping/filtering.
    const control = await screen.findByLabelText("Group and filter conversations");

    // Open the popover and switch to the flat chronological sidebar.
    fireEvent.click(control);
    fireEvent.click(await screen.findByText("Chronological"));

    // POSTs the new layout pref.
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.includes("/v1/settings/nav-layout"));
      expect(post).toBeTruthy();
      expect(post!.body).toMatchObject({ nav_layout: "flat" });
    });

    expect(screen.getByText("incident watch")).toBeTruthy();
  });
});

describe("Chronological list row actions (⋮ menu)", () => {
  // The Recent list sorts by updated_at desc with store order breaking ties.
  const openOpsMenu = () => fireEvent.click(screen.getAllByTestId("row-menu")[0]);

  it("rename / pin / archive / two-step delete all live behind the row's single kebab", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    render(<Sidebar {...baseProps} />);
    await screen.findByText("incident watch"); // flat Recent list rendered

    // Rename: menu item → inline input → Enter commits.
    openOpsMenu();
    fireEvent.click(screen.getByTestId("row-menu-rename"));
    const input = screen.getByDisplayValue("incident watch");
    fireEvent.change(input, { target: { value: "war room" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(baseProps.onRenameSession).toHaveBeenCalledWith("s-incident-1", "war room");

    // Pin moved inside the menu (unpinned session → "Pin").
    openOpsMenu();
    fireEvent.click(screen.getByTestId("row-menu-pin"));
    expect(baseProps.onTogglePin).toHaveBeenCalledWith("s-incident-1", true);

    // Archive.
    openOpsMenu();
    fireEvent.click(screen.getByTestId("row-menu-archive"));
    expect(baseProps.onArchiveSession).toHaveBeenCalledWith("s-incident-1", true);

    // Delete is two-step: first click arms ("Delete?"), the second deletes.
    openOpsMenu();
    fireEvent.click(screen.getByTestId("row-menu-delete"));
    expect(baseProps.onDeleteSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("row-menu-delete").textContent).toContain("Delete?");
    fireEvent.click(screen.getByTestId("row-menu-delete"));
    expect(baseProps.onDeleteSession).toHaveBeenCalledWith("s-incident-1");
  });

  it("the kebab and its menu never select the row; Escape closes the menu", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    render(<Sidebar {...baseProps} />);
    await screen.findByText("incident watch");

    openOpsMenu();
    fireEvent.click(screen.getByTestId("row-menu-pin"));
    expect(baseProps.onSelectSession).not.toHaveBeenCalled();

    openOpsMenu();
    expect(screen.getByTestId("row-menu-rename")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("row-menu-rename")).toBeNull();
  });
});

describe("From Slack group (§31)", () => {
  const SLACK_SESSION: SessionInfo = {
    session_id: "s-slack-1",
    title: "#general — check the deploy?",
    workspace: "",
    agent: "openloop",
    model: "m",
    mode: "interactive",
    updated_at: "2026-07-13",
    messages: 2,
    origin: "slack",
    origin_label: "#general · T0AB",
  };

  it("mention-spawned sessions list chronologically in Recent with the platform icon (no band)", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    render(<Sidebar {...baseProps} sessions={[...SESSIONS, SLACK_SESSION]} />);
    await screen.findByText("incident watch"); // flat Recent rendered

    // No collapsed band — the session sits directly in the Recent list, exactly once…
    expect(screen.queryByTestId("from-slack-toggle")).toBeNull();
    const row = await screen.findByText("#general — check the deploy?");
    expect(screen.getAllByText("#general — check the deploy?")).toHaveLength(1);

    // …wearing the Slack logo in the row's indicator cluster.
    const cluster = row.closest(".group");
    expect(cluster?.querySelector('[data-logo="slack"]')).toBeTruthy();
  });
});

describe("New-session split button", () => {
  it("renders one plain New session button and no persona menu", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    const { container } = render(<Sidebar {...baseProps} />);
    await screen.findByText("incident watch");

    expect(screen.queryByLabelText("Choose a persona")).toBeNull();
    expect(screen.queryByText("Manage personas…")).toBeNull();
    fireEvent.click(container.querySelector(".newsplit-primary")!);
    expect(baseProps.onNewSession).toHaveBeenCalledWith("openloop");
  });

});

describe("Session list splits into Regular and Project sections", () => {
  const PROJ_SESSIONS: SessionInfo[] = [
    ...SESSIONS,
    {
      session_id: "s-lumen-1",
      title: "fix the export pipeline",
      workspace: "/Users/me/lumen",
      agent: "openloop",
      model: "m",
      mode: "interactive",
      updated_at: "2026-08-01",
      messages: 5,
      project_id: "p-lumen",
    },
    {
      session_id: "s-core-1",
      title: "core refactor",
      workspace: "/Users/me/core",
      agent: "openloop",
      model: "m",
      mode: "interactive",
      updated_at: "2026-08-02",
      messages: 3,
      project_id: "p-core",
    },
  ];
  const PROJECTS = [
    { project_id: "p-lumen", name: "Lumen Scripts", path: "/Users/me/lumen", description: "", hidden: false, path_exists: true, n_sessions: 1, unarchived_sessions: 1, archived_sessions: 0, last_used: null },
    { project_id: "p-core", name: "Core", path: "/Users/me/core", description: "", hidden: false, path_exists: true, n_sessions: 1, unarchived_sessions: 1, archived_sessions: 0, last_used: null },
    { project_id: "p-hidden", name: "Hidden", path: "/Users/me/hidden", description: "", hidden: true, path_exists: true, n_sessions: 1, unarchived_sessions: 1, archived_sessions: 0, last_used: null },
    { project_id: "p-missing", name: "Missing Folder", path: "/Users/me/missing", description: "", hidden: false, path_exists: false, n_sessions: 1, unarchived_sessions: 1, archived_sessions: 0, last_used: null },
  ];

  it("lists regular sessions flat and project sessions grouped under a project tree", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    render(<Sidebar {...baseProps} sessions={PROJ_SESSIONS} projectIndex={PROJECTS} />);
    await screen.findByText("incident watch");

    // Flat layout removes the global Recent header; Projects comes before the lower Recent section.
    expect(screen.queryByTestId("recent-header")).toBeNull();
    const regLabel = screen.getByText("Recent");
    const projLabel = screen.getByText("Projects");
    expect(projLabel.compareDocumentPosition(regLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("project-add")).toBeTruthy();

    // Sessions without a project_id list flat under Regular.
    expect(screen.getByText("hi there")).toBeTruthy();

    // Project sessions sit under a folder named after the registered project.
    expect(screen.getByText("Lumen Scripts")).toBeTruthy();
    expect(screen.getByText("fix the export pipeline")).toBeTruthy();
    expect(screen.getByText("Core")).toBeTruthy();
    expect(screen.getByText("core refactor")).toBeTruthy();
  });

  it("project add opens a folder and creates or reopens that project", async () => {
    chooseFolderMock.mockResolvedValue("/Users/me/new-project");
    const calls = stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
      { match: "/v1/projects", method: "POST", json: { ok: true, reopened: true, project: { project_id: "p-new", name: "new-project", path: "/Users/me/new-project", hidden: false, n_sessions: 0, last_used: null } } },
    ]);
    const onProjectsChanged = vi.fn();
    render(<Sidebar {...baseProps} sessions={PROJ_SESSIONS} projectIndex={PROJECTS} onProjectsChanged={onProjectsChanged} />);
    await screen.findByText("Lumen Scripts");

    fireEvent.click(screen.getByTestId("project-add"));
    await waitFor(() => expect(chooseFolderMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.includes("/v1/projects"));
      expect(post?.body).toMatchObject({ name: "new-project", path: "/Users/me/new-project" });
    });
    await waitFor(() => expect(onProjectsChanged).toHaveBeenCalled());
  });

  it("hides sessions that belong to hidden projects from project and regular sections", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    render(
      <Sidebar
        {...baseProps}
        sessions={[
          ...PROJ_SESSIONS,
          {
            session_id: "s-hidden-1",
            title: "hidden project work",
            workspace: "/Users/me/hidden",
            agent: "openloop",
            model: "m",
            mode: "interactive",
            updated_at: "2026-08-03",
            messages: 1,
            project_id: "p-hidden",
          },
        ]}
        projectIndex={PROJECTS}
      />,
    );
    await screen.findByText("Lumen Scripts");
    expect(screen.queryByText("Hidden")).toBeNull();
    expect(screen.queryByText("hidden project work")).toBeNull();
  });

  it("project menu removes the project by hiding it, without touching sessions client-side", async () => {
    const calls = stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
      { match: "/v1/projects/p-lumen", method: "PATCH", json: { ok: true, project: { ...PROJECTS[0], hidden: true } } },
    ]);
    render(<Sidebar {...baseProps} sessions={PROJ_SESSIONS} projectIndex={PROJECTS} />);
    await screen.findByText("Lumen Scripts");

    fireEvent.click(screen.getByTestId("project-menu-p-lumen"));
    fireEvent.click(screen.getByTestId("project-menu-remove-p-lumen"));

    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/v1/projects/p-lumen"));
    expect(patch?.body).toEqual({ hidden: true });
    expect(baseProps.onArchiveSession).not.toHaveBeenCalled();
  });

  it("project menu starts a fresh session assigned to that project", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    const onNewProjectSession = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        sessions={PROJ_SESSIONS}
        projectIndex={PROJECTS}
        onNewProjectSession={onNewProjectSession}
      />,
    );
    await screen.findByText("Lumen Scripts");

    fireEvent.click(screen.getByTestId("project-menu-p-lumen"));
    fireEvent.click(screen.getByTestId("project-menu-new-session-p-lumen"));

    expect(onNewProjectSession).toHaveBeenCalledWith(PROJECTS[0]);
    expect(baseProps.onNewSession).not.toHaveBeenCalled();
  });

  it("marks visible projects whose folder is missing", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    render(
      <Sidebar
        {...baseProps}
        sessions={[
          ...PROJ_SESSIONS,
          {
            session_id: "s-missing-1",
            title: "missing folder work",
            workspace: "/Users/me/missing",
            agent: "openloop",
            model: "m",
            mode: "interactive",
            updated_at: "2026-08-03",
            messages: 1,
            project_id: "p-missing",
          },
        ]}
        projectIndex={PROJECTS}
      />,
    );
    await screen.findByText("Missing Folder");
    expect(screen.getByText("Folder missing")).toBeTruthy();
  });

  it("shows the empty hint when no regular sessions exist", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    render(
      <Sidebar
        {...baseProps}
        sessions={PROJ_SESSIONS.filter((s) => s.project_id)}
        projectIndex={PROJECTS}
      />,
    );
    await screen.findByText("Lumen Scripts");
    expect(screen.getByText("No regular sessions yet.")).toBeTruthy();
  });
});

describe("Skills nav row", () => {
  it("sits between New session and Search and opens the skills surface on click", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    const { container } = render(<Sidebar {...baseProps} />);
    await screen.findByText("incident watch");

    // The row is present, labeled, and wears the book icon (Skills' glyph in Settings too).
    const row = screen.getByTestId("nav-skills");
    expect(row.textContent).toContain("Skills");
    expect(row.querySelector("svg")).toBeTruthy();

    // Position: after the new-session split, before the Search entry.
    const newBtn = container.querySelector(".newsplit-primary")!;
    const searchBtn = screen.getByText("Search");
    expect(newBtn.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(searchBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Clicking opens the skills surface.
    fireEvent.click(row);
    expect(baseProps.onOpenSkills).toHaveBeenCalled();
  });

  it("keeps primary navigation in the sidebar instead of the OpenLoop menu", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    const sessions = [{ ...SESSIONS[0], attention: 1 }, SESSIONS[1]];
    const { container } = render(<Sidebar {...baseProps} sessions={sessions} />);
    await screen.findByText("incident watch");

    const newBtn = container.querySelector(".newsplit-primary")!;
    const skills = screen.getByTestId("nav-skills");
    const pending = screen.getByTestId("nav-pending");
    const search = screen.getByText("Search");
    const automations = screen.getByTestId("nav-automations");
    const settings = screen.getByTestId("nav-settings");

    expect(newBtn.compareDocumentPosition(skills) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(skills.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pending.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(search.compareDocumentPosition(automations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(automations.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(pending);
    expect(baseProps.onOpenInbox).toHaveBeenCalled();
    fireEvent.click(settings);
    expect(baseProps.onManage).toHaveBeenCalled();

    expect(pending.textContent).toContain("1");
    expect(screen.queryByTestId("account-row")).toBeNull();
    expect(screen.queryByTestId("account-menu")).toBeNull();
    expect(screen.queryByTestId("inbox-chip")).toBeNull();
    const sessionScroller = container.querySelector(".sidebar > .flex-1.overflow-y-auto");
    expect(sessionScroller?.nextElementSibling).toBeNull();
  });

  it("highlights while the skills surface is active", async () => {
    stubFetch([
      { match: "/v1/settings", method: "GET", json: { nav_layout: "flat" } },
    ]);
    render(<Sidebar {...baseProps} skillsActive />);
    await screen.findByText("incident watch");

    // Active row carries the filled (text-ink bg-paper) treatment.
    expect(screen.getByTestId("nav-skills").className).toContain("text-ink");
  });
});
