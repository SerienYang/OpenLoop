import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateProvider } from "../update/UpdateProvider";
import { UpdateBanner } from "./UpdateBanner";

const FIRST_CHECK_MS = 15_000;

function renderBanner() {
  return render(
    <UpdateProvider>
      <UpdateBanner />
    </UpdateProvider>,
  );
}

describe("UpdateBanner", () => {
  const invoke = vi.fn();
  const listen = vi.fn();
  let finishDownload: (() => void) | null;
  let failDownload: ((error: unknown) => void) | null;
  let checkResult: { updateId: string; version: string; notes: string } | null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    finishDownload = null;
    failDownload = null;
    checkResult = { updateId: "update-1", version: "0.1.12", notes: "" };
    invoke.mockReset();
    listen.mockReset();
    invoke.mockImplementation((command: string) => {
      if (command === "get_app_version") return Promise.resolve("0.1.11");
      if (command === "check_for_update") return Promise.resolve(checkResult);
      if (command === "download_update") {
        return new Promise<void>((resolve, reject) => {
          finishDownload = resolve;
          failDownload = reject;
        });
      }
      return Promise.resolve(undefined);
    });
    listen.mockResolvedValue(vi.fn());
    (globalThis as any).__TAURI__ = { core: { invoke }, event: { listen } };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
    delete (globalThis as any).__TAURI__;
  });

  it("shows the quiet sidebar card while downloading", async () => {
    renderBanner();
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));

    const banner = screen.getByTestId("update-banner");
    expect(banner.textContent).toContain("Preparing update");
    expect(banner.textContent).toContain("v0.1.12");
    expect(banner.textContent).toContain("Ignore this version");
    expect(banner.className).toContain("bottom-3");
  });

  it("offers restart only after the verified download is ready", async () => {
    renderBanner();
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));
    expect(screen.queryByText("Restart and update")).toBeNull();

    await act(async () => finishDownload?.());

    expect(screen.getByText("Update ready")).toBeTruthy();
    expect(screen.getByText("Restart and update")).toBeTruthy();
  });

  it("shows verification failure without an install action", async () => {
    renderBanner();
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));

    await act(async () => failDownload?.({ code: "SIGNATURE_INVALID" }));

    expect(screen.getByText("Update verification failed")).toBeTruthy();
    expect(screen.getByText("Retry download")).toBeTruthy();
    expect(screen.queryByText("Restart and update")).toBeNull();
  });

  it("persists ignore for the current version", async () => {
    renderBanner();
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));

    fireEvent.click(screen.getByText("Ignore this version"));
    await act(async () => {});

    expect(screen.queryByTestId("update-banner")).toBeNull();
    expect(localStorage.getItem("openloop.update.ignoredVersion")).toBe("0.1.12");
    expect(invoke).toHaveBeenCalledWith("clear_pending_update", { updateId: "update-1" });
  });

  it("does not show a banner for a check failure", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_app_version") return Promise.resolve("0.1.11");
      if (command === "check_for_update") return Promise.reject({ code: "CHECK_FAILED" });
      return Promise.resolve(undefined);
    });

    renderBanner();
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));

    expect(screen.queryByTestId("update-banner")).toBeNull();
  });
});
