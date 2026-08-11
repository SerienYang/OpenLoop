import type { UpdateAction, UpdateState } from "./types";

export const initialUpdateState: UpdateState = {
  checkStatus: "idle",
  artifactStatus: "none",
  currentVersion: null,
  update: null,
  progress: null,
  checkErrorCode: null,
  artifactErrorCode: null,
  lastCheckedAt: null,
};

export function updateReducer(state: UpdateState, action: UpdateAction): UpdateState {
  switch (action.type) {
    case "SET_CURRENT_VERSION":
      return { ...state, currentVersion: action.version };
    case "CHECK_STARTED":
      return { ...state, checkStatus: "checking", checkErrorCode: null };
    case "CHECK_UP_TO_DATE":
      return {
        ...state,
        checkStatus: "upToDate",
        checkErrorCode: null,
        lastCheckedAt: action.at,
      };
    case "CHECK_IGNORED":
      return {
        ...state,
        checkStatus: "idle",
        checkErrorCode: null,
        lastCheckedAt: action.at,
      };
    case "CHECK_FAILED":
      return {
        ...state,
        checkStatus: "error",
        checkErrorCode: action.errorCode,
        lastCheckedAt: action.at,
      };
    case "UPDATE_FOUND":
      if (state.update?.updateId === action.update.updateId) {
        return {
          ...state,
          checkStatus: "updateAvailable",
          artifactStatus: state.artifactStatus === "error" ? "downloading" : state.artifactStatus,
          artifactErrorCode: state.artifactStatus === "error" ? null : state.artifactErrorCode,
          progress: state.artifactStatus === "error" ? null : state.progress,
          checkErrorCode: null,
          lastCheckedAt: action.at ?? state.lastCheckedAt,
        };
      }
      return {
        ...state,
        checkStatus: "updateAvailable",
        artifactStatus: "downloading",
        update: action.update,
        progress: null,
        checkErrorCode: null,
        artifactErrorCode: null,
        lastCheckedAt: action.at ?? state.lastCheckedAt,
      };
    case "DOWNLOAD_PROGRESS":
      if (state.update?.updateId !== action.progress.updateId) return state;
      return { ...state, artifactStatus: "downloading", progress: action.progress };
    case "DOWNLOAD_READY":
      if (state.update?.updateId !== action.updateId) return state;
      return {
        ...state,
        artifactStatus: "ready",
        progress: state.progress
          ? { ...state.progress, downloadedBytes: state.progress.totalBytes ?? state.progress.downloadedBytes }
          : null,
        artifactErrorCode: null,
      };
    case "DOWNLOAD_FAILED":
      if (state.update?.updateId !== action.updateId) return state;
      return { ...state, artifactStatus: "error", artifactErrorCode: action.errorCode };
    case "INSTALL_STARTED":
      if (state.update?.updateId !== action.updateId) return state;
      return { ...state, artifactStatus: "installing", artifactErrorCode: null };
    case "INSTALL_FAILED":
      if (state.update?.updateId !== action.updateId) return state;
      return { ...state, artifactStatus: "error", artifactErrorCode: action.errorCode };
    case "CLEAR_UPDATE":
      if (state.update?.updateId !== action.updateId) return state;
      return {
        ...state,
        artifactStatus: "none",
        update: null,
        progress: null,
        artifactErrorCode: null,
      };
  }
}
