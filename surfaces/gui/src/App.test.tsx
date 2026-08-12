import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const api = {
    finalizeAutomationRun: vi.fn(),
    getArtifacts: vi.fn(),
    getHealth: vi.fn(),
    getRecentWorkspaces: vi.fn(),
    getSessionMessages: vi.fn(),
    getSessions: vi.fn(),
    announceAutomationsChanged: vi.fn(),
    connectEvents: vi.fn(),
    getProjects: vi.fn(),
    getSettings: vi.fn(),
    getInbox: vi.fn(),
    getUnattended: vi.fn(),
    resolveInboxItem: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    runAutomation: vi.fn(),
    setSessionFlags: vi.fn(),
    setUnattended: vi.fn(),
    validateFolder: vi.fn(),
  };

  const sessionInstances: FakeSession[] = [];

  class FakeSession {
    handlers: {
      onEvent: (event: any) => void;
      onOpen?: () => void;
      onClose?: () => void;
    };
    closed = false;

    constructor(
      _sessionId: string,
      _workspace: string,
      _agent: string,
      handlers: { onEvent: (event: any) => void; onOpen?: () => void; onClose?: () => void },
    ) {
      this.handlers = handlers;
      sessionInstances.push(this);
      queueMicrotask(() => {
        if (!this.closed) this.handlers.onOpen?.();
      });
    }

    static reset() {
      sessionInstances.length = 0;
    }

    emit(event: any) {
      if (!this.closed) this.handlers.onEvent(event);
    }

    userMessage = vi.fn();
    approve = vi.fn();
    respondPlan = vi.fn();
    respondDirectory = vi.fn();
    respondQuestion = vi.fn();
    interrupt = vi.fn();
    retry = vi.fn();
    setMode = vi.fn();
    setModel = vi.fn();
    close = vi.fn(() => {
      this.closed = true;
      this.handlers.onClose?.();
    });
  }

  const tauri = {
    isTauri: vi.fn(() => false),
    platformOS: vi.fn(() => "macos"),
    setAwakeRunning: vi.fn(),
    startWindowDrag: vi.fn(),
  };

  return { api, sessionInstances, FakeSession, tauri };
});

vi.mock("./api", () => ({
  ...mocks.api,
  Session: mocks.FakeSession,
}));

vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(vars?.[token] ?? "")),
  }),
}));

vi.mock("./tauri", () => mocks.tauri);

vi.mock("./components/Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock("./components/AppFrame", () => ({
  AppFrame: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./components/Sidebar", () => ({
  Sidebar: ({ onNewProjectSession }: any) => (
    <button
      type="button"
      data-testid="new-project-session"
      onClick={() =>
        onNewProjectSession({
          project_id: "project-content",
          name: "内容策略平台",
          path: "/workspace/content-strategy",
          hidden: false,
          pinned: false,
          unarchived_sessions: 0,
          path_exists: true,
        })
      }
    >
      New project session
    </button>
  ),
}));

vi.mock("./components/Transcript", () => ({
  Transcript: () => <div data-testid="transcript" />,
  ThinkingBlock: () => null,
}));

vi.mock("./components/Composer", () => ({
  Composer: ({ placement, running }: { placement: string; running: boolean }) => (
    <div data-testid="composer" data-placement={placement} data-running={String(running)}>
      <span data-testid="composer-placement">{placement}</span>
      <button type="button">{running ? "Stop" : "Send"}</button>
    </div>
  ),
}));

vi.mock("./components/Markdown", () => ({
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock("./components/SearchModal", () => ({
  SearchModal: () => null,
}));

vi.mock("./components/SessionIntro", () => ({
  SessionIntro: () => <div data-testid="session-intro" />,
}));

vi.mock("./components/Onboarding", () => ({
  Onboarding: () => null,
}));

vi.mock("./components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

vi.mock("./components/ScheduledView", () => ({
  ScheduledView: () => null,
}));

vi.mock("./components/RightRail", () => ({
  RightRail: () => null,
}));

vi.mock("./components/SettingsView", () => ({
  SettingsView: () => null,
}));

vi.mock("./components/InboxView", () => ({
  InboxView: () => null,
}));

vi.mock("./components/SkillsView", () => ({
  SkillsView: () => null,
}));

vi.mock("./components/ApprovalCard", () => ({
  ApprovalCard: () => null,
}));

vi.mock("./components/DirectoryRequestCard", () => ({
  DirectoryRequestCard: () => null,
}));

vi.mock("./components/PlanCard", () => ({
  PlanCard: () => null,
}));

vi.mock("./components/WorkspaceTrustPrompt", () => ({
  WorkspaceTrustPrompt: () => null,
}));

vi.mock("./components/InboxItemCard", () => ({
  InboxItemCard: () => null,
}));

vi.mock("./components/SessionTopbar", () => ({
  SessionTopbar: ({ rightActions }: { rightActions?: ReactNode }) => (
    <div>{rightActions}</div>
  ),
}));

import { App } from "./App";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.FakeSession.reset();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });

  mocks.api.getHealth.mockResolvedValue({ model: "gpt-5.6-sol" });
  mocks.api.getSessions.mockResolvedValue([
    {
      session_id: "session-existing",
      title: "Existing session",
      workspace: "/workspace/existing",
      agent: "openloop",
      model: "gpt-5.6-sol",
      mode: "interactive",
      updated_at: "2026-08-12T09:00:00Z",
      messages: 2,
      project_id: "project-existing",
    },
  ]);
  mocks.api.getSessionMessages.mockResolvedValue([
    { role: "user", content: "hello from the current session" },
  ]);
  mocks.api.getRecentWorkspaces.mockResolvedValue([]);
  mocks.api.getProjects.mockResolvedValue([]);
  mocks.api.getSettings.mockResolvedValue({
    models: ["gpt-5.6-sol"],
    model_labels: {},
    model_context_windows: {},
    context_bar: false,
    model_ready: true,
    session_root: "/workspace/root",
  });
  mocks.api.getArtifacts.mockResolvedValue([]);
  mocks.api.getInbox.mockResolvedValue([]);
  mocks.api.getUnattended.mockResolvedValue(false);
  mocks.api.connectEvents.mockReturnValue(() => {});
  mocks.api.resolveInboxItem.mockResolvedValue(undefined);
  mocks.api.deleteSession.mockResolvedValue({ ok: true });
  mocks.api.renameSession.mockResolvedValue({ ok: true });
  mocks.api.runAutomation.mockResolvedValue({ ok: true });
  mocks.api.setSessionFlags.mockResolvedValue(undefined);
  mocks.api.setUnattended.mockResolvedValue(undefined);
  mocks.api.validateFolder.mockResolvedValue({ ok: true, writable: true });
  mocks.api.finalizeAutomationRun.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as Partial<typeof HTMLElement.prototype>).scrollTo;
});

describe("App fresh session state", () => {
  it("clears the prior session stop state when starting a project-bound fresh session", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    });

    await act(async () => {
      mocks.sessionInstances[mocks.sessionInstances.length - 1]?.emit({
        type: "turn_start",
        data: { input: "continue the old session" },
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("new-project-session"));

    await waitFor(() => {
      expect(screen.getByTestId("composer-placement").textContent).toBe("launch");
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    });
  });
});
