import type { UpdateDownloadProgress, UpdateInfo } from "../tauri";

export type CheckStatus = "idle" | "checking" | "upToDate" | "updateAvailable" | "error";
export type ArtifactStatus = "none" | "downloading" | "ready" | "installing" | "error";

export type UpdateErrorCode =
  | "CHECK_FAILED"
  | "DOWNLOAD_FAILED"
  | "SIGNATURE_INVALID"
  | "STALE_UPDATE"
  | "UPDATE_BUSY"
  | "NO_UPDATE_SESSION"
  | "INSTALL_PERMISSION_DENIED"
  | "INSTALL_FAILED";

export type UpdateState = {
  checkStatus: CheckStatus;
  artifactStatus: ArtifactStatus;
  currentVersion: string | null;
  update: UpdateInfo | null;
  progress: UpdateDownloadProgress | null;
  checkErrorCode: UpdateErrorCode | null;
  artifactErrorCode: UpdateErrorCode | null;
  lastCheckedAt: number | null;
};

export type UpdateContextValue = {
  state: UpdateState;
  checkManually(): Promise<void>;
  retryDownload(): Promise<void>;
  installAndRestart(): Promise<void>;
  ignoreCurrentVersion(): Promise<void>;
};

export type UpdateAction =
  | { type: "SET_CURRENT_VERSION"; version: string }
  | { type: "CHECK_STARTED" }
  | { type: "CHECK_UP_TO_DATE"; at: number }
  | { type: "CHECK_IGNORED"; at: number }
  | { type: "CHECK_FAILED"; errorCode: UpdateErrorCode; at: number }
  | { type: "UPDATE_FOUND"; update: UpdateInfo; at?: number }
  | { type: "DOWNLOAD_PROGRESS"; progress: UpdateDownloadProgress }
  | { type: "DOWNLOAD_READY"; updateId: string }
  | { type: "DOWNLOAD_FAILED"; updateId: string; errorCode: UpdateErrorCode }
  | { type: "INSTALL_STARTED"; updateId: string }
  | { type: "INSTALL_FAILED"; updateId: string; errorCode: UpdateErrorCode }
  | { type: "CLEAR_UPDATE"; updateId: string };
