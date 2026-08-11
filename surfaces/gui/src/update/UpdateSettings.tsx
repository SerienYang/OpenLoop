import { useI18n } from "../i18n";
import { useUpdate } from "./UpdateProvider";

const BUTTON =
  "shrink-0 rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] hover:border-lineStrong disabled:opacity-50";
const PRIMARY =
  "shrink-0 rounded-lg bg-accent px-3 py-2 text-[12.5px] text-onAccent disabled:opacity-50";

export function UpdateSettings() {
  const { t } = useI18n();
  const { state, checkManually, installAndRestart, retryDownload } = useUpdate();
  const update = state.update;
  const checking = state.checkStatus === "checking";
  const checkFailed = state.checkStatus === "error";
  const downloadError =
    state.artifactStatus === "error" &&
    state.artifactErrorCode !== "INSTALL_FAILED" &&
    state.artifactErrorCode !== "INSTALL_PERMISSION_DENIED";
  const installError =
    state.artifactStatus === "error" &&
    (state.artifactErrorCode === "INSTALL_FAILED" ||
      state.artifactErrorCode === "INSTALL_PERMISSION_DENIED");
  const lastChecked = state.lastCheckedAt
    ? new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(state.lastCheckedAt))
    : null;

  let status = state.currentVersion
    ? t("Current version {{version}}", { version: state.currentVersion })
    : t("Reading current version…");
  let detail = t("Check GitHub for a newer OpenLoop release.");
  let action = {
    label: checking ? t("Checking…") : t("Check for updates"),
    run: () => void checkManually(),
    primary: false,
    disabled: checking,
  };

  if (state.checkStatus === "upToDate" && !update) {
    status = t("You're on the latest version.");
    detail = state.currentVersion
      ? t("Current version {{version}}", { version: state.currentVersion })
      : detail;
    action = { label: t("Check again"), run: () => void checkManually(), primary: false, disabled: false };
  }

  if (checkFailed && !update) {
    status = t("Couldn't check for updates.");
    detail = t("OpenLoop couldn't reach the GitHub update manifest.");
    action = { label: t("Retry"), run: () => void checkManually(), primary: false, disabled: false };
  }

  if (update) {
    status = t("OpenLoop {{version}}", { version: update.version });
    if (state.artifactStatus === "downloading") {
      detail = t("Downloading and verifying the update in the background.");
      action = { label: t("Downloading…"), run: () => {}, primary: false, disabled: true };
    } else if (state.artifactStatus === "ready") {
      detail = t("Update downloaded and verified");
      action = {
        label: t("Restart and update"),
        run: () => void installAndRestart().catch(() => {}),
        primary: true,
        disabled: false,
      };
    } else if (state.artifactStatus === "installing") {
      detail = t("Installing the update. OpenLoop will restart.");
      action = { label: t("Installing…"), run: () => {}, primary: true, disabled: true };
    } else if (downloadError) {
      detail =
        state.artifactErrorCode === "SIGNATURE_INVALID"
          ? t("Update verification failed. Nothing was installed.")
          : t("The update couldn't be downloaded.");
      action = {
        label: t("Retry download"),
        run: () => void retryDownload(),
        primary: false,
        disabled: false,
      };
    } else if (installError) {
      detail =
        state.artifactErrorCode === "INSTALL_PERMISSION_DENIED"
          ? t("Administrator approval may be required to replace the app.")
          : t("The downloaded update is still available.");
      action = {
        label: t("Retry installation"),
        run: () => void installAndRestart().catch(() => {}),
        primary: true,
        disabled: false,
      };
    }
  }

  return (
    <div className="rounded-xl2 border border-line bg-panel p-4" data-testid="settings-update-card">
      <div className="mb-2 text-[12.5px] font-medium text-ink">{t("Updates")}</div>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] text-ink">{status}</div>
          <div className="mt-1 text-[12px] leading-relaxed text-muted">{detail}</div>
          {lastChecked && (
            <div className="mt-1 text-[11px] text-faint">
              {t("Last checked {{time}}", { time: lastChecked })}
            </div>
          )}
          {update && checkFailed && (
            <div className="mt-1 text-[11px] text-faint">
              {t("The latest check failed. The current update state is unchanged.")}
            </div>
          )}
        </div>
        <button className={action.primary ? PRIMARY : BUTTON} onClick={action.run} disabled={action.disabled}>
          {action.label}
        </button>
      </div>
    </div>
  );
}
