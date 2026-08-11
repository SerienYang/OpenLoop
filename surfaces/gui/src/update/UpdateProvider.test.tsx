import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateProvider, useUpdate } from "./UpdateProvider";

const FIRST_CHECK_MS = 15_000;
const RECHECK_MS = 30 * 60_000;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => (resolve = done)), resolve };
}

function Probe() {
  const {
    state,
    checkManually,
    ignoreCurrentVersion,
    installAndRestart,
    retryDownload,
  } = useUpdate();
  return (
    <div>
      <span data-testid="phase">{state.artifactStatus}</span>
      <span data-testid="version">{state.update?.version ?? ""}</span>
      <span data-testid="downloaded">{state.progress?.downloadedBytes ?? ""}</span>
      <button onClick={() => void checkManually()}>manual</button>
      <button onClick={() => void ignoreCurrentVersion()}>ignore</button>
      <button onClick={() => void retryDownload()}>retry</button>
      <button onClick={() => void installAndRestart()}>install</button>
    </div>
  );
}

describe("UpdateProvider", () => {
  const invoke = vi.fn();
  const listen = vi.fn();
  let candidate: { updateId: string; version: string; notes: string } | null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    candidate = { updateId: "update-1", version: "0.1.12", notes: "" };
    invoke.mockReset();
    listen.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === "get_app_version") return "0.1.11";
      if (command === "check_for_update") return candidate;
      return undefined;
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

  it("checks after boot and downloads a discovered update once", async () => {
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );

    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));

    expect(invoke).toHaveBeenCalledWith("check_for_update", undefined);
    expect(invoke).toHaveBeenCalledWith("download_update", { updateId: "update-1" });
    expect(screen.getByTestId("phase").textContent).toBe("ready");
    expect(screen.getByTestId("version").textContent).toBe("0.1.12");
  });

  it("does not download the same ready session again on a periodic check", async () => {
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );

    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));
    await act(() => vi.advanceTimersByTimeAsync(RECHECK_MS));

    expect(invoke.mock.calls.filter(([command]) => command === "check_for_update")).toHaveLength(2);
    expect(invoke.mock.calls.filter(([command]) => command === "download_update")).toHaveLength(1);
    expect(screen.getByTestId("phase").textContent).toBe("ready");
  });

  it("lets a manual check join an automatic check and still bypass an ignored version", async () => {
    const check = deferred<typeof candidate>();
    localStorage.setItem("openloop.update.ignoredVersion", "0.1.12");
    invoke.mockImplementation((command: string) => {
      if (command === "get_app_version") return Promise.resolve("0.1.11");
      if (command === "check_for_update") return check.promise;
      return Promise.resolve(undefined);
    });
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );

    await act(async () => {
      vi.advanceTimersByTime(FIRST_CHECK_MS);
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("manual"));
    await act(async () => check.resolve(candidate));

    expect(invoke.mock.calls.filter(([command]) => command === "check_for_update")).toHaveLength(1);
    expect(invoke.mock.calls.filter(([command]) => command === "download_update")).toHaveLength(1);
    expect(localStorage.getItem("openloop.update.ignoredVersion")).toBeNull();
  });

  it("persists an ignored version but reoffers a newer semantic version", async () => {
    const view = render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));
    fireEvent.click(screen.getByText("ignore"));
    await act(async () => {});

    expect(localStorage.getItem("openloop.update.ignoredVersion")).toBe("0.1.12");
    view.unmount();
    candidate = { updateId: "update-2", version: "0.1.13", notes: "" };
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));

    expect(screen.getByTestId("version").textContent).toBe("0.1.13");
    expect(localStorage.getItem("openloop.update.ignoredVersion")).toBeNull();
  });

  it("cleans every delayed listener created by StrictMode", async () => {
    const first = deferred<() => void>();
    const second = deferred<() => void>();
    const stopFirst = vi.fn();
    const stopSecond = vi.fn();
    listen.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(
      <StrictMode>
        <UpdateProvider>
          <Probe />
        </UpdateProvider>
      </StrictMode>,
    );

    view.unmount();
    await act(async () => {
      first.resolve(stopFirst);
      second.resolve(stopSecond);
      await Promise.all([first.promise, second.promise]);
    });

    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).toHaveBeenCalledOnce();
  });

  it("coalesces repeated installation requests", async () => {
    const install = deferred<void>();
    invoke.mockImplementation((command: string) => {
      if (command === "get_app_version") return Promise.resolve("0.1.11");
      if (command === "check_for_update") return Promise.resolve(candidate);
      if (command === "install_update") return install.promise;
      return Promise.resolve(undefined);
    });
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));

    fireEvent.click(screen.getByText("install"));
    fireEvent.click(screen.getByText("install"));
    await act(async () => Promise.resolve());

    expect(invoke.mock.calls.filter(([command]) => command === "install_update")).toHaveLength(1);
  });

  it("does not let an older download completion replace a newer ready session", async () => {
    const oldDownload = deferred<void>();
    invoke.mockImplementation((command: string, args?: { updateId?: string }) => {
      if (command === "get_app_version") return Promise.resolve("0.1.11");
      if (command === "check_for_update") return Promise.resolve(candidate);
      if (command === "download_update" && args?.updateId === "update-1") {
        return oldDownload.promise;
      }
      return Promise.resolve(undefined);
    });
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
    await act(async () => {
      vi.advanceTimersByTime(FIRST_CHECK_MS);
      await Promise.resolve();
    });

    candidate = { updateId: "update-2", version: "0.1.13", notes: "" };
    fireEvent.click(screen.getByText("manual"));
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("version").textContent).toBe("0.1.13");
    expect(screen.getByTestId("phase").textContent).toBe("ready");

    await act(async () => oldDownload.resolve());
    expect(screen.getByTestId("version").textContent).toBe("0.1.13");
    expect(screen.getByTestId("phase").textContent).toBe("ready");
  });

  it("retries a failed download for the same session", async () => {
    let attempts = 0;
    invoke.mockImplementation((command: string) => {
      if (command === "get_app_version") return Promise.resolve("0.1.11");
      if (command === "check_for_update") return Promise.resolve(candidate);
      if (command === "download_update") {
        attempts += 1;
        return attempts === 1
          ? Promise.reject({ code: "DOWNLOAD_FAILED" })
          : Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));
    expect(screen.getByTestId("phase").textContent).toBe("error");

    fireEvent.click(screen.getByText("retry"));
    await act(async () => Promise.resolve());

    expect(attempts).toBe(2);
    expect(screen.getByTestId("phase").textContent).toBe("ready");
  });

  it("does not revive a download that was ignored while in flight", async () => {
    const activeDownload = deferred<void>();
    invoke.mockImplementation((command: string) => {
      if (command === "get_app_version") return Promise.resolve("0.1.11");
      if (command === "check_for_update") return Promise.resolve(candidate);
      if (command === "download_update") return activeDownload.promise;
      return Promise.resolve(undefined);
    });
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
    await act(async () => {
      vi.advanceTimersByTime(FIRST_CHECK_MS);
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("ignore"));
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("phase").textContent).toBe("none");

    await act(async () => activeDownload.resolve());
    expect(screen.getByTestId("phase").textContent).toBe("none");
    expect(screen.getByTestId("version").textContent).toBe("");
  });

  it("ignores progress from an older update id", async () => {
    let progressHandler: ((event: any) => void) | null = null;
    listen.mockImplementation(async (_event: string, handler: (event: any) => void) => {
      progressHandler = handler;
      return vi.fn();
    });
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));
    candidate = { updateId: "update-2", version: "0.1.13", notes: "" };
    fireEvent.click(screen.getByText("manual"));
    await act(async () => Promise.resolve());

    act(() =>
      progressHandler?.({
        payload: {
          updateId: "update-1",
          version: "0.1.12",
          downloadedBytes: 99,
          totalBytes: 100,
        },
      }),
    );

    expect(screen.getByTestId("version").textContent).toBe("0.1.13");
    expect(screen.getByTestId("downloaded").textContent).toBe("");
  });

  it("keeps a ready update when a later check returns no candidate", async () => {
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS));
    candidate = null;

    await act(() => vi.advanceTimersByTimeAsync(RECHECK_MS));

    expect(screen.getByTestId("phase").textContent).toBe("ready");
    expect(screen.getByTestId("version").textContent).toBe("0.1.12");
  });
});
