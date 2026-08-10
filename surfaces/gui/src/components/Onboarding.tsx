import { useEffect, useState } from "react";
import {
  getConnectors,
  setOnboarded,
  setSessionRoot,
  validateFolder,
  type Connector,
} from "../api";
import { ConnectorBadge } from "../connectors/ConnectorIcon";
import { useI18n } from "../i18n";
import {
  ProviderForm,
  useProviderSetup,
} from "../providers/ProviderSetup";
import { ProviderGallery } from "../providers/ProviderGallery";
import { chooseFolder } from "../tauri";

const TOOL_ROWS = [
  {
    name: "outlook",
    benefit: "Stay on top of email",
    detail: "Outlook — triage mail, draft replies, run your calendar.",
  },
  {
    name: "slack",
    benefit: "Keep up with Slack",
    detail: "Slack — catch up, answer mentions, post updates.",
  },
  {
    name: "github",
    benefit: "Ship code",
    detail: "GitHub — review pull requests and work with issues.",
  },
  {
    name: "notion",
    benefit: "Keep your notes in reach",
    detail: "Notion — search pages, query databases, draft docs.",
  },
  {
    name: "hubspot",
    benefit: "Keep the CRM current",
    detail: "HubSpot — update deals, log notes, prep calls.",
  },
  {
    name: "attio",
    benefit: "Track every relationship",
    detail: "Attio — search records, read timelines, log notes.",
  },
];

export function Onboarding({
  onDone,
}: {
  onDone: (next?: "work" | "automations") => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [folderPath, setFolderPath] = useState("");
  const [folderOk, setFolderOk] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState("");
  const [skipConfirm, setSkipConfirm] = useState(false);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const ps = useProviderSetup({ surface: "onboarding" });

  const anyReady =
    ps.providers.some((provider) => provider.configured && provider.needs_key) ||
    ps.keylessOk.size > 0;
  const nextFromForm = !!ps.sel && ps.dirty && ps.secretFilled;
  const canNext = anyReady || nextFromForm;

  useEffect(() => {
    if (step !== 2) return;
    getConnectors().then(setConnectors).catch(() => setConnectors([]));
  }, [step]);

  const pickWorkFolder = async () => {
    setFolderBusy(true);
    setFolderError("");
    try {
      const picked = await chooseFolder();
      if (!picked) {
        setFolderOk(false);
        setFolderError(t("No folder selected."));
        return;
      }
      const validation = await validateFolder(picked);
      if (!validation.ok || !validation.writable) {
        setFolderOk(false);
        setFolderPath(picked);
        setFolderError(validation.error || t("That folder is not writable."));
        return;
      }
      setFolderPath(picked);
      setFolderOk(true);
    } catch (err) {
      setFolderOk(false);
      setFolderError(err instanceof Error ? err.message : t("Could not validate folder."));
    } finally {
      setFolderBusy(false);
    }
  };

  const continueFromFolder = async () => {
    if (!folderOk || !folderPath) return;
    setFolderBusy(true);
    setFolderError("");
    try {
      const res = await setSessionRoot(folderPath);
      if (!res.ok) {
        setFolderError(res.error || t("Could not save folder."));
        return;
      }
      setStep(1);
    } finally {
      setFolderBusy(false);
    }
  };

  const advance = async () => {
    if (nextFromForm && !ps.credentialed) {
      ps.cancelBackTimer();
      if (!(await ps.runTestAndSave())) return;
    }
    setStep(2);
  };

  const finish = async (next?: "work" | "automations") => {
    await setOnboarded(true).catch(() => {});
    onDone(next);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/30 grid place-items-center"
      data-testid="onboarding"
    >
      <div className="w-[600px] max-w-[92vw] h-[560px] max-h-[88vh] rounded-2xl border border-line bg-panel shadow-2xl p-8 flex flex-col">
        <div className="flex justify-center gap-2 mb-6">
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              className={
                "w-1.5 h-1.5 rounded-full " +
                (index <= step ? "bg-accent" : "bg-line")
              }
            />
          ))}
        </div>

        {step === 0 && (
          <section
            data-testid="ob-step-folder"
            className="flex-1 min-h-0 flex flex-col"
          >
            <h1 className="text-[19px] font-semibold">
              {t("Choose work folder")}
            </h1>
            <p className="text-[13px] text-muted mt-0.5 mb-5">
              {t(
                "OpenLoop stores conversation files and working copies in this folder. Pick a local folder you control.",
              )}
            </p>
            <div className="rounded-xl border border-line bg-paper px-4 py-4">
              <span className="block text-[12px] uppercase tracking-[0.18em] text-faint mb-1">
                {t("Work folder")}
              </span>
              <div
                className="min-h-[40px] rounded-lg border border-line bg-panel px-3 py-2 text-[13px] text-muted break-all"
                data-testid="ob-folder-path"
              >
                {folderPath || t("No folder selected")}
              </div>
              {folderOk && (
                <p className="text-[12px] text-ok mt-2">
                  {t("Folder is writable.")}
                </p>
              )}
              {folderError && (
                <p className="text-[12px] text-danger mt-2">{folderError}</p>
              )}
            </div>
            <div className="mt-auto flex items-center gap-3 pt-5">
              <button
                className="px-4 py-2 rounded-full border border-line text-[13px] hover:border-accent disabled:opacity-40"
                onClick={pickWorkFolder}
                disabled={folderBusy}
                data-testid="ob-choose-folder"
              >
                {folderBusy ? t("Checking…") : t("Choose folder")}
              </button>
              <button
                className="ml-auto px-6 py-2 rounded-full bg-ink text-panel text-[13px] disabled:opacity-40"
                disabled={!folderOk || folderBusy}
                onClick={continueFromFolder}
                data-testid="ob-continue-folder"
              >
                {t("Next")}
              </button>
            </div>
            <p className="text-[11px] text-faint mt-3">
              {t("You can change this later in Settings ▸ General.")}
            </p>
          </section>
        )}

        {step === 1 && (
          <section
            data-testid="ob-step-model"
            className="flex-1 min-h-0 flex flex-col"
          >
            <h1 className="text-[19px] font-semibold">
              {t("Welcome to OpenLoop")}
              <span className="beta-tag">BETA</span>
            </h1>
            <p className="text-[13px] text-muted mt-0.5 mb-4">
              {t(
                "Pick a model provider to get started — OpenLoop runs on your own key, and your key and your data stay on this computer.",
              )}
            </p>
            {!ps.sel ? (
              <div
                className="flex-1 min-h-0 overflow-y-auto pr-1"
                data-testid="ob-provider-gallery"
              >
                <ProviderGallery ps={ps} tp="ob" surface="onboarding" />
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                <ProviderForm ps={ps} tp="ob" />
              </div>
            )}
            <div className="flex items-center gap-3 pt-5">
              {!skipConfirm ? (
                <button
                  className="text-[12.5px] text-faint hover:text-muted"
                  onClick={() => setSkipConfirm(true)}
                >
                  {t("Skip setup")}
                </button>
              ) : (
                <span className="text-[12.5px] text-muted">
                  {t("Nothing works without a model —")}{" "}
                  <button className="text-accent" onClick={() => finish()}>
                    {t("skip anyway")}
                  </button>
                </span>
              )}
              <button
                className="ml-auto px-6 py-2 rounded-full bg-ink text-panel text-[13px] disabled:opacity-40"
                disabled={!canNext || ps.verify.state === "testing"}
                onClick={advance}
                data-testid="ob-continue"
              >
                {ps.verify.state === "testing" ? t("Checking…") : t("Next")}
              </button>
            </div>
            <p className="text-[11px] text-faint mt-3">
              {t("Models can be enabled or hidden anytime in Settings ▸ Models.")}
            </p>
          </section>
        )}

        {step === 2 && (
          <section
            data-testid="ob-step-tools"
            className="flex-1 min-h-0 flex flex-col"
          >
            <h1 className="text-[19px] font-semibold">
              {t("Connect your everyday tools")}
            </h1>
            <p className="text-[13px] text-muted mt-0.5 mb-3">
              {t(
                "Connections use credentials you provide, or a local vendor OAuth flow when supported.",
              )}
            </p>
            <div
              className="flex-1 min-h-0 overflow-y-auto pr-1"
              data-testid="ob-tool-gallery"
            >
              {TOOL_ROWS.map(({ name, benefit, detail }) => {
                const connector = connectors.find((item) => item.name === name);
                if (!connector) return null;
                return (
                  <div
                    key={name}
                    className="flex items-center gap-3 py-2 border-b border-paper last:border-0"
                    data-testid={`ob-tool-${name}`}
                  >
                    <ConnectorBadge
                      connector={connector}
                      size={34}
                      title={connector.title}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-semibold leading-tight">
                        {t(benefit)}
                      </span>
                      <span className="block text-[12px] text-muted truncate">
                        {t(detail)}
                      </span>
                    </span>
                    <span
                      className={
                        "text-[12px] shrink-0 " +
                        (connector.connected
                          ? "text-ok font-medium"
                          : "text-faint")
                      }
                    >
                      {connector.connected
                        ? t("✓ Connected")
                        : t("Configure in Connectors")}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-3.5 rounded-xl border border-line bg-paper px-4 py-3 text-[12.5px] text-muted">
              <span className="block text-[13px] font-semibold text-ink mb-0.5">
                {t("Local by default")}
              </span>
              {t(
                "Tokens stay on this computer. Add or remove connections later from the Connectors page.",
              )}
            </div>
            <div className="flex items-center mt-3.5">
              <button
                className="ml-auto px-6 py-2 rounded-full bg-ink text-panel text-[13px]"
                onClick={() => setStep(3)}
                data-testid="ob-continue-tools"
              >
                {t("Next")}
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section
            data-testid="ob-step-done"
            className="flex-1 min-h-0 flex flex-col overflow-y-auto"
          >
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-okSoft text-ok grid place-items-center mx-auto mb-3 text-[22px]">
                ✓
              </div>
              <h1 className="text-[19px] font-semibold mb-1">
                {t("You're set up")}
              </h1>
              <p className="text-[13px] text-muted mb-5">
                {t("Two good ways to start:")}
              </p>
            </div>
            <button
              className="w-full flex items-start gap-3 rounded-xl2 border border-line hover:border-accent bg-panel px-4 py-3.5"
              onClick={() => finish("automations")}
              data-testid="ob-cta-automation"
            >
              <span className="w-9 h-9 rounded-lg bg-accentSoft text-accent grid place-items-center text-[15px] shrink-0">
                ◷
              </span>
              <span className="flex-1 min-w-0 text-left">
                <b className="block text-[13.5px]">
                  {t("Create your first automation")}
                </b>
                <span className="text-[12px] text-muted">
                  {t(
                    "A weekly digest, a morning brief — pick a template, running in two minutes.",
                  )}
                </span>
              </span>
              <span className="text-faint self-center">›</span>
            </button>
            <button
              className="w-full flex items-start gap-3 rounded-xl2 border border-line hover:border-accent bg-panel px-4 py-3.5 mt-2.5"
              onClick={() => finish("work")}
              data-testid="ob-start"
            >
              <span className="w-9 h-9 rounded-lg bg-accentSoft text-accent grid place-items-center text-[15px] shrink-0">
                ✦
              </span>
              <span className="flex-1 min-w-0 text-left">
                <b className="block text-[13.5px]">
                  {t("Start working with OpenLoop")}
                </b>
                <span className="text-[12px] text-muted">
                  {t("Open a session and just ask — analyze files, draft, research, build.")}
                </span>
              </span>
              <span className="text-faint self-center">›</span>
            </button>
            <p className="text-[11px] text-faint text-center mt-auto pt-5">
              {t("You can change models and tools later in Settings.")}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
