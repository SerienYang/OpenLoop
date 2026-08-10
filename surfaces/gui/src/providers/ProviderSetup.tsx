import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  getProviderOrder,
  getProviders,
  putProviderOrder,
  removeProvider,
  setProvider,
  verifyProvider,
  type ProviderField as ProviderFieldT,
  type ProviderInfo,
} from "../api";
import { openExternal } from "../tauri";
import { PROVIDER_LOGOS, providerRank } from "./logos";
import { translateDynamic, useI18n } from "../i18n";
import {
  createProviderOrderState,
  providerOrderConflict,
  providerOrderReconciled,
  providerOrderReconciliationFailed,
  providerOrderSaved,
  providerOrderServerUpdated,
  providerOrderTransportFailed,
  providerOrderValidationFailed,
  queueProviderSwap,
  type ProviderOrderCommand,
  type ProviderOrderState,
  type ProviderOrderTransition,
} from "./providerOrder";

// The provider gallery ⇄ key form, shared by Onboarding step 1 (§39) and
// Settings ▸ Models (UX-021) so the two can never drift apart visually. The hook
// owns the interaction state machine; ProviderGallery/ProviderForm own the shared
// markup. Each surface keeps its own frame (fixed-height modal vs scrolling page)
// and passes a testid prefix so both stay independently addressable in e2e.

// Where a non-developer gets an API key — deep link + one line of instructions.
export const KEY_HELP: Record<string, { url: string; label: string }> = {
  anthropic: { url: "https://console.anthropic.com/settings/keys", label: "console.anthropic.com" },
  openai: { url: "https://platform.openai.com/api-keys", label: "platform.openai.com" },
  gemini: { url: "https://aistudio.google.com/apikey", label: "aistudio.google.com" },
  "opencode-go": { url: "https://opencode.ai/auth", label: "opencode.ai/auth" },
  openrouter: { url: "https://openrouter.ai/keys", label: "openrouter.ai" },
  bedrock: { url: "https://console.aws.amazon.com/bedrock/home#/api-keys", label: "the AWS Bedrock console" },
  fireworks: { url: "https://fireworks.ai/account/api-keys", label: "fireworks.ai" },
  together: { url: "https://api.together.xyz/settings/api-keys", label: "together.xyz" },
  zai: { url: "https://z.ai/manage-apikey/apikey-list", label: "z.ai" },
  kimi: { url: "https://platform.moonshot.ai/console/api-keys", label: "platform.moonshot.ai" },
  deepseek: { url: "https://platform.deepseek.com/api_keys", label: "platform.deepseek.com" },
  mistral: { url: "https://console.mistral.ai/api-keys", label: "console.mistral.ai" },
  volcengine: { url: "https://console.volcengine.com/ark/region:cn-beijing/apiKey", label: "console.volcengine.com/ark" },
  qwen: { url: "https://modelstudio.console.alibabacloud.com", label: "alibabacloud.com" },
  minimax: { url: "https://platform.minimax.io", label: "platform.minimax.io" },
  xai: { url: "https://console.x.ai", label: "console.x.ai" },
};

export type Verify = { state: "idle" | "testing" | "ok" | "error"; msg?: string };

function providerOrderRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

function orderProviderInfo(
  providers: ProviderInfo[],
  order: string[],
): ProviderInfo[] {
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  return [
    ...order.map((name) => byName.get(name)).filter((item): item is ProviderInfo => !!item),
    ...providers.filter((provider) => !order.includes(provider.name)),
  ];
}

/** Brand chip: always a light plate so multicolor marks read on any theme. */
export function ProviderMark({ name, title, size = 32 }: { name: string; title: string; size?: number }) {
  const url = PROVIDER_LOGOS[name];
  return (
    <span
      className="rounded-lg border border-line grid place-items-center shrink-0"
      style={{ width: size, height: size, background: "#f6f7f8" }}
    >
      {url ? (
        <img src={url} alt="" style={{ width: size * 0.6, height: size * 0.6 }} />
      ) : (
        <span className="text-[13px] font-semibold text-muted">{title[0]}</span>
      )}
    </span>
  );
}

/** "2h ago"-style label for a provider's last completion (null when never used). */
export function relTime(
  epoch?: number | null,
  t?: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (!epoch) return null;
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epoch));
  if (secs < 90) return t ? t("just now") : "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t ? t("{{mins}}m ago", { mins }) : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return t ? t("{{hrs}}h ago", { hrs }) : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return t ? t("{{days}}d ago", { days }) : `${days}d ago`;
}

export interface ProviderSetupState {
  providers: ProviderInfo[];
  ordered: ProviderInfo[];
  providerOrder: ProviderOrderState | null;
  swapProviders: (aProviderId: string, bProviderId: string) => void;
  clearProviderOrderNotice: () => void;
  refreshProviders: () => Promise<void>;
  sel: string | null;
  info: ProviderInfo | undefined;
  fields: Record<string, string>;
  setFieldValue: (key: string, value: string) => void;
  dirty: boolean;
  verify: Verify;
  showEndpoint: boolean;
  setShowEndpoint: (v: boolean) => void;
  keylessOk: Set<string>;
  credentialed: boolean;
  savedState: boolean;
  secretFilled: boolean;
  openProvider: (name: string) => void;
  backToGallery: () => void;
  runTestAndSave: () => Promise<boolean>;
  removeKey: () => Promise<void>;
  cancelBackTimer: () => void;
  statusFor: (p: ProviderInfo, opts?: { lastUsed?: boolean }) => ReactNode;
  // Blur-save for non-secret fields on an already-configured provider (the Test button is
  // the KEY's save path; extras like anthropic's thinking_budget must not need a re-test —
  // owner-hit 2026-07-23: the budget silently never saved).
  saveField: (key: string) => Promise<void>;
  fieldSaved: string | null; // field key flashing "✓ Saved"
}

export function useProviderSetup(opts?: {
  onSaved?: () => void;
  surface?: "settings" | "onboarding";
}): ProviderSetupState {
  const { t } = useI18n();
  const settingsOrdering = opts?.surface === "settings";
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerOrder, setProviderOrder] = useState<ProviderOrderState | null>(
    null,
  );
  const providerOrderRef = useRef<ProviderOrderState | null>(null);
  const mountedRef = useRef(false);
  const executeOrderCommandRef = useRef<
    (command: ProviderOrderCommand) => void
  >(() => {});
  const activePutRef = useRef<string | null>(null);
  const queuedPutRef = useRef<ProviderOrderCommand | null>(null);
  // null = the gallery; a provider name = that provider's key form.
  const [sel, setSel] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [showEndpoint, setShowEndpoint] = useState(false);
  const [verify, setVerify] = useState<Verify>({ state: "idle" });
  // Keyless providers (Ollama) report configured without proving anything runs —
  // a passing Detect this session is what marks them live.
  const [keylessOk, setKeylessOk] = useState<Set<string>>(new Set());
  // Unsaved per-provider input survives switching cards (owner complaint 2026-07-16).
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const backTimer = useRef<number | null>(null);
  // Which non-secret field just blur-saved (flashes "✓ Saved" in the input).
  const [fieldSaved, setFieldSaved] = useState<string | null>(null);
  const fieldSavedTimer = useRef<number | null>(null);

  const applyOrderTransition = (next: ProviderOrderTransition) => {
    providerOrderRef.current = next.state;
    if (mountedRef.current) setProviderOrder(next.state);
    if (next.command.type !== "none") {
      queueMicrotask(() => executeOrderCommandRef.current(next.command));
    }
  };

  executeOrderCommandRef.current = (command) => {
    if (command.type === "none") return;
    if (command.type === "reconcile") {
      void getProviderOrder({
        requestId: command.requestId,
        baseRevision: command.baseRevision,
      })
        .then((server) => {
          const current = providerOrderRef.current;
          if (!current) return;
          applyOrderTransition(
            providerOrderReconciled(
              current,
              command.requestId,
              {
                providers: server.providers,
                revision: server.revision,
                requestApplied: server.requestApplied ?? "unknown",
              },
              providerOrderRequestId,
            ),
          );
        })
        .catch(() => {
          const current = providerOrderRef.current;
          if (!current) return;
          applyOrderTransition(
            providerOrderReconciliationFailed(current, command.requestId),
          );
        });
      return;
    }

    const { request } = command;
    if (
      providerOrderRef.current?.inFlight?.requestId !== request.requestId
    ) {
      return;
    }
    if (activePutRef.current) {
      if (activePutRef.current !== request.requestId) {
        queuedPutRef.current = command;
      }
      return;
    }
    activePutRef.current = request.requestId;
    void putProviderOrder({
      providers: request.providers,
      revision: request.baseRevision,
      requestId: request.requestId,
    })
      .then((result) => {
        const current = providerOrderRef.current;
        if (!current) return;
        if (result.kind === "ok") {
          applyOrderTransition(
            providerOrderSaved(
              current,
              request.requestId,
              result,
              providerOrderRequestId,
            ),
          );
        } else if (result.kind === "conflict") {
          applyOrderTransition(
            providerOrderConflict(
              current,
              request.requestId,
              result,
              providerOrderRequestId,
            ),
          );
        } else {
          applyOrderTransition(
            providerOrderValidationFailed(current, request.requestId),
          );
        }
      })
      .catch(() => {
        const current = providerOrderRef.current;
        if (!current) return;
        applyOrderTransition(
          providerOrderTransportFailed(current, request.requestId),
        );
      })
      .finally(() => {
        if (activePutRef.current === request.requestId) {
          activePutRef.current = null;
        }
        const queued = queuedPutRef.current;
        queuedPutRef.current = null;
        if (
          queued?.type === "put" &&
          providerOrderRef.current?.inFlight?.requestId ===
            queued.request.requestId
        ) {
          executeOrderCommandRef.current(queued);
        }
      });
  };

  const refreshProviders = async () => {
    try {
      const next = await getProviders();
      if (mountedRef.current) setProviders(next);
    } catch {
      // Keep the current provider list on a transient refresh failure.
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    if (settingsOrdering) {
      void Promise.all([getProviders(), getProviderOrder()])
        .then(([nextProviders, order]) => {
          if (!mountedRef.current) return;
          setProviders(nextProviders);
          const initial = createProviderOrderState(
            order.providers,
            order.revision,
          );
          providerOrderRef.current = initial;
          setProviderOrder(initial);
        })
        .catch(() => {});
    } else {
      void refreshProviders();
    }
    return () => {
      mountedRef.current = false;
      if (backTimer.current) window.clearTimeout(backTimer.current);
      if (fieldSavedTimer.current) {
        window.clearTimeout(fieldSavedTimer.current);
      }
    };
  }, [settingsOrdering]);

  const info = providers.find((p) => p.name === sel);
  const credentialed = !!info?.configured && !!info?.needs_key;

  const openProvider = (name: string) => {
    const p = providers.find((x) => x.name === name);
    if (sel) setDrafts((d) => ({ ...d, [sel]: fields }));
    const draft = drafts[name];
    const next: Record<string, string> = {};
    for (const f of p?.fields || []) next[f.key] = draft?.[f.key] || p?.values?.[f.key] || f.default || "";
    setSel(name);
    setFields(next);
    setDirty(!!draft && Object.values(draft).some(Boolean));
    setVerify({ state: "idle" });
    setShowEndpoint(false);
  };

  const backToGallery = () => {
    // Stash only UNSAVED input. The unconditional stash used to capture the just-saved
    // key on the post-Test auto-return, so revisiting a connected provider restored the
    // plaintext key into the field instead of the masked placeholder + saved pill
    // (state-restore bug, owner catch 2026-07-19). A clean form clears any stale draft.
    if (sel) setDrafts((d) => ({ ...d, [sel]: dirty ? fields : {} }));
    setSel(null);
    setVerify({ state: "idle" });
  };

  // Test = verify AND save AND return (§39: a passing Test auto-saves and takes
  // you back to the gallery, where the card now wears its ✓ — no extra clicks).
  const runTestAndSave = async (): Promise<boolean> => {
    if (!sel) return false;
    setVerify({ state: "testing" });
    const res = await verifyProvider(sel, fields).catch(() => ({ ok: false, error: "unreachable" }));
    if (!res.ok) {
      setVerify({ state: "error", msg: res.error || "couldn't verify" });
      return false;
    }
    if (dirty || !info?.configured) {
      const saved = await setProvider(sel, fields).catch(() => ({
        ok: false,
        error: "unreachable",
        provider_order: undefined,
        provider_order_revision: undefined,
      }));
      if (!saved.ok) {
        setVerify({
          state: "error",
          msg: saved.error || "couldn't save",
        });
        return false;
      }
      if (
        settingsOrdering &&
        saved.provider_order &&
        typeof saved.provider_order_revision === "number"
      ) {
        const server = {
          providers: saved.provider_order,
          revision: saved.provider_order_revision,
        };
        const current = providerOrderRef.current;
        if (current) {
          applyOrderTransition(
            providerOrderServerUpdated(
              current,
              server,
              providerOrderRequestId,
            ),
          );
        } else {
          const initial = createProviderOrderState(
            server.providers,
            server.revision,
          );
          providerOrderRef.current = initial;
          setProviderOrder(initial);
        }
      }
    }
    if (!info?.needs_key) setKeylessOk((s) => new Set(s).add(sel));
    setVerify({ state: "ok" });
    setDirty(false);
    setDrafts((d) => ({ ...d, [sel]: {} }));
    await refreshProviders();
    opts?.onSaved?.();
    // Let the in-field "✓ Tested & saved" register, then slide home. NOT backToGallery:
    // the timeout would fire its stale closure (dirty/fields from before the save) and
    // re-stash the just-saved key as a draft — the state-restore bug (owner catch
    // 2026-07-19). This return path clears the draft unconditionally.
    backTimer.current = window.setTimeout(() => {
      setDrafts((d) => ({ ...d, [sel]: {} }));
      setSel(null);
      setVerify({ state: "idle" });
    }, 900);
    return true;
  };

  // Blur-save for non-secret fields when the provider is already configured: extras like
  // anthropic's thinking_budget must persist without a key re-test (owner-hit 2026-07-23 —
  // typed, left Settings, silently never saved). Secrets keep the explicit Test-to-save
  // contract; unconfigured providers save everything on their first Test.
  const saveField = async (key: string) => {
    if (!sel || !info?.configured) return;
    const spec = info.fields.find((f) => f.key === key);
    if (!spec || spec.secret) return;
    const current = (fields[key] || "").trim();
    const stored = (info.values?.[key] || "").trim();
    if (current === stored) return;
    const res = await setProvider(sel, { [key]: current }).catch(() => ({ ok: false }));
    if (!res.ok) return;
    await refreshProviders();
    opts?.onSaved?.();
    setFieldSaved(key);
    if (fieldSavedTimer.current) window.clearTimeout(fieldSavedTimer.current);
    fieldSavedTimer.current = window.setTimeout(() => setFieldSaved(null), 1400);
  };

  // Settings-only: forget the stored key; the card reverts to "Not set up".
  const removeKey = async () => {
    if (!sel) return;
    await removeProvider(sel).catch(() => {});
    setDrafts((d) => ({ ...d, [sel]: {} }));
    setKeylessOk((s) => {
      const next = new Set(s);
      next.delete(sel);
      return next;
    });
    await refreshProviders();
    opts?.onSaved?.();
    setSel(null);
    setVerify({ state: "idle" });
  };

  const statusFor = (p: ProviderInfo, o?: { lastUsed?: boolean }) => {
    if (p.configured && p.needs_key) {
      const used = o?.lastUsed ? relTime(p.last_used_at, t) : null;
      return (
        <span className="block text-[11.5px] text-ok font-medium truncate">
          {t("✓ Connected")}{used ? <span className="text-muted font-normal">{t(" · used {{time}}", { time: used })}</span> : ""}
        </span>
      );
    }
    if (!p.needs_key)
      return (
        <span className="block text-[11.5px] text-faint truncate">
          {keylessOk.has(p.name) ? <span className="text-ok font-medium">{t("✓ Running")}</span> : t("No key needed")}
        </span>
      );
    return <span className="block text-[11.5px] text-faint truncate">{t("Not set up")}</span>;
  };

  const onboardingOrder = [...providers].sort(
    (a, b) => providerRank(a.name) - providerRank(b.name),
  );
  const settingsOrder = providerOrder
    ? orderProviderInfo(providers, providerOrder.optimistic)
    : providers;

  return {
    providers,
    ordered: settingsOrdering ? settingsOrder : onboardingOrder,
    providerOrder,
    swapProviders: (aProviderId, bProviderId) => {
      const current = providerOrderRef.current;
      if (!settingsOrdering || !current) return;
      applyOrderTransition(
        queueProviderSwap(
          current,
          { aProviderId, bProviderId },
          providerOrderRequestId,
        ),
      );
    },
    clearProviderOrderNotice: () => {
      const current = providerOrderRef.current;
      if (!current?.notice) return;
      const next = { ...current, notice: null };
      providerOrderRef.current = next;
      setProviderOrder(next);
    },
    refreshProviders,
    sel,
    info,
    fields,
    setFieldValue: (key, value) => {
      setFields((cur) => ({ ...cur, [key]: value }));
      setDirty(true);
      setVerify({ state: "idle" });
    },
    dirty,
    verify,
    showEndpoint,
    setShowEndpoint,
    keylessOk,
    credentialed,
    // The in-field saved state (§39): green border + pill INSIDE the key box — shown
    // for stored credentials and fresh test-passes alike; typing clears it.
    savedState: (credentialed && !dirty) || verify.state === "ok",
    // Only REQUIRED secrets gate the Test button — cloud providers (Bedrock, Vertex)
    // have optional key fields whose credentials may live in ~/.aws or ADC instead.
    secretFilled: (info?.fields || []).every(
      (f) => !f.secret || !f.required || (fields[f.key] || "").trim(),
    ),
    openProvider,
    backToGallery,
    runTestAndSave,
    removeKey,
    saveField,
    fieldSaved,
    cancelBackTimer: () => {
      if (backTimer.current) window.clearTimeout(backTimer.current);
    },
    statusFor,
  };
}

/** One provider's key form: crumb, brand head, fields (endpoint behind a quiet
 * disclosure), in-field saved pill, Test/Detect, key help, fixed error line.
 * `footer` renders after the error line (Settings adds "Remove key…" there). */
export function ProviderForm({
  ps,
  tp,
  footer,
}: {
  ps: ProviderSetupState;
  tp: string;
  footer?: ReactNode;
}) {
  const { lang, t } = useI18n();
  const { info, sel } = ps;
  const label = "block text-[12px] text-muted mt-3 mb-1";
  const input =
    "w-full px-3 py-2 rounded-lg border bg-panel text-[13.5px] outline-none focus:border-accent";
  const fieldsAll = info?.fields || [];
  const keyed = fieldsAll.some((x) => x.secret);
  // Cloud providers declare a segmented auth-method choice; the selected method's
  // credential fields render inside a panel with its own Test & save footer.
  const choice = fieldsAll.find((f) => f.choices && f.choices.length);
  const method = choice ? ps.fields[choice.key] || choice.default || "" : "";
  const selected = choice?.choices?.find((c) => c.value === method);
  const methodFields = choice
    ? fieldsAll.filter(
        (f) =>
          f.show_when &&
          Object.entries(f.show_when).every(([k, v]) => (ps.fields[k] || "") === v),
      )
    : [];
  // Without a choice control, Test lives next to the required secret (the API key), or
  // the first field for keyless providers (Ollama's Detect).
  const requiredSecret = fieldsAll.find((x) => x.secret && x.required);
  const testKey = requiredSecret ? requiredSecret.key : fieldsAll[0]?.key;
  if (!sel) return null;

  const fieldRow = (f: ProviderFieldT, testable: boolean) => (
    <div key={f.key}>
      <label className={label}>
        {translateDynamic(
          f.label,
          lang,
          t("Configuration field: {{key}}", { key: f.key }),
        )}
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1 min-w-0">
          <input
            className={input + (ps.savedState && testable ? " border-ok pr-32" : " border-line")}
            type={f.secret ? "password" : "text"}
            placeholder={f.secret && ps.credentialed && !ps.dirty ? "••••••••" : f.placeholder}
            value={ps.fields[f.key] || ""}
            data-testid={`${tp}-field-${f.key}`}
            onChange={(e) => ps.setFieldValue(f.key, e.target.value)}
            onBlur={f.secret ? undefined : () => void ps.saveField(f.key)}
          />
          {ps.fieldSaved === f.key && (
            <span
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-medium text-ok bg-okSoft rounded-full px-2 py-0.5 pointer-events-none"
              data-testid={`${tp}-field-saved-${f.key}`}
            >
              {t("✓ Saved")}
            </span>
          )}
          {/* §39: state lives IN the field — no status lines below. */}
          {ps.savedState && testable && (
            <span
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-medium text-ok bg-okSoft rounded-full px-2 py-0.5 pointer-events-none"
              data-testid={`${tp}-saved-pill`}
            >
              {info?.needs_key ? t("✓ Tested & saved") : t("✓ Detected")}
            </span>
          )}
        </div>
        {testable && (
          <button
            className="px-4 rounded-lg border border-line text-[13px] font-medium text-ink hover:border-lineStrong shrink-0 disabled:opacity-40"
            onClick={() => ps.runTestAndSave()}
            disabled={ps.verify.state === "testing" || (!ps.secretFilled && !ps.credentialed)}
            data-testid={`${tp}-test`}
          >
            {ps.verify.state === "testing" ? "…" : info?.needs_key ? t("Test") : t("Detect")}
          </button>
        )}
      </div>
      {f.help && (
        <p className="text-[11.5px] text-faint mt-1">
          {translateDynamic(
            f.help,
            lang,
            t("Use the value provided by the model service."),
          )}
        </p>
      )}
    </div>
  );

  return (
    <div>
      <button className="text-[12.5px] text-muted hover:text-ink" onClick={ps.backToGallery} data-testid={`${tp}-back`}>
        ‹ {t("All providers")}
      </button>
      <div className="flex items-center gap-3 mt-3 mb-1">
        <ProviderMark name={info?.name || ""} title={info?.title || ""} size={36} />
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold leading-tight">{info?.title}</span>
          {info ? ps.statusFor(info) : null}
        </span>
      </div>
      {info?.blurb && (
        <p className="text-[11.5px] text-faint mt-1">
          {translateDynamic(
            info.blurb,
            lang,
            t("Connect to models provided by {{title}}.", { title: info.title }),
          )}
        </p>
      )}

      {fieldsAll
        .filter(
          (f) =>
            !f.show_when &&
            !(f.choices && f.choices.length) &&
            !(f.key === "base_url" && keyed),
        )
        .map((f) => fieldRow(f, !choice && f.key === testKey))}

      {/* Auth-method segmented control + the selected method's panel (owner call
          2026-07-26): one joined track, then a soft inset card holding only that
          method's description, fields, and its own Test & save footer. */}
      {choice && (
        <div>
          <label className={label}>
            {translateDynamic(
              choice.label,
              lang,
              t("Configuration field: {{key}}", { key: choice.key }),
            )}
          </label>
          <div
            className="inline-flex gap-0.5 rounded-[10px] border border-line bg-line/40 p-[3px]"
            role="radiogroup"
            aria-label={translateDynamic(
              choice.label,
              lang,
              t("Configuration field: {{key}}", { key: choice.key }),
            )}
          >
            {(choice.choices || []).map((c) => {
              const active = method === c.value;
              return (
                <button
                  key={c.value}
                  role="radio"
                  aria-checked={active}
                  className={
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] whitespace-nowrap transition-colors " +
                    (active
                      ? "bg-panel text-ink font-medium shadow-sm ring-1 ring-line"
                      : "text-muted hover:text-ink")
                  }
                  data-testid={`${tp}-choice-${choice.key}-${c.value}`}
                  onClick={() => ps.setFieldValue(choice.key, c.value)}
                >
                  {translateDynamic(
                    c.label,
                    lang,
                    t("Authentication method: {{value}}", { value: c.value }),
                  )}
                  {c.tag && (
                    <span className="text-[9.5px] font-semibold uppercase tracking-wide text-accent bg-accentSoft rounded-full px-1.5 py-px">
                      {translateDynamic(c.tag, lang, t("Recommended"))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-2.5 rounded-xl border border-line bg-paper/60 px-4 pb-3.5 pt-3">
            {selected?.desc && (
              <p className="text-[12px] text-muted">
                {translateDynamic(
                  selected.desc,
                  lang,
                  t("Use this authentication method to connect."),
                )}
              </p>
            )}
            {selected?.command && (
              <button
                className="mt-2.5 inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[12px] font-mono text-ink hover:border-lineStrong"
                onClick={() => void navigator.clipboard?.writeText(selected.command || "")}
                title={t("Copy command")}
                data-testid={`${tp}-cmd-copy`}
              >
                {selected.command}
                <span className="font-sans text-[11px] text-faint">⧉</span>
              </button>
            )}
            {methodFields.map((f) => fieldRow(f, false))}
            <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-line pt-3">
              {ps.savedState ? (
                <span className="text-[11.5px] font-medium text-ok" data-testid={`${tp}-saved-pill`}>
                  {t("✓ Tested & saved")}
                </span>
              ) : (
                <span className="text-[11.5px] text-faint">{t("Runs one read-only check, then saves.")}</span>
              )}
              <button
                className="shrink-0 rounded-lg border border-accent bg-accent px-4 py-1.5 text-[13px] font-medium text-onAccent hover:brightness-105 disabled:opacity-40"
                onClick={() => ps.runTestAndSave()}
                disabled={ps.verify.state === "testing"}
                data-testid={`${tp}-test`}
              >
                {ps.verify.state === "testing" ? "…" : t("Test & save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {info?.needs_key && KEY_HELP[sel] && (
        <p className="text-[11.5px] text-faint mt-2">
          {t("No key yet?")}{" "}
          <button
            className="text-muted underline decoration-line underline-offset-2 hover:text-ink"
            onClick={() => openExternal(KEY_HELP[sel].url)}
          >
            {t("Create one at")} {KEY_HELP[sel].label} ↗
          </button>{" "}
          {t("— takes about a minute.")}
        </p>
      )}
      {info && !info.needs_key && (
        <p className="text-[11.5px] text-faint mt-2">
          {t("No API key needed — Ollama runs models on this computer.")}{" "}
          <button
            className="text-muted underline decoration-line underline-offset-2 hover:text-ink"
            onClick={() => openExternal("https://ollama.com/download")}
          >
            {t("Install Ollama ↗")}
          </button>
        </p>
      )}

      {/* Custom endpoint (keyed providers only): a quiet disclosure BELOW the key help,
          with enough separation to read as its own advanced row — no explainer copy
          (owner calls 2026-07-18 + 2026-07-19). */}
      {(() => {
        const keyed = (info?.fields || []).some((x) => x.secret);
        const ep = keyed ? (info?.fields || []).find((f) => f.key === "base_url") : undefined;
        if (!ep) return null;
        if (!ps.showEndpoint)
          return (
            <button
              className="block self-start text-[12.5px] text-muted hover:text-ink mt-4"
              onClick={() => ps.setShowEndpoint(true)}
              data-testid={`${tp}-endpoint-link`}
            >
              {t("Custom endpoint ⌄")}
            </button>
          );
        return (
          <div className="mt-4">
            <label className={label}>{ep.label}</label>
            <div className="relative">
              <input
                className={input + " border-line"}
                type="text"
                placeholder={ep.placeholder}
                value={ps.fields[ep.key] || ""}
                data-testid={`${tp}-field-${ep.key}`}
                onChange={(e) => ps.setFieldValue(ep.key, e.target.value)}
                onBlur={() => void ps.saveField(ep.key)}
              />
              {ps.fieldSaved === ep.key && (
                <span
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-medium text-ok bg-okSoft rounded-full px-2 py-0.5 pointer-events-none"
                  data-testid={`${tp}-field-saved-${ep.key}`}
                >
                  {t("✓ Saved")}
                </span>
              )}
            </div>
            {ep.help && <p className="text-[11.5px] text-faint mt-1">{ep.help}</p>}
          </div>
        );
      })()}

      {/* Error line: fixed height so failures never reflow the form. */}
      <div className="mt-3 min-h-[19px] text-[12.5px]">
        {ps.verify.state === "error" && (
          <span className="text-warnInk">
            {translateDynamic(
              ps.verify.msg || "",
              lang,
              t("Test failed. Check the configuration and network, then try again."),
            )}
          </span>
        )}
      </div>
      {footer}
    </div>
  );
}
