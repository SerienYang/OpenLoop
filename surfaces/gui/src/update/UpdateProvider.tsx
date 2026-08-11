import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import {
  checkForUpdate,
  clearPendingUpdate,
  downloadUpdate,
  getAppVersion,
  installUpdate,
  isTauri,
  listenUpdateDownloadProgress,
  type UpdateInfo,
} from "../tauri";
import { initialUpdateState, updateReducer } from "./state";
import type { UpdateContextValue, UpdateErrorCode } from "./types";
import { compareSemver, parseSemver } from "./version";

const FIRST_CHECK_MS = 15_000;
const RECHECK_MS = 30 * 60_000;
const IGNORED_VERSION_KEY = "openloop.update.ignoredVersion";

const UpdateContext = createContext<UpdateContextValue | null>(null);

function errorCode(error: unknown, fallback: UpdateErrorCode): UpdateErrorCode {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: UpdateErrorCode }).code;
  }
  return fallback;
}

function ignoredVersion(): string | null {
  const value = localStorage.getItem(IGNORED_VERSION_KEY);
  if (!value) return null;
  if (!parseSemver(value)) {
    localStorage.removeItem(IGNORED_VERSION_KEY);
    return null;
  }
  return value;
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(updateReducer, initialUpdateState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mountedRef = useRef(true);
  const checkPromiseRef = useRef<Promise<UpdateInfo | null> | null>(null);
  const downloadPromisesRef = useRef(new Map<string, Promise<void>>());
  const installPromiseRef = useRef<Promise<void> | null>(null);

  const download = useCallback((update: UpdateInfo): Promise<void> => {
    const existing = downloadPromisesRef.current.get(update.updateId);
    if (existing) return existing;

    const promise = downloadUpdate(update.updateId)
      .then(() => {
        if (mountedRef.current) {
          dispatch({ type: "DOWNLOAD_READY", updateId: update.updateId });
        }
      })
      .catch((error) => {
        const code = errorCode(error, "DOWNLOAD_FAILED");
        if (code !== "STALE_UPDATE" && mountedRef.current) {
          dispatch({
            type: "DOWNLOAD_FAILED",
            updateId: update.updateId,
            errorCode: code,
          });
        }
        throw error;
      })
      .finally(() => {
        downloadPromisesRef.current.delete(update.updateId);
      });
    downloadPromisesRef.current.set(update.updateId, promise);
    return promise;
  }, []);

  const rawCheck = useCallback((): Promise<UpdateInfo | null> => {
    if (checkPromiseRef.current) return checkPromiseRef.current;
    const promise = checkForUpdate().finally(() => {
      if (checkPromiseRef.current === promise) checkPromiseRef.current = null;
    });
    checkPromiseRef.current = promise;
    return promise;
  }, []);

  const runCheck = useCallback(
    async (manual: boolean): Promise<void> => {
      if (!isTauri()) return;
      dispatch({ type: "CHECK_STARTED" });
      try {
        const update = await rawCheck();
        const at = Date.now();
        if (!mountedRef.current) return;
        if (!update) {
          dispatch({ type: "CHECK_UP_TO_DATE", at });
          return;
        }

        const ignored = ignoredVersion();
        if (!manual && ignored) {
          if (compareSemver(update.version, ignored) <= 0) {
            dispatch({ type: "CHECK_IGNORED", at });
            return;
          }
          localStorage.removeItem(IGNORED_VERSION_KEY);
        } else if (manual && ignored) {
          localStorage.removeItem(IGNORED_VERSION_KEY);
        }

        const current = stateRef.current;
        const sameActiveSession =
          current.update?.updateId === update.updateId &&
          (current.artifactStatus === "downloading" ||
            current.artifactStatus === "ready" ||
            current.artifactStatus === "installing");
        dispatch({ type: "UPDATE_FOUND", update, at });
        if (sameActiveSession) return;
        await download(update).catch(() => {});
      } catch (error) {
        if (mountedRef.current) {
          dispatch({
            type: "CHECK_FAILED",
            errorCode: errorCode(error, "CHECK_FAILED"),
            at: Date.now(),
          });
        }
      }
    },
    [download, rawCheck],
  );

  const checkManually = useCallback(() => runCheck(true), [runCheck]);
  const retryDownload = useCallback(async () => {
    const update = stateRef.current.update;
    if (!update) return;
    dispatch({ type: "UPDATE_FOUND", update });
    await download(update).catch(() => {});
  }, [download]);

  const installAndRestart = useCallback((): Promise<void> => {
    if (installPromiseRef.current) return installPromiseRef.current;
    const update = stateRef.current.update;
    if (!update) return Promise.resolve();
    dispatch({ type: "INSTALL_STARTED", updateId: update.updateId });
    const promise = installUpdate(update.updateId)
      .catch((error) => {
        if (mountedRef.current) {
          dispatch({
            type: "INSTALL_FAILED",
            updateId: update.updateId,
            errorCode: errorCode(error, "INSTALL_FAILED"),
          });
        }
        throw error;
      })
      .finally(() => {
        if (installPromiseRef.current === promise) installPromiseRef.current = null;
      });
    installPromiseRef.current = promise;
    return promise;
  }, []);

  const ignoreCurrentVersion = useCallback(async (): Promise<void> => {
    const update = stateRef.current.update;
    if (!update) return;
    localStorage.setItem(IGNORED_VERSION_KEY, update.version);
    dispatch({ type: "CLEAR_UPDATE", updateId: update.updateId });
    try {
      await clearPendingUpdate(update.updateId);
    } catch (error) {
      if (errorCode(error, "STALE_UPDATE") !== "STALE_UPDATE") throw error;
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    mountedRef.current = true;
    let active = true;
    let unlisten: (() => void) | null = null;
    void listenUpdateDownloadProgress((progress) => {
      if (active) dispatch({ type: "DOWNLOAD_PROGRESS", progress });
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    void getAppVersion()
      .then((version) => {
        if (active) dispatch({ type: "SET_CURRENT_VERSION", version });
      })
      .catch(() => {});
    const first = window.setTimeout(() => void runCheck(false), FIRST_CHECK_MS);
    const recurring = window.setInterval(() => void runCheck(false), RECHECK_MS);
    return () => {
      active = false;
      mountedRef.current = false;
      window.clearTimeout(first);
      window.clearInterval(recurring);
      unlisten?.();
    };
  }, [runCheck]);

  const value = useMemo<UpdateContextValue>(
    () => ({
      state,
      checkManually,
      retryDownload,
      installAndRestart,
      ignoreCurrentVersion,
    }),
    [checkManually, ignoreCurrentVersion, installAndRestart, retryDownload, state],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateContextValue {
  const value = useContext(UpdateContext);
  if (!value) throw new Error("useUpdate must be used inside UpdateProvider");
  return value;
}
