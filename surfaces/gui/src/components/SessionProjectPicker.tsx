import { useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { createProject, setSessionProject, type ProjectInfo } from "../api";
import { chooseFolder } from "../tauri";
import { baseName } from "../paths";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

const NEW_PROJECT = "__new__";

// Project assignment for the composer footer (§38, owner ask 2026-08-03): a Codex-style control
// attached to the input — a quiet "Project ▾" chip that names the current binding (default:
// regular session) and opens the picker menu. Picking an existing project (or creating one)
// binds the CURRENT session id via POST /v1/sessions/{id}/project, so the sidebar's project
// tree picks it up immediately.
export function SessionProjectPicker({
  sessionId,
  projects,
  onProjectsChanged,
  onProjectSelected,
  initialProjectId,
}: {
  sessionId: string;
  // Registered Codex-style projects for the assignment menu.
  projects: ProjectInfo[];
  // Refresh sessions/projects after a binding or a create (the sidebar tree must move).
  onProjectsChanged: () => void;
  // Fresh-session assignment: the session may not exist in the backend yet, so the App must
  // switch workspace + project_id before the WebSocket starts the first turn.
  onProjectSelected?: (project: ProjectInfo | null) => void;
  // The session's CURRENT binding (from SessionInfo.project_id) — pre-selects the chip.
  // The App keys this component by sessionId, so a session switch rebuilds from scratch.
  initialProjectId?: string | null;
  // Where the menu pops relative to the chip. The chip normally sits in the composer's
  // TOP toolbar (next to the textarea, Codex-style §38 rev 2026-08-03), where the menu
  // should open DOWN over the textarea area — not up over the transcript.
  menuBelow?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // "" = regular session, "__new__" = inline create form, else a project_id.
  const [assign, setAssign] = useState(initialProjectId || "");
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignErr, setAssignErr] = useState("");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const visibleProjects = projects.filter((p) => !p.hidden);
  const current = visibleProjects.find((p) => p.project_id === assign);

  const positionMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 12;
    const gap = 8;
    const maxHeight = Math.max(160, Math.min(360, rect.top - margin));
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    setMenuStyle({
      position: "fixed",
      left: rect.left,
      bottom: Math.max(margin, viewportHeight - rect.top + gap),
      width: Math.max(230, rect.width),
      maxHeight,
      overflowY: "auto",
      zIndex: 80,
    });
  };

  const openMenu = () => {
    positionMenu();
    setOpen(true);
  };

  const bindProject = async (projectId: string | null) => {
    const project = projectId ? visibleProjects.find((p) => p.project_id === projectId) : null;
    if (onProjectSelected) {
      setAssign(projectId || "");
      onProjectSelected(project || null);
      onProjectsChanged();
      return;
    }
    setAssignBusy(true);
    setAssignErr("");
    const r = await setSessionProject(sessionId, projectId);
    setAssignBusy(false);
    if (r.ok) {
      setAssign(projectId || "");
      onProjectsChanged();
    } else {
      setAssignErr(r.error || t("Could not assign this session to the project"));
    }
  };

  const onCreateProject = async () => {
    const name = newName.trim();
    const path = newPath.trim();
    if (!name || !path) return;
    setAssignBusy(true);
    setAssignErr("");
    const r = await createProject(name, path);
    if (r.ok && r.project) {
      setNewName("");
      setNewPath("");
      if (onProjectSelected) {
        setAssign(r.project.project_id);
        onProjectSelected(r.project);
        onProjectsChanged();
        setAssignBusy(false);
      } else {
        await bindProject(r.project.project_id);
      }
    } else {
      setAssignErr(r.error || t("Could not create the project"));
      setAssignBusy(false);
    }
  };

  const browseNewPath = async () => {
    const picked = await chooseFolder();
    if (picked) setNewPath(picked);
  };

  const label =
    assign === NEW_PROJECT
      ? t("New project…")
      : current
        ? current.name
        : t("Regular session");

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] text-muted hover:text-ink hover:bg-paper shrink-0"
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("This session belongs to")}
        data-testid="session-project-picker"
        disabled={assignBusy}
      >
        <Icon name={current ? "folder" : "folderPlus"} size={13} className="shrink-0" />
        <span className="max-w-[140px] truncate">{label}</span>
        <Icon name="chevronDown" size={11} className="shrink-0" />
      </button>
      {open && (
        createPortal(
          <>
          <div className="fixed inset-0 z-[79]" onClick={() => setOpen(false)} />
          <div
            className="rounded-xl border border-line bg-panel shadow-2xl py-1.5"
            style={menuStyle}
            role="menu"
            aria-label={t("This session belongs to")}
            data-testid="session-project-menu"
            data-placement="top"
          >
            <div className="px-2 py-1 text-[10.5px] uppercase tracking-[0.06em] text-faint font-semibold">
              {t("This session belongs to")}
            </div>
            <button
              role="menuitem"
              className={
                "w-full text-left px-2 py-1.5 rounded-lg text-[12.5px] hover:bg-paper " +
                (assign === "" ? "text-ink font-medium" : "text-muted")
              }
              onClick={() => {
                setOpen(false);
                // If we were in the "new project" inline form, cancel out of it first so the
                // chip label snaps back to "Regular session" even if the unbind fails.
                if (assign === NEW_PROJECT) setAssign("");
                if (assign !== "") bindProject(null);
              }}
            >
              {t("Regular session (no project)")}
            </button>
            {visibleProjects.map((p) => (
              <button
                key={p.project_id}
                role="menuitem"
                className={
                  "w-full text-left px-2 py-1.5 rounded-lg text-[12.5px] hover:bg-paper truncate " +
                  (assign === p.project_id ? "text-ink font-medium" : "text-muted")
                }
                title={p.path}
                onClick={() => {
                  setOpen(false);
                  if (assign !== p.project_id) bindProject(p.project_id);
                }}
              >
                {p.name}
              </button>
            ))}
            <div className="my-1 h-px bg-line" />
            <button
              role="menuitem"
              className="w-full text-left px-2 py-1.5 rounded-lg text-[12.5px] text-accent hover:bg-paper"
              onClick={async () => {
                // Codex parity: creating a project starts from a FOLDER, not a form.
                // Auto-open the OS folder picker; the chosen folder backfills the path
                // (and, unless already typed, the project name) so "Create & assign"
                // is one click away. Cancelling keeps the form for manual entry.
                setAssign(NEW_PROJECT);
                const picked = await chooseFolder();
                if (picked) {
                  setNewPath(picked);
                  setNewName((n) => (n.trim() ? n : baseName(picked)));
                }
              }}
            >
              {t("New project…")}
            </button>
            {assign === NEW_PROJECT && (
              <div className="mt-1 pt-1.5 px-2 pb-1 border-t border-line flex flex-col gap-1.5">
                <input
                  className="project-new-input"
                  placeholder={t("Project name")}
                  value={newName}
                  disabled={assignBusy}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <div className="flex gap-1.5">
                  <input
                    className="project-new-input flex-1"
                    placeholder="/path/to/project"
                    value={newPath}
                    disabled={assignBusy}
                    onChange={(e) => setNewPath(e.target.value)}
                  />
                  <button
                    className="btn"
                    disabled={assignBusy}
                    onClick={browseNewPath}
                    title={t("Pick a folder")}
                  >
                    {t("Browse…")}
                  </button>
                </div>
                <div className="flex gap-1.5 pt-0.5">
                  <button
                    className="btn primary flex-1"
                    disabled={!newName.trim() || !newPath.trim() || assignBusy}
                    onClick={onCreateProject}
                  >
                    {t("Create & assign")}
                  </button>
                  <button className="btn" disabled={assignBusy} onClick={() => setAssign("")}>
                    {t("Cancel")}
                  </button>
                </div>
                {assignErr && <div className="gate-error">{assignErr}</div>}
              </div>
            )}
          </div>
          </>,
          document.body,
        )
      )}
    </div>
  );
}
