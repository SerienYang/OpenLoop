import { useI18n } from "../i18n";
import { isTauri } from "../tauri";
import { useUpdate } from "../update/UpdateProvider";

export function UpdateBanner() {
  const { t } = useI18n();
  const { state, ignoreCurrentVersion, installAndRestart, retryDownload } = useUpdate();
  const update = state.update;

  if (!isTauri() || !update || state.artifactStatus === "none") return null;

  const installError =
    state.artifactErrorCode === "INSTALL_FAILED" ||
    state.artifactErrorCode === "INSTALL_PERMISSION_DENIED";
  const verificationError = state.artifactErrorCode === "SIGNATURE_INVALID";
  const progress =
    state.progress?.totalBytes && state.progress.totalBytes > 0
      ? Math.min(100, Math.round((state.progress.downloadedBytes / state.progress.totalBytes) * 100))
      : null;

  let title = t("Preparing update");
  let description = t("Downloading OpenLoop v{{version}} in the background.", {
    version: update.version,
  });
  if (state.artifactStatus === "ready") {
    title = t("Update ready");
    description = t("The verified update is ready. Restart to finish installing it.");
  } else if (state.artifactStatus === "installing") {
    title = t("Installing update");
    description = t("OpenLoop will restart when the update is installed.");
  } else if (state.artifactStatus === "error") {
    if (verificationError) {
      title = t("Update verification failed");
      description = t("Nothing was installed. Try downloading the update again later.");
    } else if (installError) {
      title = t("Update not completed");
      description =
        state.artifactErrorCode === "INSTALL_PERMISSION_DENIED"
          ? t("Administrator approval may be required to replace the app.")
          : t("The downloaded update is still available. Try installing it again.");
    } else {
      title = t("Update download failed");
      description = t("Check your connection and try downloading the update again.");
    }
  }

  const primary =
    state.artifactStatus === "ready" || installError
      ? {
          label: t("Restart and update"),
          action: () => void installAndRestart().catch(() => {}),
        }
      : state.artifactStatus === "error"
        ? {
            label: t("Retry download"),
            action: () => void retryDownload(),
          }
        : null;

  return (
    <div
      className="fixed bottom-3 left-3 z-[35] w-[240px] rounded-xl border border-line bg-panel shadow-2xl px-3.5 py-3"
      role="status"
      data-testid="update-banner"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12.5px] font-semibold text-ink">{title}</div>
        <div className="text-[10.5px] tabular-nums text-faint">v{update.version}</div>
      </div>
      <div className="mt-1 text-[11.5px] leading-[1.45] text-muted">{description}</div>

      {state.artifactStatus === "downloading" && (
        <div className="mt-2.5">
          <div className="h-[3px] overflow-hidden rounded-full bg-line">
            <div
              className={
                "h-full rounded-full bg-accent transition-[width] duration-200 " +
                (progress === null ? "w-1/3 animate-pulse" : "")
              }
              style={progress === null ? undefined : { width: `${progress}%` }}
            />
          </div>
          <div className="mt-1.5 text-[10.5px] tabular-nums text-faint">
            {progress === null ? t("Downloading…") : t("{{progress}}% downloaded", { progress })}
          </div>
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        {primary && (
          <button
            className="rounded-lg bg-accent px-2.5 py-1.5 text-[11.5px] font-medium text-onAccent disabled:opacity-50"
            onClick={primary.action}
            disabled={state.artifactStatus === "installing"}
            data-testid="update-primary"
          >
            {primary.label}
          </button>
        )}
        <button
          className="px-1.5 py-1.5 text-[11.5px] text-faint hover:text-muted disabled:opacity-50"
          onClick={() => void ignoreCurrentVersion().catch(() => {})}
          disabled={state.artifactStatus === "installing"}
          data-testid="update-ignore"
        >
          {t("Ignore this version")}
        </button>
      </div>
    </div>
  );
}
