import { describe, expect, it } from "vitest";
import { initialUpdateState, updateReducer } from "./state";
import { compareSemver, parseSemver } from "./version";

const update = { updateId: "update-1", version: "0.1.12", notes: "notes" };

describe("update version ordering", () => {
  it("orders stable and prerelease semantic versions", () => {
    expect(compareSemver("0.1.13", "0.1.12")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-beta.1", "1.0.0-beta.alpha")).toBeLessThan(0);
  });

  it("rejects malformed versions", () => {
    expect(parseSemver("broken")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
  });
});

describe("update reducer", () => {
  it("keeps a ready artifact when a later check fails", () => {
    const ready = updateReducer(
      updateReducer(initialUpdateState, { type: "UPDATE_FOUND", update }),
      { type: "DOWNLOAD_READY", updateId: update.updateId },
    );

    const failedCheck = updateReducer(ready, {
      type: "CHECK_FAILED",
      errorCode: "CHECK_FAILED",
      at: 100,
    });

    expect(failedCheck.checkStatus).toBe("error");
    expect(failedCheck.artifactStatus).toBe("ready");
    expect(failedCheck.update).toEqual(update);
  });

  it("ignores progress from a stale update id", () => {
    const downloading = updateReducer(initialUpdateState, { type: "UPDATE_FOUND", update });

    const next = updateReducer(downloading, {
      type: "DOWNLOAD_PROGRESS",
      progress: {
        updateId: "old-update",
        version: "0.1.11",
        downloadedBytes: 8,
        totalBytes: 10,
      },
    });

    expect(next.progress).toBeNull();
  });

  it("resets artifact progress when a newer session arrives", () => {
    const downloading = updateReducer(
      updateReducer(initialUpdateState, { type: "UPDATE_FOUND", update }),
      {
        type: "DOWNLOAD_PROGRESS",
        progress: {
          updateId: update.updateId,
          version: update.version,
          downloadedBytes: 8,
          totalBytes: 10,
        },
      },
    );

    const newer = updateReducer(downloading, {
      type: "UPDATE_FOUND",
      update: { updateId: "update-2", version: "0.1.13", notes: "" },
    });

    expect(newer.progress).toBeNull();
    expect(newer.artifactStatus).toBe("downloading");
  });

  it("keeps update metadata after an install failure", () => {
    const ready = updateReducer(
      updateReducer(initialUpdateState, { type: "UPDATE_FOUND", update }),
      { type: "DOWNLOAD_READY", updateId: update.updateId },
    );

    const failed = updateReducer(ready, {
      type: "INSTALL_FAILED",
      updateId: update.updateId,
      errorCode: "INSTALL_FAILED",
    });

    expect(failed.artifactStatus).toBe("error");
    expect(failed.update).toEqual(update);
  });

  it("does not claim an ignored automatic update is up to date", () => {
    const checking = updateReducer(initialUpdateState, { type: "CHECK_STARTED" });
    const ignored = updateReducer(checking, { type: "CHECK_IGNORED", at: 100 });

    expect(ignored.checkStatus).toBe("idle");
    expect(ignored.lastCheckedAt).toBe(100);
  });

  it("moves the same session back to downloading when retrying", () => {
    const failed = updateReducer(
      updateReducer(initialUpdateState, { type: "UPDATE_FOUND", update }),
      {
        type: "DOWNLOAD_FAILED",
        updateId: update.updateId,
        errorCode: "DOWNLOAD_FAILED",
      },
    );

    const retrying = updateReducer(failed, { type: "UPDATE_FOUND", update });

    expect(retrying.artifactStatus).toBe("downloading");
    expect(retrying.artifactErrorCode).toBeNull();
  });
});
