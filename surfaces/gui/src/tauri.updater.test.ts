import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  clearPendingUpdate,
  downloadUpdate,
  getAppVersion,
  installUpdate,
  listenUpdateDownloadProgress,
} from "./tauri";

describe("Tauri updater bridge", () => {
  const invoke = vi.fn();
  const listen = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
    (globalThis as any).__TAURI__ = { core: { invoke }, event: { listen } };
  });

  afterEach(() => {
    delete (globalThis as any).__TAURI__;
  });

  it("preserves check failures instead of reporting no update", async () => {
    const failure = { code: "CHECK_FAILED" };
    invoke.mockRejectedValueOnce(failure);

    await expect(checkForUpdate()).rejects.toEqual(failure);
  });

  it("binds download, clear, and install commands to an update id", async () => {
    invoke.mockResolvedValue(undefined);

    await downloadUpdate("update-1");
    await clearPendingUpdate("update-1");
    await installUpdate("update-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "download_update", { updateId: "update-1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "clear_pending_update", { updateId: "update-1" });
    expect(invoke).toHaveBeenNthCalledWith(3, "install_update", { updateId: "update-1" });
  });

  it("reads the packaged app version", async () => {
    invoke.mockResolvedValueOnce("0.1.11");

    await expect(getAppVersion()).resolves.toBe("0.1.11");
    expect(invoke).toHaveBeenCalledWith("get_app_version", undefined);
  });

  it("forwards update download progress", async () => {
    const unlisten = vi.fn();
    listen.mockImplementationOnce(async (_event: string, handler: (event: any) => void) => {
      handler({
        payload: {
          updateId: "update-1",
          version: "0.1.12",
          downloadedBytes: 4,
          totalBytes: 10,
        },
      });
      return unlisten;
    });
    const handler = vi.fn();

    const stop = await listenUpdateDownloadProgress(handler);

    expect(listen).toHaveBeenCalledWith("openloop-update-download-progress", expect.any(Function));
    expect(handler).toHaveBeenCalledWith({
      updateId: "update-1",
      version: "0.1.12",
      downloadedBytes: 4,
      totalBytes: 10,
    });
    stop();
    expect(unlisten).toHaveBeenCalled();
  });
});
