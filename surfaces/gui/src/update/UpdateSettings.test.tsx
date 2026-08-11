import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateProvider } from "./UpdateProvider";
import { UpdateSettings } from "./UpdateSettings";

function renderSettings() {
  return render(
    <UpdateProvider>
      <UpdateSettings />
    </UpdateProvider>,
  );
}

describe("UpdateSettings", () => {
  const invoke = vi.fn();
  const listen = vi.fn();
  let checkResult: { updateId: string; version: string; notes: string } | null;
  let checkError: unknown;

  beforeEach(() => {
    localStorage.clear();
    checkResult = null;
    checkError = null;
    invoke.mockReset();
    listen.mockReset();
    invoke.mockImplementation((command: string) => {
      if (command === "get_app_version") return Promise.resolve("0.1.11");
      if (command === "check_for_update") {
        return checkError ? Promise.reject(checkError) : Promise.resolve(checkResult);
      }
      return Promise.resolve(undefined);
    });
    listen.mockResolvedValue(vi.fn());
    (globalThis as any).__TAURI__ = { core: { invoke }, event: { listen } };
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (globalThis as any).__TAURI__;
  });

  it("shows the packaged current version before checking", async () => {
    renderSettings();

    await waitFor(() => expect(screen.getByText("Current version 0.1.11")).toBeTruthy());
    expect(screen.getByText("Check for updates")).toBeTruthy();
  });

  it("distinguishes up to date from a failed check", async () => {
    const view = renderSettings();
    await waitFor(() => screen.getByText("Check for updates"));
    fireEvent.click(screen.getByText("Check for updates"));
    await waitFor(() => expect(screen.getByText("You're on the latest version.")).toBeTruthy());
    expect(screen.getByText(/Last checked/)).toBeTruthy();

    view.unmount();
    checkError = { code: "CHECK_FAILED" };
    renderSettings();
    await waitFor(() => screen.getByText("Check for updates"));
    fireEvent.click(screen.getByText("Check for updates"));

    await waitFor(() => expect(screen.getByText("Couldn't check for updates.")).toBeTruthy());
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("shows the same ready version and restart action", async () => {
    checkResult = { updateId: "update-1", version: "0.1.12", notes: "" };
    renderSettings();
    await waitFor(() => screen.getByText("Check for updates"));
    fireEvent.click(screen.getByText("Check for updates"));

    await waitFor(() => expect(screen.getByText("OpenLoop 0.1.12")).toBeTruthy());
    expect(screen.getByText("Update downloaded and verified")).toBeTruthy();
    expect(screen.getByText("Restart and update")).toBeTruthy();
  });
});
