import { useEffect, useState, type ReactNode } from "react";
import { imeComposing } from "../ime";
import {
  AUTOMATIONS_CHANGED,
  createProject,
  getAutomations,
  getSettings,
  setNavLayout,
  removeProject,
  updateProject,
  type Automation,
  type ProjectInfo,
  type RecentWorkspace,
} from "../api";
import type { SessionInfo } from "../types";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { Icon, type IconName } from "./Icon";
import { SearchModal } from "./SearchModal";
import { baseName } from "../paths";
import { useI18n } from "../i18n";
import { chooseFolder } from "../tauri";

const SURFACES: { key: string; label: string; icon: IconName; cls: string }[] = [
  { key: "openloop", label: "OpenLoop", icon: "diamond", cls: "ico-openloop" },
];

// Attention = Pending items awaiting a session (an accent count that bubbles session → OpenLoop →
// the first-class Pending row — all views of one queue, never a second list).
function AttnBadge({ n }: { n: number }) {
  const { t } = useI18n();
  if (!n) return null;
  return (
    <span
      className="text-[10px] font-semibold text-ink bg-faint/30 rounded-full px-1.5 leading-[15px] shrink-0"
      title={t("{{count}} awaiting your attention", { count: n })}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

// UX-023: unseen-run count on a Scheduled entry. Deliberately QUIET — same neutral
// treatment as the attention badge; failure only colors the tooltip's words, not the
// sidebar (owner call 2026-07-20: no color, and the entry alone carries the count).
function UnseenBadge({ n, failed }: { n: number; failed?: boolean }) {
  const { t } = useI18n();
  if (!n) return null;
  return (
    <span
      className="text-[10px] font-semibold text-ink bg-faint/30 rounded-full px-1.5 leading-[15px] shrink-0"
      title={
        failed
          ? t("{{count}} new runs — the latest failed", { count: n })
          : t("{{count}} new runs", { count: n })
      }
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

// Liveness = working (in-flight turn) / sleeping (a self-wake is pending). A count-less dot that
// never bubbles — it says "this is alive", not "this needs you".
function LiveDot({ state }: { state?: "working" | "sleeping" | "idle" }) {
  const { t } = useI18n();
  if (state !== "working" && state !== "sleeping") return null;
  return state === "working" ? (
    <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" title={t("Working now")} />
  ) : (
    <span
      className="w-1.5 h-1.5 rounded-full bg-faint/60 shrink-0"
      title={t("Sleeping (will wake itself)")}
    />
  );
}

// §31: a session spawned by a platform mention wears its platform's logo, right-aligned beside
// the title cluster (owner call 2026-07-13). Slack today; the origin key is the platform id.
function OriginIcon({ s }: { s: SessionInfo }) {
  const { t } = useI18n();
  if (s.origin !== "slack") return null;
  return (
    <ConnectorIcon
      connector={{ logo: "slack", brand_color: "#611f69" }}
      size={12}
      title={s.origin_label || t("From Slack")}
    />
  );
}

// A subscribed-connector presence dot (right edge of a row). Brand-colorless here — the sidebar
// isn't passed the connector registry — so it reads as a neutral "listening on a channel" dot.
function ConnectorDot({ subs }: { subs?: string[] }) {
  if (!subs || subs.length === 0) return null;
  return (
    <span
      className="w-1.5 h-1.5 rounded-full bg-faint shrink-0"
      data-brand={subs[0]}
      title={subs.join(", ")}
    />
  );
}

interface Props {
  agent: string;
  workspace: string;
  sessions: SessionInfo[];
  projects: RecentWorkspace[];
  // Registered Codex-style projects (id → name/path) for grouping sessions by name.
  projectIndex: ProjectInfo[];
  activeSession: string;
  onNewSession: (agent: string) => void;
  onNewProjectSession: (project: ProjectInfo) => void;
  onSelectSession: (id: string, workspace: string, agent: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
  onArchiveSession: (id: string, archived: boolean) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onManage: () => void;
  onOpenScheduled: () => void;
  // Scheduled-band row click: open the Automations surface ON that automation (UX-023).
  onOpenAutomation: (id: string) => void;
  onOpenInbox: () => void;
  onOpenSkills: () => void;
  onProjectsChanged?: () => void;
  scheduledActive: boolean;
  inboxActive: boolean;
  skillsActive: boolean;
  // Collapse controls (⌘B / hover-peek). `onCollapse` docks/undocks; `onPeekLeave` hides the
  // floating peek when the pointer leaves the panel.
  collapsed?: boolean;
  onCollapse?: () => void;
  onPeekLeave?: () => void;
}

// Compact age for project session rows: "now" / "5m" / "6h" / "3d" / "2w" / "4mo" / "2y".
const compactAge = (iso?: string | null): string => {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
};

// Sessions shown per group before "Show more" comes from Settings (sessions_peek, default 5).

export function Sidebar(props: Props) {
  const { t } = useI18n();
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  // UX-023: automations feed the nav row's badge + the Scheduled band. The 15s poll
  // is the baseline; mutations announce AUTOMATIONS_CHANGED for an instant refresh
  // (mark-seen must clear the badge the moment the detail opens).
  const [automations, setAutomations] = useState<Automation[]>([]);
  useEffect(() => {
    const load = () => getAutomations().then(setAutomations).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    window.addEventListener(AUTOMATIONS_CHANGED, load);
    return () => {
      clearInterval(t);
      window.removeEventListener(AUTOMATIONS_CHANGED, load);
    };
  }, []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // Two-step delete inside the row's ⋮ menu: Delete arms ("Delete?"), a second click deletes.
  // Archive is the primary way to put a conversation away — one click, reversible.
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);
  // The open row-actions ⋮ menu (one at a time). Fixed-position, not absolute: the expanded
  // accordion group clips overflow (its rounded fill), so an absolute popover on its lower rows
  // would be cut off — same constraint as SlackDetail's person picker.
  const [rowMenu, setRowMenu] = useState<{
    id: string;
    top: number;
    left: number;
    anchor: HTMLElement;
  } | null>(null);
  const closeRowMenu = () => {
    setRowMenu(null);
    setConfirmDelId(null);
  };
  const openRowMenu = (id: string, anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect();
    const MENU_W = 160; // w-40
    const MENU_H = 150; // ~4 items + divider; only used to flip upward near the window bottom
    setConfirmDelId(null);
    setRowMenu({
      id,
      top: r.bottom + 4 + MENU_H > window.innerHeight ? r.top - MENU_H : r.bottom + 4,
      left: Math.max(8, r.right - MENU_W),
      anchor,
    });
  };
  const [projectMenu, setProjectMenu] = useState<{
    id: string;
    top: number;
    left: number;
    anchor: HTMLElement;
  } | null>(null);
  const closeProjectMenu = () => setProjectMenu(null);
  const openProjectMenu = (id: string, anchor: HTMLElement) => {
    closeRowMenu();
    const r = anchor.getBoundingClientRect();
    const MENU_W = 176;
    const MENU_H = 112;
    setProjectMenu({
      id,
      top: r.bottom + 4 + MENU_H > window.innerHeight ? r.top - MENU_H : r.bottom + 4,
      left: Math.max(8, r.right - MENU_W),
      anchor,
    });
  };
  useEffect(() => {
    if (!rowMenu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRowMenu();
    // Scrolling an ANCESTOR of the anchor row detaches the fixed menu from it — dismiss.
    // Filter by containment: unrelated scrollers (the transcript auto-follow during a
    // streaming turn fires constantly) must not close the menu.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t === document || (t instanceof Node && t.contains(rowMenu.anchor))) closeRowMenu();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowMenu]);
  useEffect(() => {
    if (!projectMenu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeProjectMenu();
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t === document || (t instanceof Node && t.contains(projectMenu.anchor))) closeProjectMenu();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectMenu]);
  const [showArchived, setShowArchived] = useState(false);

  // "grouped" keeps the OpenLoop accordion; "flat" is a chronological session list.
  const defaultLayout: "flat" | "grouped" = "flat";
  const [layout, setLayout] = useState<"flat" | "grouped">(defaultLayout);
  // Sessions shown per group before "Show more" — Settings ▸ Appearance ▸ Sidebar.
  const [peek, setPeek] = useState(5);
  useEffect(() => {
    getSettings()
      .then((s) => {
        setLayout(
          s.nav_layout === "flat" ? "flat" : s.nav_layout === "grouped" ? "grouped" : defaultLayout,
        );
        if (s.sessions_peek) setPeek(s.sessions_peek);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setGroupBy = (next: "flat" | "grouped") => {
    setLayout(next);
    setNavLayout(next).catch(() => {});
  };
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);

  const [openKey, setOpenKey] = useState<string | null>("openloop");
  const browseKey = openKey ?? "openloop";

  // Per-project collapse. The active workspace's folder is open by default.
  const [projToggled, setProjToggled] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const toggleSet = (set: Set<string>, key: string) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  };

  // Manually pinned sessions render in the dedicated top band.
  const pinnedSessions = props.sessions.filter(
    (s) => s.pinned && !s.session_id.startsWith("__") && !s.archived,
  );
  // §31 (revised 2026-07-21): mention-spawned sessions list chronologically in Recent like any
  // other session — the OriginIcon in the row's indicator cluster marks where they came from.
  // The separate collapsed "From Slack" band hid fresh mentions below week-old sessions.
  const navItem = (
    testId: string,
    icon: IconName,
    label: string,
    active: boolean,
    onClick: () => void,
    trailing?: ReactNode,
  ) => (
    <div className="px-2.5 mt-1">
      <button
        className={
          "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-left hover:bg-paper hover:text-ink " +
          (active ? "text-ink bg-paper" : "text-muted")
        }
        data-testid={testId}
        onClick={onClick}
      >
        <Icon name={icon} size={15} className="shrink-0" />
        <span className="flex-1">{label}</span>
        {trailing}
      </button>
    </div>
  );

  // Roll per-session attention/liveness up to the OpenLoop header and Pending entry.
  // accent count bubbles (sum), the liveness dot aggregates (working wins over sleeping).
  const attentionBySurface = new Map<string, number>();
  const livenessBySurface = new Map<string, "working" | "sleeping">();
  let totalAttention = 0;
  for (const s of props.sessions) {
    if (s.session_id.startsWith("__") || s.archived) continue;
    const a = s.attention || 0;
    if (a > 0) {
      attentionBySurface.set("openloop", (attentionBySurface.get("openloop") || 0) + a);
      totalAttention += a;
    }
    if (s.liveness === "working") livenessBySurface.set("openloop", "working");
    else if (s.liveness === "sleeping" && livenessBySurface.get("openloop") !== "working")
      livenessBySurface.set("openloop", "sleeping");
  }

  // Pinned sessions live only in the dedicated band and do not repeat in grouped/flat lists.
  const all = props.sessions.filter((s) => !s.session_id.startsWith("__"));
  const mine = all.filter((s) => !s.archived && !s.pinned);
  const archived = all.filter((s) => s.archived);
  // Search now lives in the SearchModal (command-palette overlay), so the sidebar lists never filter
  // in place — these stay constant and the `.filter(matches)` / `normalizedQuery ? …` call sites
  // below are intentional no-ops kept to avoid churn.
  const normalizedQuery = "";
  const matches = (_s: SessionInfo) => true;
  const visibleProjects = props.projectIndex.filter((p) => !p.hidden);
  const hiddenProjectIds = new Set(
    props.projectIndex.filter((p) => p.hidden).map((p) => p.project_id),
  );
  const addProject = async () => {
    const picked = await chooseFolder();
    if (!picked) return;
    const name = baseName(picked) || picked;
    const res = await createProject(name, picked);
    if (res.ok) props.onProjectsChanged?.();
  };

  // Recent = every non-pinned, non-archived session, newest first
  // (by updated_at; missing timestamps keep store order), search-filtered. Drives the flat layout.
  const recentSessions = [...props.sessions]
    .filter((s) => !s.archived && !s.session_id.startsWith("__") && !s.pinned)
    .filter((s) => !s.project_id || !hiddenProjectIds.has(s.project_id))
    .filter(matches)
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));

  // Flat layout = the same TWO sections (owner ask 2026-08-03): 普通会话 (no project) and
  // 项目会话 (project tree). The chronological cap applies to the whole list first, then the
  // shown slice is split into the two sections.
  const recentShown = recentSessions;
  const recentRegular = recentShown.filter((s) => !s.project_id);
  const recentProject = recentShown.filter((s) => s.project_id);

  // Row actions live behind ONE ⋮ kebab per row (FB-011: four hover icons read as clutter) —
  // the menu offers Rename · Pin/Unpin · Archive/Unarchive · Delete, with the two-step delete
  // confirm kept inside it. Shared by BOTH row styles, so the chronological cardRow offers the
  // same actions in grouped and chronological layouts.
  const rowActions = (s: SessionInfo, title: string) => {
    const menuOpen = rowMenu?.id === s.session_id;
    const item = (testid: string, icon: IconName, label: string, onClick: () => void) => (
      <button
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] text-left hover:bg-paper"
        data-testid={testid}
        role="menuitem"
        onClick={() => {
          closeRowMenu();
          onClick();
        }}
      >
        <Icon name={icon} size={13} className="shrink-0 text-muted" />
        <span className="flex-1">{label}</span>
      </button>
    );
    return (
      <span
        // Stay visible while this row's menu is open — the pointer may be on the menu, off the row.
        className={(menuOpen ? "flex" : "hidden group-hover:flex") + " items-center shrink-0"}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          title={t("Session actions")}
          aria-label={t("Session actions")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-testid="row-menu"
          className={
            "w-5 h-5 grid place-items-center rounded hover:bg-paper " +
            (menuOpen ? "text-ink bg-paper" : "text-faint hover:text-ink")
          }
          onClick={(e) => (menuOpen ? closeRowMenu() : openRowMenu(s.session_id, e.currentTarget))}
        >
          {/* Vertical kebab = the horizontal glyph rotated — no extra icon needed. */}
          <Icon name="moreHorizontal" size={14} className="rotate-90" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={closeRowMenu} />
            <div
              className="fixed z-50 w-40 rounded-xl border border-line bg-panel shadow-xl py-1"
              style={{ top: rowMenu!.top, left: rowMenu!.left }}
              role="menu"
            >
              {item("row-menu-rename", "pencil", t("Rename"), () => {
                setEditingId(s.session_id);
                setEditValue(title);
              })}
              {item("row-menu-pin", "pin", s.pinned ? t("Unpin") : t("Pin"), () =>
                props.onTogglePin(s.session_id, !s.pinned),
              )}
              {item("row-menu-archive", "archive", s.archived ? t("Unarchive") : t("Archive"), () =>
                props.onArchiveSession(s.session_id, !s.archived),
              )}
              <div className="h-px bg-line my-1 mx-2" />
              {confirmDelId === s.session_id ? (
                <button
                  title={t("Click again to permanently delete")}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] text-left font-medium text-danger hover:bg-paper"
                  data-testid="row-menu-delete"
                  role="menuitem"
                  onClick={() => {
                    closeRowMenu();
                    props.onDeleteSession(s.session_id);
                  }}
                >
                  <Icon name="trash" size={13} className="shrink-0" />
                  <span className="flex-1">{t("Delete?")}</span>
                </button>
              ) : (
                <button
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] text-left text-danger hover:bg-paper"
                  data-testid="row-menu-delete"
                  role="menuitem"
                  onClick={() => setConfirmDelId(s.session_id)}
                >
                  <Icon name="trash" size={13} className="shrink-0" />
                  <span className="flex-1">{t("Delete")}</span>
                </button>
              )}
            </div>
          </>
        )}
      </span>
    );
  };

  // A compact session row (mock §141 grouped/recent rows): one-line title + right-side indicators,
  // with the ⋮ actions kebab revealed on hover. Used in accordion bodies + grouped cards.
  const sessionRow = (s: SessionInfo, opts: { showTime?: boolean } = {}) => {
    const title = s.title || s.session_id;
    const editing = editingId === s.session_id;
    const active = s.session_id === props.activeSession;
    const commitRename = () => {
      const next = editValue.trim();
      if (next && next !== title) props.onRenameSession(s.session_id, next);
      setEditingId(null);
    };
    return (
      <div
        key={s.session_id}
        className={
          "group flex items-center gap-2 px-2 py-1.5 rounded-lg text-left cursor-pointer " +
          (active
            ? "bg-ink/[0.055]"
            : "hover:bg-panel")
        }
        onClick={() => {
          if (!editing) props.onSelectSession(s.session_id, s.workspace, s.agent);
        }}
        title={editing ? undefined : title}
      >
        {editing ? (
          <input
            className="flex-1 min-w-0 px-1.5 py-0.5 rounded-md bg-panel border border-accent text-[13px] text-ink outline-none"
            value={editValue}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (imeComposing(e)) return;
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setEditingId(null);
            }}
          />
        ) : (
          <>
            <span
              className={
                "min-w-0 flex-1 flex items-center gap-1.5 truncate text-[13px] " +
                (active ? "font-medium text-ink" : "text-ink")
              }
            >
              {s.pinned && <Icon name="pin" size={11} className="text-faint shrink-0" />}
              <span className="truncate">{title}</span>
            </span>
            <span
              className={
                "flex items-center gap-1.5 shrink-0 group-hover:hidden" +
                (rowMenu?.id === s.session_id ? " hidden" : "")
              }
            >
              {opts.showTime && compactAge(s.updated_at) && (
                <span className="text-[11px] text-faint tabular-nums">{compactAge(s.updated_at)}</span>
              )}
              <OriginIcon s={s} />
              <LiveDot state={s.liveness} />
              <AttnBadge n={s.attention || 0} />
            </span>
            {rowActions(s, title)}
          </>
        )}
      </div>
    );
  };

  // A single-line card row: title + right-side indicators, with actions revealed on hover.
  const cardRow = (s: SessionInfo) => {
    const active = s.session_id === props.activeSession;
    const title = s.title || s.session_id;
    const editing = editingId === s.session_id;
    const commitRename = () => {
      const next = editValue.trim();
      if (next && next !== title) props.onRenameSession(s.session_id, next);
      setEditingId(null);
    };
    return (
      <div
        key={s.session_id}
        className={
          "group w-full flex items-center gap-2.5 px-2 py-2 rounded-lg cursor-pointer text-left " +
          (active
            ? "bg-ink/[0.055]"
            : "hover:bg-paper")
        }
        title={editing ? undefined : title}
        onClick={() => {
          if (!editing) props.onSelectSession(s.session_id, s.workspace, s.agent);
        }}
      >
        {/* No leading glyph on session rows (Rohit's call 2026-07-07: the per-session icon
            read as noise in both grouped and chronological). */}
        {editing ? (
          <input
            className="flex-1 min-w-0 px-1.5 py-0.5 rounded-md bg-panel border border-accent text-[13px] text-ink outline-none"
            value={editValue}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (imeComposing(e)) return;
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setEditingId(null);
            }}
          />
        ) : (
          <>
            <span className="min-w-0 flex-1 block truncate text-[13px] font-medium">
              {title}
            </span>
            <span
              className={
                "flex items-center gap-1.5 shrink-0 group-hover:hidden" +
                (rowMenu?.id === s.session_id ? " hidden" : "")
              }
            >
              <OriginIcon s={s} />
              <ConnectorDot subs={s.subscriptions} />
              <LiveDot state={s.liveness} />
              <AttnBadge n={s.attention || 0} />
            </span>
            {rowActions(s, title)}
          </>
        )}
      </div>
    );
  };

  // The Pinned band appears in both grouped and chronological layouts.
  const pinnedBand = () =>
    pinnedSessions.length > 0 ? (
      <div>
        <div className="px-1.5 text-[10.5px] uppercase tracking-[0.07em] text-faint font-semibold mb-1">
          {t("Pinned")}
        </div>
        <div className="space-y-0.5">
          {pinnedSessions.map((s) => cardRow(s))}
        </div>
      </div>
    ) : null;

  // UX-023: the Scheduled band — ONE entry per automation (never per run): name +
  // cadence, with the unseen-runs badge. Runs themselves never enter Recent (run
  // sessions are __run__-prefixed and hidden from the sessions list).
  const scheduledBand = () =>
    automations.length > 0 ? (
      <div data-testid="scheduled-band">
        <div className="px-1.5 text-[10.5px] uppercase tracking-[0.07em] text-faint font-semibold mb-1">
          {t("Scheduled")}
        </div>
        <div className="space-y-0.5">
          {automations.map((a) => (
            <button
              key={a.id}
              className="w-full flex items-center gap-2 px-1.5 py-1 rounded-lg text-left hover:bg-paper"
              data-testid={`scheduled-${a.id}`}
              title={a.title}
              onClick={() => props.onOpenAutomation(a.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-ink truncate">{a.title}</div>
                <div className="text-[11px] text-faint truncate">{a.schedule}</div>
              </div>
              <UnseenBadge n={a.unseen_runs || 0} failed={a.unseen_failed} />
            </button>
          ))}
        </div>
      </div>
    ) : null;

  // RECENT header switches between the OpenLoop accordion and chronological list.
  const recentHeader = () => {
    return (
    <div className="relative flex items-center justify-between px-1.5 mb-1" data-testid="recent-header">
      <span className="text-[10.5px] uppercase tracking-[0.07em] text-faint font-semibold">
        {t("Recent")}
      </span>
      <button
        className="w-6 h-6 grid place-items-center rounded-md text-faint hover:text-ink hover:bg-paper -mr-1"
        title={t("Group & filter conversations")}
        aria-label={t("Group and filter conversations")}
        onClick={() => setGroupMenuOpen((v) => !v)}
      >
        <Icon name="sliders" size={14} />
      </button>
      {groupMenuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setGroupMenuOpen(false)} />
          <div
            className="absolute right-0 top-7 z-50 w-56 rounded-xl border border-line bg-panel shadow-xl p-1.5"
            role="menu"
            data-testid="group-filter-menu"
          >
            <div className="px-2 pt-1 pb-1 text-[10.5px] uppercase tracking-[0.06em] text-faint font-semibold">
              {t("Group by")}
            </div>
            {([["grouped", "OpenLoop"], ["flat", t("Chronological")]] as ["flat" | "grouped", string][]).map(
              ([key, label]) => (
                <button
                  key={key}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13px] text-left hover:bg-paper"
                  onClick={() => setGroupBy(key)}
                >
                  <span className="flex-1">{label}</span>
                  {layout === key && <span className="text-accent text-[12px]">✓</span>}
                </button>
              ),
            )}
          </div>
        </>
      )}
    </div>
    );
  };

  // Sidebar session list = TWO flat sections (owner ask 2026-08-03): 普通会话 (sessions without a
  // project) and 项目会话 (project sessions in a project tree). Sessions are bound to a project by
  // project_id; the backend auto-binds any session whose workspace matches a registered project.
  const sectionLabel = (label: string, action?: ReactNode) => (
    <div className="px-1.5 pt-1 text-[10.5px] uppercase tracking-[0.07em] text-faint font-semibold flex items-center gap-2">
      <span className="flex-1">{t(label)}</span>
      {action}
    </div>
  );

  // The project tree: collapsible project folders containing their sessions.
  const projectTree = (
    list: SessionInfo[],
    row: (s: SessionInfo) => ReactNode,
    opts: { includeVisibleProjects?: boolean } = {},
  ) => {
    const byId = new Map(visibleProjects.map((p) => [p.project_id, p]));
    const groups = new Map<
      string,
      { key: string; label: string; path: string; project?: ProjectInfo; sessions: SessionInfo[] }
    >();
    if (opts.includeVisibleProjects) {
      for (const proj of visibleProjects) {
        groups.set(proj.project_id, {
          key: proj.project_id,
          label: proj.name,
          path: proj.path,
          project: proj,
          sessions: [],
        });
      }
    }
    for (const s of list) {
      if (!s.project_id) continue;
      if (hiddenProjectIds.has(s.project_id)) continue;
      const proj = byId.get(s.project_id);
      const key = proj ? proj.project_id : `ws:${s.workspace}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          label: proj ? proj.name : baseName(s.workspace) || s.workspace,
          path: proj ? proj.path : s.workspace,
          project: proj,
          sessions: [],
        };
        groups.set(key, g);
      }
      g.sessions.push(s);
    }
    // Pinned projects first, then by name — a stable tree.
    const order = [...groups.values()].sort((a, b) => {
      const ap = a.key.startsWith("ws:") ? 0 : byId.get(a.key)?.pinned ? 1 : 0;
      const bp = b.key.startsWith("ws:") ? 0 : byId.get(b.key)?.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return a.label.localeCompare(b.label);
    });
    if (order.length === 0) {
      return (
        <div className="px-2 py-1.5 text-[12px] text-faint leading-snug">
          {t("Sessions assigned to a project appear here.")}
        </div>
      );
    }
    return (
      <div className="space-y-0.5">
        {order.map((g) => {
          const list2 = g.sessions.filter(matches);
          if (normalizedQuery && list2.length === 0) return null; // hide non-matching folders while searching
          const isActive = g.path === props.workspace;
          // Flush tree: folders are open until toggled (XOR on the key).
          const open = !!normalizedQuery || !projToggled.has(g.key);
          const shown = list2;
          const proj = g.project;
          const projectMenuOpen = projectMenu?.id === g.key;
          const projectMenuItem = (
            testid: string,
            icon: IconName,
            label: string,
            onClick: () => void,
            danger = false,
          ) => (
            <button
              className={
                "w-full flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] text-left hover:bg-paper " +
                (danger ? "text-danger" : "")
              }
              data-testid={testid}
              role="menuitem"
              onClick={() => {
                closeProjectMenu();
                onClick();
              }}
            >
              <Icon name={icon} size={13} className="shrink-0 text-muted" />
              <span className="flex-1">{label}</span>
            </button>
          );
          return (
            <div key={g.key}>
              <div
                className={
                  "flex items-center gap-1.5 px-1.5 py-1 rounded-lg cursor-pointer select-none hover:bg-panel " +
                  (isActive ? "text-ink" : "text-muted hover:text-ink")
                }
                onClick={() => setProjToggled((s) => toggleSet(s, g.key))}
                title={g.path}
              >
                <Icon name="folder" size={15} className="shrink-0" />
                <span
                  className={
                    "truncate min-w-0 flex-1 text-[12.5px] " + (isActive ? "font-semibold" : "font-medium")
                  }
                >
                  {g.label}
                </span>
                {proj && (
                  <span className="text-[10px] font-semibold text-ink bg-faint/30 rounded-full px-1.5 leading-[15px] shrink-0">
                    {proj.unarchived_sessions ?? list2.length}
                  </span>
                )}
                {proj?.path_exists === false && (
                  <span className="text-[10.5px] text-warnInk bg-warnSoft rounded-full px-1.5 shrink-0">
                    {t("Folder missing")}
                  </span>
                )}
                <Icon
                  name={open ? "chevronDown" : "chevronRight"}
                  size={12}
                  className="text-faint shrink-0"
                />
                {proj && (
                  <button
                    title={t("Project actions")}
                    aria-label={t("Project actions")}
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    data-testid={`project-menu-${g.key}`}
                    className={
                      "w-5 h-5 grid place-items-center rounded hover:bg-paper " +
                      (projectMenuOpen ? "text-ink bg-paper" : "text-faint hover:text-ink")
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      projectMenuOpen ? closeProjectMenu() : openProjectMenu(g.key, e.currentTarget);
                    }}
                  >
                    <Icon name="moreHorizontal" size={14} className="rotate-90" />
                  </button>
                )}
                {projectMenuOpen && proj && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={closeProjectMenu} />
                    <div
                      className="fixed z-50 w-44 rounded-xl border border-line bg-panel shadow-xl py-1"
                      style={{ top: projectMenu!.top, left: projectMenu!.left }}
                      role="menu"
                    >
                      {projectMenuItem("project-menu-rename", "pencil", t("Rename"), () => {
                        const next = window.prompt(t("Project name"), proj.name)?.trim();
                        if (next && next !== proj.name) {
                          updateProject(proj.project_id, { name: next }).then(() =>
                            props.onProjectsChanged?.(),
                          );
                        }
                      })}
                      {projectMenuItem(
                        `project-menu-new-session-${g.key}`,
                        "chat",
                        t("New session"),
                        () => props.onNewProjectSession(proj),
                      )}
                      {projectMenuItem(
                        "project-menu-pin",
                        "pin",
                        proj.pinned ? t("Unpin") : t("Pin"),
                        () =>
                          updateProject(proj.project_id, { pinned: !proj.pinned }).then(() =>
                            props.onProjectsChanged?.(),
                          ),
                      )}
                      <div className="h-px bg-line my-1 mx-2" />
                      {projectMenuItem(
                        `project-menu-remove-${g.key}`,
                        "archive",
                        t("Remove"),
                        () =>
                          removeProject(proj.project_id).then(() =>
                            props.onProjectsChanged?.(),
                          ),
                        true,
                      )}
                    </div>
                  </>
                )}
              </div>
              {open &&
                (list2.length > 0 ? (
                  // pl-[19px] aligns each session's name under the folder NAME (folder icon
                  // 15 + gap 6 + row px 6 − session px 8 = 19).
                  <div className="space-y-0.5 pl-[19px]">
                    {shown.map((s) => row(s))}
                    {proj?.path_exists === false && (
                      <div className="px-2 py-1 text-[12px] text-warnInk leading-snug">
                        {t("This project folder is missing. Reopen it from Settings → Conversations.")}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="px-2 py-1.5 pl-[19px] text-[12px] text-faint leading-snug">
                    {t("No conversations in this project yet.")}
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    );
  };

  const visibleSurfaces = SURFACES;

  const isCurrent = (key: string) => key === "openloop";
  const isExpanded = (key: string) => openKey === key; // its body is open
  // Expand ≠ switch: clicking a header only browses (toggles the accordion). The chat area
  // changes only when a session is selected or "New session" is clicked.
  const onHeaderClick = (key: string) => setOpenKey((k) => (k === key ? null : key));

  // The expanded OpenLoop body splits regular and project sessions.
  const surfaceBody = () => {
    const regular = mine.filter((s) => !s.project_id);
    const projectBound = mine.filter((s) => s.project_id);
    return (
      <div className="space-y-1 px-1.5 pb-2 pt-0.5">
        {regular.length > 0 || projectBound.length === 0 ? (
          <>
            {sectionLabel("Regular sessions")}
            {regular.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-faint leading-snug">
                {t("No regular sessions yet.")}
              </div>
            ) : (
              <div className="space-y-0.5">
                {(showAll.has(browseKey) ? regular : regular.slice(0, peek)).map((s) =>
                  sessionRow(s),
                )}
                {!showAll.has(browseKey) && regular.length > peek && (
                  <button
                    className="px-2 py-1 text-[12px] text-faint hover:text-muted"
                    onClick={() => setShowAll((s) => toggleSet(s, browseKey))}
                  >
                    {t("Show more ({{count}})", { count: regular.length - peek })}
                  </button>
                )}
              </div>
            )}
          </>
        ) : null}

        {projectBound.length > 0 ? (
          <>
            {sectionLabel("Project sessions")}
            {projectTree(projectBound, (s) => sessionRow(s, { showTime: true }))}
          </>
        ) : null}

        {archived.length > 0 && (
          <div className="mt-2 pt-1.5 border-t border-line">
            <button
              className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-[12px] text-faint hover:text-muted"
              onClick={() => setShowArchived((v) => !v)}
            >
              <Icon name={showArchived ? "chevronDown" : "chevronRight"} size={13} className="shrink-0" />
              {t("Archived ({{count}})", { count: archived.length })}
            </button>
            {showArchived && (
              <div className="space-y-0.5 mt-0.5">{archived.filter(matches).map((s) => sessionRow(s))}</div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="sidebar flex flex-col min-h-0 bg-panel border-r border-line"
      onMouseLeave={props.onPeekLeave}
    >
      {/* Header: collapse/pin control FIRST + wordmark. The pin sits at the same screen position
          as the collapsed reveal button (see .nav-pin-btn / .nav-reveal-btn in styles.css), so
          hovering the reveal peeks the nav and the pin lands right under the cursor — no travel.
          data-tauri-drag-region drags the window; on desktop the row clears the traffic lights. */}
      <div className="brand px-3.5 pt-2.5 pb-2 flex items-center gap-2" data-tauri-drag-region>
        {/* Collapse (dock) / pin the sidebar. ⌘B mirrors this. */}
        {props.onCollapse && (
          <button
            className="nav-pin-btn w-7 h-7 grid place-items-center rounded-md text-faint hover:text-ink hover:bg-paper shrink-0"
            title={props.collapsed ? t("Dock sidebar (⌘B)") : t("Collapse sidebar (⌘B)")}
            aria-label={props.collapsed ? t("Dock sidebar") : t("Collapse sidebar")}
            onClick={props.onCollapse}
          >
            <Icon name="sidebar" size={16} />
          </button>
        )}
        <div className="brand-wordmark text-[15px]">OpenLoop<span className="beta-tag">BETA</span></div>
      </div>

      <div className="px-3 pt-2">
        <button
          className="newsplit-primary w-full text-left px-3 py-2 bg-accent text-onAccent text-[13px] font-medium hover:opacity-95 flex items-center gap-2 rounded-lg"
          onClick={() => props.onNewSession("openloop")}
        >
          <Icon name="plus" size={15} className="shrink-0" /> {t("New session")}
        </button>
      </div>

      {navItem("nav-skills", "book", t("Skills"), props.skillsActive, props.onOpenSkills)}
      {navItem(
        "nav-pending",
        "inbox",
        t("Pending"),
        props.inboxActive,
        props.onOpenInbox,
        <AttnBadge n={totalAttention} />,
      )}

      {/* Search: a borderless nav-style entry (not a boxed input) that opens the command-palette
          SearchModal over the whole app. Matches the bottom-nav rows to reduce the boxy look. */}
      <div className="px-2.5 mt-1">
        <button
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-left text-muted hover:bg-paper hover:text-ink"
          onClick={() => setSearchModalOpen(true)}
        >
          <Icon name="search" size={15} className="shrink-0" /> {t("Search")}
        </button>
      </div>

      {navItem("nav-automations", "clock", t("Automations"), props.scheduledActive, props.onOpenScheduled)}
      {navItem(
        "nav-settings",
        "gear",
        t("Settings"),
        false,
        props.onManage,
        <span className="text-[11px] text-faint">⌘ ,</span>,
      )}

      {/* Scroll area: Pinned band + grouped body or the Codex-style project-first flat list. */}
      <div className="flex-1 overflow-y-auto px-2.5 mt-3 pb-2">
        <div className="space-y-4">
          {pinnedBand()}
          {scheduledBand()}
          <div>
            {layout === "grouped" && recentHeader()}
            {layout === "grouped" ? (
            <div className="space-y-1.5">
              {visibleSurfaces.map((s) => {
                const expanded = isExpanded(s.key);
                return (
                  // When expanded, the wrapper carries the recessed fill so the header sits INSIDE
                  // the block with its sessions (one connected group). Collapsed = a plain row.
                  <div
                    key={s.key}
                    className={expanded ? "rounded-xl bg-paper/70 overflow-hidden" : ""}
                  >
                    <div
                      className={
                        "flex items-center gap-2.5 px-2 py-2 cursor-pointer select-none " +
                        (expanded
                          ? ""
                          : isCurrent(s.key)
                            ? "rounded-lg bg-paper"
                            : "rounded-lg hover:bg-paper")
                      }
                      onClick={() => onHeaderClick(s.key)}
                    >
                      <span
                        className={
                          "min-w-0 flex-1 truncate text-[13px] " +
                          (isCurrent(s.key) ? "font-semibold text-ink" : "font-medium text-ink")
                        }
                      >
                        {t(s.label)}
                      </span>
                      <LiveDot state={livenessBySurface.get(s.key)} />
                      <AttnBadge n={attentionBySurface.get(s.key) || 0} />
                      <Icon
                        name={expanded ? "chevronDown" : "chevronRight"}
                        size={15}
                        className="text-faint shrink-0"
                      />
                    </div>
                    {expanded && surfaceBody()}
                  </div>
                );
              })}
            </div>
            ) : (
            <div className="space-y-0.5">
              {recentSessions.length === 0 && visibleProjects.length === 0 ? (
                <div className="px-2 py-1.5 text-[12px] text-faint leading-snug">
                  {normalizedQuery ? t("No matching conversations.") : t("No conversations yet.")}
                </div>
              ) : (
                <>
                  {sectionLabel(
                    "Projects",
                    <button
                      data-testid="project-add"
                      aria-label={t("New project")}
                      title={t("New project")}
                      className="w-5 h-5 grid place-items-center rounded-md text-faint hover:text-ink hover:bg-paper"
                      onClick={() => void addProject()}
                    >
                      <Icon name="plus" size={13} />
                    </button>,
                  )}
                  {projectTree(recentProject, cardRow, { includeVisibleProjects: true })}
                  <div className="mt-3">
                    {sectionLabel("Recent")}
                    {recentRegular.length === 0 ? (
                      <div className="px-2 py-1.5 text-[12px] text-faint leading-snug">
                        {t("No regular sessions yet.")}
                      </div>
                    ) : (
                      <div className="space-y-0.5">{recentRegular.map((s) => cardRow(s))}</div>
                    )}
                  </div>
                </>
              )}
            </div>
            )}
          </div>
        </div>
      </div>

      {searchModalOpen && (
        <SearchModal
          sessions={props.sessions}
          onSelect={(id, ws, ag) => {
            setSearchModalOpen(false);
            props.onSelectSession(id, ws, ag);
          }}
          onClose={() => setSearchModalOpen(false)}
        />
      )}
    </div>
  );
}
