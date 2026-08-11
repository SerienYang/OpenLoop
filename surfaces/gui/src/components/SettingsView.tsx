import { useEffect, useState } from "react";
import {
  deleteSession,
  getArchivedSessions,
  getProjects,
  getSettings,
  relocateProject,
  reopenProject,
  setCompactionSettings,
  setContextBar,
  setPdfSettings,
  setSessionRoot,
  setSessionsPeek,
  setSessionFlags,
  validateFolder,
  type ArchivedSessionInfo,
  type CompactionSettings,
  type PdfSettings,
  type ProjectInfo,
} from "../api";
import {
  cancelDictationModelDownload,
  deleteDictationModel,
  downloadDictationModel,
  getAwakeRule,
  getAutostart,
  getDictationStatus,
  isTauri,
  listenDictationDownloadProgress,
  markDictationTestPassed,
  openExternal,
  chooseFolder,
  setAwakeRule,
  setAutostart,
  startDictation,
  stopDictation,
  verifyDictationModel,
  type AwakeRule,
  type DictationDownloadProgress,
  type DictationStatus,
} from "../tauri";
import { useThemePref } from "../theme";
import { UpdateSettings } from "../update/UpdateSettings";
import { Icon } from "./Icon";
import { PanelHead } from "./IntegrationsView";
import { McpTab, ModelsTab } from "./ManageTabs";
import { AuditLogPanel } from "./AuditView";
import { ConnectorsSection } from "./connectors/ConnectorsSection";
import { LANG_LABELS, useI18n } from "../i18n";
import { SkillsTab } from "./SkillsTab";

// Settings, restructured into a full-page surface: a left sub-nav + centered panel, replacing
// the old top-tab ManageModal. Connectors live here again so global app configuration is in one
// place; Privacy & Security carries the operation log.
// "appearance" is the General tab's stable key — callers deep-link with it, so the
// rename (UX-021) changed only the label.
export type SettingsTab =
  | "appearance"
  | "privacy"
  | "conversations"
  | "connectors"
  | "mcp"
  | "models"
  | "skills"
  | "voice";

const CARD = "rounded-xl2 border border-line bg-panel";
const FIELD_LABEL = "text-[12.5px] font-medium text-ink";
const FIELD_HELP = "text-[12px] text-muted mt-1.5 leading-relaxed";
const BTN_ACCENT = "text-[12.5px] px-3 py-2 rounded-lg bg-accent text-onAccent shrink-0 disabled:opacity-40";
const BTN_BORDERED =
  "text-[12.5px] px-3 py-2 rounded-lg border border-line bg-paper hover:border-lineStrong shrink-0";
const CONTROL_ROW = "grid grid-cols-[20px_minmax(0,1fr)] gap-3 items-start";

const SET_TABS: {
  key: SettingsTab;
  label: string;
  icon: "sliders" | "inbox" | "plug" | "code" | "mic" | "shield" | "book";
}[] = [
  { key: "appearance", label: "General", icon: "sliders" },
  { key: "privacy", label: "Privacy & Security", icon: "shield" },
  { key: "conversations", label: "Conversations", icon: "inbox" },
  { key: "connectors", label: "Connectors", icon: "plug" },
  { key: "mcp", label: "MCP servers", icon: "code" },
  { key: "models", label: "Models", icon: "code" },
  { key: "skills", label: "Skills", icon: "book" },
  { key: "voice", label: "Voice input", icon: "mic" },
];

export function SettingsView({
  initialTab,
  onCreateSkill,
  onConversationsChanged,
}: {
  initialTab?: SettingsTab;
  // Skills doorway (SKILLS-SPEC §5.2): start a new conversation with the description
  // prefilled — the worker builds the skill and proposes it via save_skill.
  onCreateSkill?: (description: string) => void;
  onConversationsChanged?: () => void;
}) {
  const { t } = useI18n();
  const tabs = SET_TABS;
  const wanted = initialTab && tabs.some((item) => item.key === initialTab) ? initialTab : "appearance";
  const [tab, setTab] = useState<SettingsTab>(wanted);

  return (
    <main className="flex-1 min-w-0 flex bg-paper">
      <nav className="page-subnav w-[208px] shrink-0 border-r border-line bg-panel/40 px-3 py-4">
        <div className="px-2 text-[13.5px] font-semibold mb-3 flex items-center gap-2">
          <Icon name="gear" size={16} /> {t("Settings")}
        </div>
        {tabs.map((item) => {
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              className={
                "w-full text-left px-2.5 py-2 rounded-lg text-[13px] flex items-center gap-2 " +
                (active ? "bg-paper text-accent font-medium" : "text-muted hover:bg-paper hover:text-ink")
              }
              onClick={() => setTab(item.key)}
            >
              <Icon name={item.icon} size={15} /> {t(item.label)}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-w-0 overflow-y-auto hairline-scroll">
        <div className="max-w-3xl mx-auto px-7 py-6">
          {tab === "appearance" ? (
            <AppearanceSection />
          ) : tab === "privacy" ? (
            <AuditLogPanel />
          ) : tab === "conversations" ? (
            <ConversationsSection onChanged={onConversationsChanged} />
          ) : tab === "connectors" ? (
            <section>
              <PanelHead
                title={t("Connectors")}
                sub={t("Apps and tools OpenLoop can use. Connected ones come first.")}
              />
              <ConnectorsSection />
            </section>
          ) : tab === "mcp" ? (
            <section>
              <PanelHead
                title={t("MCP servers")}
                sub={t("External tool servers (stdio or HTTP), shared across all agents.")}
              />
              <McpTab />
            </section>
          ) : tab === "models" ? (
            <section>
              <PanelHead
                title={t("Models")}
                sub={t("Providers and the models offered in the composer's picker. Keys are stored only on this computer.")}
              />
              <ModelsTab />
              {/* Token savings is model-spend behavior, so it lives here (UX-021),
                  not under General. */}
              <div className="mt-6">
                <TokenSavingsCard />
                <CompactionCard />
              </div>
            </section>
          ) : tab === "skills" ? (
            <SkillsTab onCreateSkill={onCreateSkill} />
          ) : tab === "voice" ? (
            <VoiceInputSection />
          ) : (
            <AppearanceSection />
          )}
        </div>
      </div>
    </main>
  );
}

// -- Conversations: archived conversations + removed projects ------------------
function ConversationsSection({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const [archived, setArchived] = useState<ArchivedSessionInfo[] | null>(null);
  const [removed, setRemoved] = useState<ProjectInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    getArchivedSessions()
      .then(setArchived)
      .catch(() => setArchived([]));
    getProjects({ includeHidden: true })
      .then((projects) => setRemoved(projects.filter((p) => p.hidden)))
      .catch(() => setRemoved([]));
  };

  useEffect(() => {
    refresh();
  }, []);

  const changed = () => {
    refresh();
    onChanged?.();
  };

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      changed();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error || t("Something went wrong.")));
    } finally {
      setBusy(null);
    }
  };

  const ensureProjectAvailable = async (s: ArchivedSessionInfo) => {
    if (!s.project_id) return;
    if (s.project_hidden) {
      const restoreProject = window.confirm(
        t("This conversation belongs to a removed project. Restore the project too so it appears in the sidebar? Cancel restores only the conversation."),
      );
      if (!restoreProject) return;
      const reopened = await reopenProject(s.project_id);
      if (!reopened.ok) throw new Error(reopened.error || t("Could not reopen the project."));
    }
  };

  const restoreSession = (s: ArchivedSessionInfo) =>
    withBusy(`restore:${s.session_id}`, async () => {
      await ensureProjectAvailable(s);
      const res = await setSessionFlags(s.session_id, { archived: false });
      if (!res.ok) throw new Error(res.error || t("Could not restore the conversation."));
    });

  const deleteArchived = (s: ArchivedSessionInfo) =>
    withBusy(`delete:${s.session_id}`, async () => {
      if (!window.confirm(t("Delete this archived conversation permanently?"))) return;
      const res = await deleteSession(s.session_id);
      if (!res.ok) throw new Error(res.error || t("Could not delete the conversation."));
    });

  const reopenRemoved = (project: ProjectInfo) =>
    withBusy(`project:${project.project_id}`, async () => {
      if (project.path_exists === false) {
        const picked = await chooseFolder();
        if (!picked) throw new Error(t("No folder selected."));
        const res = await relocateProject(project.project_id, picked);
        if (!res.ok) throw new Error(res.error || t("Could not update the project folder."));
        return;
      }
      const res = await reopenProject(project.project_id);
      if (!res.ok) throw new Error(res.error || t("Could not reopen the project."));
    });

  const restoreLabel = (s: ArchivedSessionInfo) =>
    s.project_hidden ? t("Restore") : t("Restore");

  return (
    <section>
      <PanelHead
        title={t("Conversations")}
        sub={t("Manage archived conversations and removed projects.")}
      />
      {err && (
        <div className="mb-3 rounded-lg border border-dangerSoft bg-dangerSoft px-3 py-2 text-[12px] text-danger">
          {err}
        </div>
      )}

      <div className={CARD + " p-4 mb-4"} data-testid="archived-conversations-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={FIELD_LABEL}>{t("Archived conversations")}</div>
            <div className={FIELD_HELP}>
              {t("Restore or delete conversations you previously archived.")}
            </div>
          </div>
          <span className="text-[12px] text-muted rounded-lg border border-line px-2 py-1">
            {archived ? t("{{count}} conversations", { count: archived.length }) : t("Loading…")}
          </span>
        </div>
        <div className="mt-3 divide-y divide-line">
          {archived === null ? (
            <div className="text-[12px] text-muted py-3">{t("Loading…")}</div>
          ) : archived.length === 0 ? (
            <div className="text-[12px] text-muted py-3">{t("No archived conversations.")}</div>
          ) : (
            archived.map((s) => (
              <div
                key={s.session_id}
                data-testid={`archived-session-${s.session_id}`}
                className="py-2.5 flex items-center gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink truncate">{s.title || s.session_id}</div>
                  <div className="text-[11.5px] text-muted truncate">
                    {s.project_name || t("Regular session")}
                    {s.project_hidden ? " · " + t("Project removed") : ""}
                  </div>
                </div>
                <button
                  className={BTN_BORDERED}
                  data-testid={`restore-session-${s.session_id}`}
                  disabled={busy === `restore:${s.session_id}`}
                  onClick={() => restoreSession(s)}
                >
                  {restoreLabel(s)}
                </button>
                <button
                  className="text-[12.5px] px-3 py-2 rounded-lg border border-dangerSoft bg-dangerSoft text-danger shrink-0 disabled:opacity-40"
                  data-testid={`delete-archived-session-${s.session_id}`}
                  disabled={busy === `delete:${s.session_id}`}
                  onClick={() => deleteArchived(s)}
                >
                  {t("Delete")}
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className={CARD + " p-4"} data-testid="removed-projects-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={FIELD_LABEL}>{t("Removed projects")}</div>
            <div className={FIELD_HELP}>
              {t("Reopen projects removed from the sidebar. Unarchived conversations return with the project.")}
            </div>
          </div>
          <span className="text-[12px] text-muted rounded-lg border border-line px-2 py-1">
            {removed ? t("{{count}} projects", { count: removed.length }) : t("Loading…")}
          </span>
        </div>
        <div className="mt-3 divide-y divide-line">
          {removed === null ? (
            <div className="text-[12px] text-muted py-3">{t("Loading…")}</div>
          ) : removed.length === 0 ? (
            <div className="text-[12px] text-muted py-3">{t("No removed projects.")}</div>
          ) : (
            removed.map((project) => (
              <div key={project.project_id} className="py-2.5 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink truncate">{project.name}</div>
                  <div className="text-[11.5px] text-muted truncate">{project.path}</div>
                </div>
                <span
                  className={
                    "text-[11px] rounded-full px-2 py-1 shrink-0 " +
                    (project.path_exists === false
                      ? "bg-warnSoft text-warnInk"
                      : "bg-paper text-muted")
                  }
                >
                  {project.path_exists === false
                    ? t("Folder missing")
                    : t("{{count}} unarchived conversations", {
                        count: project.unarchived_sessions || 0,
                      })}
                </span>
                <button
                  className={project.path_exists === false ? BTN_BORDERED : BTN_ACCENT}
                  data-testid={
                    project.path_exists === false
                      ? `relocate-project-${project.project_id}`
                      : `reopen-project-${project.project_id}`
                  }
                  disabled={busy === `project:${project.project_id}`}
                  onClick={() => reopenRemoved(project)}
                >
                  {project.path_exists === false ? t("Relocate") : t("Reopen")}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

// -- Voice input: deliberate model provisioning + compatibility + microphone test (§37) --------
const formatBytes = (bytes: number) => {
  if (!bytes) return "0 MiB";
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
};

function VoiceInputSection() {
  const { t } = useI18n();
  const voiceError = (error: unknown) =>
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : t("Voice Input could not complete that action.");
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [progress, setProgress] = useState<DictationDownloadProgress | null>(null);
  const [phase, setPhase] = useState<"idle" | "downloading" | "verifying" | "testing" | "transcribing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [testTranscript, setTestTranscript] = useState("");
  const desktop = isTauri();

  const publish = (next: DictationStatus) => {
    setStatus(next);
    window.dispatchEvent(new CustomEvent("openloop:voice-input-changed", { detail: next }));
  };

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let unlisten = () => {};
    void listenDictationDownloadProgress((next) => {
      if (active) setProgress(next);
    }).then((stop) => {
      unlisten = stop;
    });
    void getDictationStatus().then(async (initial) => {
      if (!active || !initial) return;
      publish(initial);
      // One-time migration for models installed by the first STT cut, before verification markers.
      if (initial.model_installed && !initial.model_verified) {
        setPhase("verifying");
        try {
          const verified = await verifyDictationModel();
          if (active) publish(verified);
        } catch (verifyError) {
          if (active) setError(voiceError(verifyError));
        } finally {
          if (active) setPhase("idle");
        }
      }
    });
    return () => {
      active = false;
      unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop]);

  const download = async () => {
    setError(null);
    setProgress({ downloaded_bytes: 0, total_bytes: status?.model_bytes || 0 });
    setPhase("downloading");
    try {
      publish(await downloadDictationModel());
    } catch (downloadError) {
      setError(voiceError(downloadError));
      const latest = await getDictationStatus();
      if (latest) publish(latest);
    } finally {
      setPhase("idle");
    }
  };

  const cancelDownload = async () => {
    await cancelDictationModelDownload().catch(() => undefined);
  };

  const repair = async () => {
    setError(null);
    try {
      publish(await deleteDictationModel());
      await download();
    } catch (repairError) {
      setError(voiceError(repairError));
    }
  };

  const remove = async () => {
    if (!window.confirm(t("Delete the local Whisper model and disable Voice Input?"))) return;
    setError(null);
    try {
      publish(await deleteDictationModel());
      setTestTranscript("");
      setProgress(null);
    } catch (deleteError) {
      setError(voiceError(deleteError));
    }
  };

  const toggleTest = async () => {
    if (!status?.supported || !status.model_verified) return;
    setError(null);
    try {
      if (status.recording) {
        setPhase("transcribing");
        const transcript = (await stopDictation()).trim();
        setTestTranscript(transcript);
        if (!transcript) throw new Error(t("No speech was detected. Try again and speak for a little longer."));
        publish(await markDictationTestPassed());
      } else {
        setTestTranscript("");
        setPhase("testing");
        publish(await startDictation());
      }
    } catch (testError) {
      setError(voiceError(testError));
      const latest = await getDictationStatus();
      if (latest) publish(latest);
    } finally {
      setPhase("idle");
    }
  };

  const downloading = phase === "downloading" || !!status?.download_in_progress;
  const progressTotal = progress?.total_bytes || status?.model_bytes || 1;
  const progressPercent = Math.min(100, Math.round(((progress?.downloaded_bytes || 0) / progressTotal) * 100));
  const ready = !!status?.supported && !!status?.model_verified && !!status?.test_passed;

  return (
    <section>
      <PanelHead
        title={t("Voice input")}
        sub={t("Speak naturally in the composer. Recordings and transcripts stay on this device.")}
      />

      {!desktop ? (
        <div className={CARD + " p-4 text-[13px] text-muted"}>{t("Voice Input setup is available in the OpenLoop desktop app.")}</div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-green-200 bg-green-50/70 px-4 py-3 text-[12.5px] text-green-800">
            <span className="font-medium">{t("Private by design.")}</span> {t("Audio is held in memory only while you record and is transcribed locally.")}
          </div>

          <div className={CARD}>
            <div className="p-4 flex items-start gap-3">
              <Icon name="code" size={18} className="text-accent mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{t("This device")}</div>
                <div className="text-[12px] text-muted mt-1">{status?.device_summary || t("Checking compatibility…")}</div>
                {status?.compatibility_reason && <div className="text-[12px] text-red-600 mt-1.5">{status.compatibility_reason}</div>}
              </div>
              {status && (
                <span className={"text-[11.5px] px-2 py-1 rounded-full " + (status.supported ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600")}>
                  {status.supported ? `● ${t("Compatible")}` : t("Unsupported")}
                </span>
              )}
            </div>
            <div className="border-t border-line bg-paper/50 px-4 py-3 grid grid-cols-2 gap-3 text-[12px] text-muted">
              <div><span className="block text-ink font-medium">{t("Mac")}</span>macOS 12+ · Apple Silicon M1+</div>
              <div><span className="block text-ink font-medium">{t("Windows")}</span>Windows 10 22H2/11 · x64</div>
              <div><span className="block text-ink font-medium">{t("Memory")}</span>{t("8 GB recommended")}</div>
              <div><span className="block text-ink font-medium">{t("Processor")}</span>{t("4 CPU cores recommended")}</div>
            </div>
          </div>

          <div className={CARD}>
            <div className="p-4 flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-accentSoft text-accent grid place-items-center font-semibold">W</div>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">Whisper Base · English</div>
                <div className="text-[12px] text-muted mt-0.5">
                  {status?.model_verified ? t("Installed and verified · {{size}}", { size: formatBytes(status.model_bytes) }) : t("Local voice model · {{size}}", { size: formatBytes(status?.model_bytes || 147_964_211) })}
                </div>
              </div>
              {status?.model_verified ? (
                <>
                  <span className="text-[11.5px] px-2 py-1 rounded-full bg-green-50 text-green-700">{t("Verified")}</span>
                  <button className={BTN_BORDERED} onClick={() => void repair()}>{t("Repair")}</button>
                  <button className="text-[12px] text-red-600 px-2 py-2" onClick={() => void remove()}>{t("Delete")}</button>
                </>
              ) : downloading ? (
                <button className={BTN_BORDERED} onClick={() => void cancelDownload()}>{t("Cancel")}</button>
              ) : phase === "verifying" ? (
                <span className="text-[12px] text-muted">{t("Verifying…")}</span>
              ) : (
                <button className={BTN_ACCENT} disabled={!status?.supported} onClick={() => void download()}>{t("Download model")}</button>
              )}
            </div>
            {downloading && (
              <div className="border-t border-line px-4 py-3">
                <div className="h-1.5 rounded-full bg-line overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${progressPercent}%` }} /></div>
                <div className="mt-1.5 text-[11.5px] text-muted flex"><span>{formatBytes(progress?.downloaded_bytes || 0)} {t("of")} {formatBytes(progressTotal)}</span><span className="ml-auto">{progressPercent}%</span></div>
              </div>
            )}
          </div>

          <div className={CARD}>
            <div className="p-4 flex items-center gap-3">
              <Icon name="mic" size={18} className={ready ? "text-green-600" : "text-muted"} />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{t("Microphone test")}</div>
                <div className="text-[12px] text-muted mt-0.5">
                  {ready ? t("Your microphone and local transcription engine are working.") : t("Record a short phrase to enable the composer microphone.")}
                </div>
              </div>
              {ready && <span className="text-[11.5px] px-2 py-1 rounded-full bg-green-50 text-green-700">{t("● Ready")}</span>}
              <button className={BTN_BORDERED} disabled={!status?.supported || !status?.model_verified || phase === "transcribing"} onClick={() => void toggleTest()}>
                {status?.recording ? t("Stop and check") : phase === "transcribing" ? t("Transcribing…") : ready ? t("Test again") : t("Test microphone")}
              </button>
            </div>
            {status?.recording && <div className="border-t border-line px-4 py-3 text-[12px] text-accent" role="status">{t("● Listening… speak a short phrase, then stop.")}</div>}
            {testTranscript && <div className="border-t border-line bg-paper/50 px-4 py-3 text-[13px]">“{testTranscript}”</div>}
          </div>

          {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[12px] text-red-700">{error}</div>}
        </div>
      )}
    </section>
  );
}

// -- Appearance + app behaviour ------------------------------------------------
function AppearanceSection() {
  const { t, lang, setLang } = useI18n();
  const [theme, setTheme] = useThemePref();
  const [autostart, setAuto] = useState(false);
  const [awakeRule, setAwakeRuleState] = useState<AwakeRule>("off");
  const desktop = isTauri();

  useEffect(() => {
    if (isTauri()) {
      getAutostart().then((v) => setAuto(!!v));
      getAwakeRule().then((v) => setAwakeRuleState(v || "off"));
    }
  }, []);

  const toggleAuto = async (v: boolean) => setAuto(!!(await setAutostart(v)));
  const saveAwakeRule = async (rule: AwakeRule) => {
    setAwakeRuleState(rule);
    const saved = await setAwakeRule(rule);
    if (saved) setAwakeRuleState(saved);
  };

  return (
    <section>
      <PanelHead
        title={t("General")}
        sub={t("Manage this device's interface, conversation display, and system runtime rules.")}
      />

      <div className={CARD + " p-4 mb-4"}>
        <div className={FIELD_LABEL}>{t("Appearance & language")}</div>
        <div className="border-b border-line pb-3 mb-3">
          <div className="text-[13px] text-ink">{t("Theme")}</div>
          <div className="seg mt-2.5" role="radiogroup" aria-label={t("Appearance")}>
            {(["light", "dark", "auto"] as const).map((p) => (
              <button key={p} className={p === theme ? "active" : ""} onClick={() => setTheme(p)}>
                {p === "light" ? t("Light") : p === "dark" ? t("Dark") : t("Auto")}
              </button>
            ))}
          </div>
          <div className={FIELD_HELP}>{t("Auto follows your Mac's appearance.")}</div>
        </div>

        <div data-testid="interface-language-card">
          <div className="text-[13px] text-ink">{t("Interface language")}</div>
          <div className="seg mt-2.5" role="radiogroup" aria-label={t("Interface language")}>
          {(["zh-CN", "en"] as const).map((l) => (
            <button key={l} className={l === lang ? "active" : ""} onClick={() => setLang(l)}>
              {LANG_LABELS[l]}
            </button>
          ))}
          </div>
          <div className={FIELD_HELP}>{t("Restart not needed — applies immediately.")}</div>
        </div>
      </div>

      <FileStorageCard />

      <div className={CARD + " p-4 mb-4"}>
        <div className={FIELD_LABEL}>{t("Session interface")}</div>
        <SidebarCard inline />
        <div className="border-t border-line mt-3 pt-3">
          <ContextBarCard inline />
        </div>
      </div>

      {desktop && (
        <div className={CARD + " p-4 mb-4"}>
          <div className={FIELD_LABEL}>{t("System runtime")}</div>
          <div className="border-b border-line pb-3 mb-3">
          <label className={CONTROL_ROW + " rounded-lg border border-transparent px-3 py-2"}>
            <input type="checkbox" checked={autostart} onChange={(e) => toggleAuto(e.target.checked)} />
            <span>
              <span className="block text-[13px] text-ink">{t("Open at login")}</span>
              <span className="block text-[12px] text-muted">{t("Launch OpenLoop automatically when you sign in.")}</span>
            </span>
          </label>
          </div>

          <div className="text-[13px] text-ink mb-2">{t("Wake rule")}</div>
          <div className="space-y-1.5" role="radiogroup" aria-label={t("Wake rule")}>
            {([
              ["off", "No wake rule", "OpenLoop does not prevent system sleep."],
              ["while_running", "Wake only while tasks run", "Keep the system awake while a conversation, background delivery, or automation is running. Release it when work finishes."],
              ["always", "Always keep awake", "Prevent idle sleep for as long as OpenLoop is running."],
            ] as const).map(([rule, label, description]) => (
              <label
                key={rule}
                className={
                  CONTROL_ROW + " rounded-lg border px-3 py-3 " +
                  (awakeRule === rule ? "border-accent bg-accent/10" : "border-transparent")
                }
              >
                <input
                  type="radio"
                  checked={awakeRule === rule}
                  onChange={() => void saveAwakeRule(rule)}
                />
                <span>
                  <span className="block text-[13px] text-ink">
                    {t(label)}
                    {rule === "while_running" && (
                      <>
                        {" "}
                        <span className="ml-2 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                          {t("Recommended")}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="block text-[12px] text-muted leading-relaxed mt-1">{t(description)}</span>
                </span>
              </label>
            ))}
          </div>
          <div className={FIELD_HELP + " border-t border-line pt-3 mt-3"}>
            {t("This prevents idle sleep. MacBook lid-close behavior still depends on macOS, power, and hardware policy.")}
          </div>
        </div>
      )}

      {isTauri() && <UpdateSettings />}
    </section>
  );
}

function FileStorageCard() {
  const { t } = useI18n();
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getSettings()
      .then((s) => setRoot(s.session_root || s.scratch_base || ""))
      .catch(() => setRoot(""));
  }, []);

  const change = async () => {
    setBusy(true);
    setError("");
    try {
      const picked = await chooseFolder();
      if (!picked) return;
      const validation = await validateFolder(picked);
      if (!validation.ok || !validation.writable) {
        setError(validation.error || t("That folder is not writable."));
        return;
      }
      const res = await setSessionRoot(picked);
      if (!res.ok) {
        setError(res.error || t("Could not save folder."));
        return;
      }
      setRoot(res.session_root || picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save folder."));
    } finally {
      setBusy(false);
    }
  };

  const show = () => {
    if (!root) return;
    openExternal(`file://${encodeURI(root)}`);
  };

  return (
    <div className={CARD + " p-4 mb-4"} data-testid="file-storage-card">
      <div className={FIELD_LABEL}>{t("File storage")}</div>
      <div className={FIELD_HELP}>
        {t("Each ordinary conversation gets its own folder under this work folder. Project conversations keep using their project folder.")}
      </div>
      <div className="mt-3 rounded-lg border border-line bg-paper px-3 py-2">
        <div className="text-[12px] text-faint mb-1">{t("Current work folder")}</div>
        <div className="text-[13px] text-ink break-all" data-testid="settings-session-root">
          {root || t("Not set")}
        </div>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      <div className="mt-3 flex items-center gap-2">
        <button
          className={BTN_ACCENT}
          onClick={() => void change()}
          disabled={busy}
          data-testid="settings-change-session-root"
        >
          {busy ? t("Checking…") : t("Change…")}
        </button>
        <button className={BTN_BORDERED} onClick={show} disabled={!root}>
          {t("Show in Finder")}
        </button>
      </div>
    </div>
  );
}

// -- Sidebar density -------------------------------------------------------------
// -- Token savings (PDF attachments; owner ask, 2026-07-17) ---------------------
// Attachments replay with EVERY turn, so a big PDF quietly multiplies token spend.
// This card is the attachment dial: attach thresholds + the fallback for models
// without native PDF support. (Long-history spend is handled by auto-compaction —
// the CompactionCard below, OPE-27.)
function TokenSavingsCard() {
  const { t } = useI18n();
  const [pdf, setPdf] = useState<PdfSettings | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) =>
        setPdf({
          pdf_fallback: s.pdf_fallback || "text",
          pdf_max_pages: s.pdf_max_pages || 20,
          pdf_max_mb: s.pdf_max_mb || 10,
        }),
      )
      .catch(() => setPdf({ pdf_fallback: "text", pdf_max_pages: 20, pdf_max_mb: 10 }));
  }, []);

  const save = async (patch: Partial<PdfSettings>) => {
    setPdf((p) => (p ? { ...p, ...patch } : p));
    await setPdfSettings(patch);
  };

  if (!pdf) return null;
  return (
    <div className={CARD + " p-4 mb-4"} data-testid="token-savings-card">
      <div className={FIELD_LABEL}>{t("Token savings")}</div>
      <div className={FIELD_HELP}>
        {t("PDF attachments travel with every turn of a conversation, so large documents multiply what you spend on tokens.")}
      </div>

      <div className="mt-3 text-[13px] text-ink">{t("PDFs on models without native PDF support")}</div>
      <div className="seg mt-2" role="radiogroup" aria-label={t("PDF fallback")} data-testid="pdf-fallback">
        <button
          className={pdf.pdf_fallback === "text" ? "active" : ""}
          onClick={() => save({ pdf_fallback: "text" })}
        >
          {t("Extract text")}
        </button>
        <button
          className={pdf.pdf_fallback === "images" ? "active" : ""}
          onClick={() => save({ pdf_fallback: "images" })}
        >
          {t("Send page images")}
        </button>
      </div>
      <div className={FIELD_HELP}>
        {t("Claude, GPT and Gemini read PDFs natively — this only applies to models that don't (GLM, Kimi, DeepSeek, local models…). Text extraction is cheapest; page images cost more tokens and need a vision-capable model.")}
      </div>

      <div className="mt-3 flex items-center gap-5">
        <label className="flex items-center gap-2.5">
          <span className="text-[13px] text-ink">{t("Max pages")}</span>
          <input
            type="number"
            min={1}
            max={100}
            value={pdf.pdf_max_pages}
            data-testid="pdf-max-pages"
            className="w-16 px-2 py-1.5 rounded-lg border border-line bg-paper text-[13px] text-ink outline-none focus:border-accent"
            onChange={(e) => save({ pdf_max_pages: Math.max(1, Math.min(Number(e.target.value) || 20, 100)) })}
          />
        </label>
        <label className="flex items-center gap-2.5">
          <span className="text-[13px] text-ink">{t("Max size")}</span>
          <input
            type="number"
            min={1}
            max={10}
            value={pdf.pdf_max_mb}
            data-testid="pdf-max-mb"
            className="w-16 px-2 py-1.5 rounded-lg border border-line bg-paper text-[13px] text-ink outline-none focus:border-accent"
            onChange={(e) => save({ pdf_max_mb: Math.max(1, Math.min(Number(e.target.value) || 10, 10)) })}
          />
          <span className="text-[12.5px] text-muted">MB</span>
        </label>
      </div>
      <div className={FIELD_HELP}>
        {t("PDFs over these limits are not attached — you'll see a notice in the composer instead.")}
      </div>
    </div>
  );
}

// -- Context compaction (OPE-27) ------------------------------------------------
// Long sessions are summarized automatically when they approach the model's context
// limit, so work continues instead of hitting a raw provider error. Two spec'd
// overrides (trigger % + token cap) and the summarizer-model pin — nothing more.
function CompactionCard() {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<CompactionSettings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    getSettings()
      .then((s) => {
        setCfg({
          compaction_threshold_pct: s.compaction_threshold_pct ?? 0.8,
          compaction_cap_tokens: s.compaction_cap_tokens ?? 250_000,
          compaction_model: s.compaction_model ?? "",
        });
        setModels(s.models || []);
        setLabels(s.model_labels || {});
      })
      .catch(() =>
        setCfg({
          compaction_threshold_pct: 0.8,
          compaction_cap_tokens: 250_000,
          compaction_model: "",
        }),
      );
  }, []);

  const save = async (patch: Partial<CompactionSettings>) => {
    setCfg((p) => (p ? { ...p, ...patch } : p));
    await setCompactionSettings(patch);
  };

  if (!cfg) return null;
  const modelLabel = (id: string) => labels[id]?.split(" · ")[0] || id;
  return (
    <div className={CARD + " p-4 mb-4"} data-testid="compaction-card">
      <div className={FIELD_LABEL}>{t("Context compaction")}</div>
      <div className={FIELD_HELP}>
        {t("Long sessions are compacted automatically: older turns are summarized so OpenLoop keeps working instead of running out of context. Your visible transcript is never changed — a small marker shows where compaction happened.")}
      </div>

      <div className="mt-3 flex items-center gap-5 flex-wrap">
        <label className="flex items-center gap-2.5">
          <span className="text-[13px] text-ink">{t("Compact at")}</span>
          <input
            type="number"
            min={10}
            max={95}
            value={Math.round(cfg.compaction_threshold_pct * 100)}
            data-testid="compaction-threshold"
            className="w-16 px-2 py-1.5 rounded-lg border border-line bg-paper text-[13px] text-ink outline-none focus:border-accent"
            onChange={(e) =>
              save({
                compaction_threshold_pct:
                  Math.max(10, Math.min(Number(e.target.value) || 80, 95)) / 100,
              })
            }
          />
          <span className="text-[12.5px] text-muted">{t("% of the context window")}</span>
        </label>
        <label className="flex items-center gap-2.5">
          <span className="text-[13px] text-ink">{t("or at")}</span>
          <input
            type="number"
            min={10_000}
            max={2_000_000}
            step={10_000}
            value={cfg.compaction_cap_tokens}
            data-testid="compaction-cap"
            className="w-28 px-2 py-1.5 rounded-lg border border-line bg-paper text-[13px] text-ink outline-none focus:border-accent"
            onChange={(e) =>
              save({
                compaction_cap_tokens: Math.max(
                  10_000,
                  Math.min(Number(e.target.value) || 250_000, 2_000_000),
                ),
              })
            }
          />
          <span className="text-[12.5px] text-muted">{t("tokens, whichever is smaller")}</span>
        </label>
      </div>
      <div className={FIELD_HELP}>
        {t("The cap makes very-large-context models compact early — quality and speed degrade well before their nominal limit.")}
      </div>

      <div className="mt-3 flex items-center gap-2.5">
        <span className="text-[13px] text-ink">{t("Summarizer model")}</span>
        <select
          value={cfg.compaction_model}
          data-testid="compaction-model"
          className="px-2 py-1.5 rounded-lg border border-line bg-paper text-[13px] text-ink outline-none focus:border-accent"
          onChange={(e) => save({ compaction_model: e.target.value })}
        >
          <option value="">{t("Session's own model (default)")}</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {modelLabel(m)}
            </option>
          ))}
        </select>
      </div>
      <div className={FIELD_HELP}>
        {t("The summary is written by this model. The default follows whatever model the session is using.")}
      </div>
    </div>
  );
}

// -- Composer: context-window bar (owner ask 2026-07-30) ------------------------
// The chip's bar is context-window occupancy; the session total (unbounded) lives in
// the popover. Some people would rather not watch a meter at all, hence the toggle.
function ContextBarCard({ inline = false }: { inline?: boolean }) {
  const { t } = useI18n();
  const [shown, setShown] = useState<boolean | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => setShown(s.context_bar === true))
      .catch(() => setShown(false));
  }, []);

  const save = async (next: boolean) => {
    setShown(next);
    await setContextBar(next);
  };

  if (shown === null) return null;
  const body = (
    <div data-testid="context-bar-card">
      <label className={CONTROL_ROW + " py-2"}>
        <input
          type="checkbox"
          data-testid="context-bar-toggle"
          checked={shown}
          onChange={(e) => save(e.target.checked)}
        />
        <span>
          <span className="block text-[13px] text-ink">{t("Show the context window bar")}</span>
          <span className="block text-[12px] text-muted">
            {t("A small meter showing how full the model's context window is. Turn it off to show this session's token total instead; either way the full breakdown is one click away.")}
          </span>
        </span>
      </label>
    </div>
  );
  if (inline) return body;
  return (
    <div className={CARD + " p-4 mb-4"}>
      <div className={FIELD_LABEL}>{t("Composer")}</div>
      {body}
    </div>
  );
}

function SidebarCard({ inline = false }: { inline?: boolean }) {
  const { t } = useI18n();
  const [peek, setPeek] = useState<number | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => setPeek(s.sessions_peek || 5))
      .catch(() => setPeek(5));
  }, []);

  const save = async (n: number) => {
    const clamped = Math.max(1, Math.min(n || 5, 50));
    setPeek(clamped);
    await setSessionsPeek(clamped);
  };

  if (peek === null) return null;
  const body = (
    <div>
      <label className="flex items-center gap-3 mt-2.5">
        <span className="text-[13px] text-ink">{t("Conversations shown per group")}</span>
        <input
          type="number"
          min={1}
          max={50}
          value={peek}
          className="w-16 px-2 py-1.5 rounded-lg border border-line bg-paper text-[13px] text-ink outline-none focus:border-accent"
          onChange={(e) => save(Number(e.target.value))}
        />
      </label>
      <div className={FIELD_HELP}>
        {t('Longer lists collapse behind "Show more". Applies per group and per project.')}
      </div>
    </div>
  );
  if (inline) return body;
  return (
    <div className={CARD + " p-4 mb-4"}>
      <div className={FIELD_LABEL}>{t("Sidebar")}</div>
      {body}
    </div>
  );
}
