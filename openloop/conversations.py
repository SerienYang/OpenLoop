"""ConversationStore — global, file-backed session storage shared by all surfaces.

Layout under a base dir (default `~/.config/openloop/`):
  openloop.db                  SQLite index: sessions(id → project, title, n_msgs), workspaces, memory
  conversations/<id>.jsonl     append-only message log, one file per conversation

Writes append only the new messages each turn (no rewriting history). Legacy rows that
stored messages inline are lazily migrated to a .jsonl on first load/save.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Optional

from .sessions import SessionRecord


def _load_roots(raw: Optional[str]) -> list[dict]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def _load_grants(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _display_title(row: sqlite3.Row) -> Optional[str]:
    """Title precedence for every read path: a manual rename (renamed=1) always wins,
    then the generated auto_title, then the first-line snapshot `save()` wrote."""
    if row["renamed"]:
        return row["title"]
    return row["auto_title"] or row["title"]


def title_from(messages: list[dict]) -> str:
    from .attachments import content_to_text

    for m in messages:
        if m.get("role") == "user":
            text = content_to_text(m.get("content"), image_placeholder="").strip()
            if text:
                return text.splitlines()[0][:60]
    return "New session"


class ConversationStore:
    def __init__(self, base_dir: str | Path) -> None:
        self.base = Path(base_dir).expanduser()
        self.base.mkdir(parents=True, exist_ok=True)
        self.conv_dir = self.base / "conversations"
        self.conv_dir.mkdir(exist_ok=True)
        self.db_path = self.base / "openloop.db"

        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY, workspace TEXT, model TEXT, mode TEXT,
                title TEXT, agent TEXT DEFAULT 'openloop', n_msgs INTEGER DEFAULT 0, messages TEXT,
                extra_roots TEXT, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
                origin TEXT, origin_label TEXT,
                auto_title TEXT, renamed INTEGER DEFAULT 0,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS workspaces (
                path TEXT PRIMARY KEY, last_used TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS projects (
                project_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE, description TEXT DEFAULT '',
                pinned INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            """)
        for ddl in (
            "ALTER TABLE sessions ADD COLUMN title TEXT",
            "ALTER TABLE sessions ADD COLUMN n_msgs INTEGER DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN agent TEXT DEFAULT 'openloop'",
            "ALTER TABLE sessions ADD COLUMN extra_roots TEXT",
            "ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN origin TEXT",
            "ALTER TABLE sessions ADD COLUMN origin_label TEXT",
            "ALTER TABLE sessions ADD COLUMN auto_title TEXT",
            "ALTER TABLE sessions ADD COLUMN renamed INTEGER DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN grants TEXT",
            "ALTER TABLE sessions ADD COLUMN compaction TEXT",
            "ALTER TABLE sessions ADD COLUMN project_id TEXT",
            "ALTER TABLE sessions ADD COLUMN workspace_kind TEXT",
            "ALTER TABLE sessions ADD COLUMN managed_root TEXT",
            "ALTER TABLE projects ADD COLUMN hidden INTEGER DEFAULT 0",
        ):
            try:
                self._conn.execute(ddl)
            except sqlite3.OperationalError:
                pass
        self._conn.commit()
        self._backfill_counts()

    # -- file helpers -----------------------------------------------------------
    def _file(self, sid: str) -> Path:
        return self.conv_dir / f"{sid}.jsonl"

    def _read_jsonl(self, sid: str) -> Optional[list[dict]]:
        path = self._file(sid)
        if not path.exists():
            return None
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def _count(self, sid: str) -> int:
        path = self._file(sid)
        if not path.exists():
            return 0
        return sum(
            1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
        )

    def _append(self, sid: str, messages: list[dict]) -> None:
        with open(self._file(sid), "a", encoding="utf-8") as f:
            for m in messages:
                f.write(json.dumps(m) + "\n")

    def replace_messages(self, sid: str, messages: list[dict]) -> None:
        """Atomically rewrite a session when persisted recovery sidecars were consumed."""
        with self._lock:
            path = self._file(sid)
            temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
            try:
                with open(temp, "w", encoding="utf-8") as handle:
                    for message in messages:
                        handle.write(json.dumps(message) + "\n")
                os.replace(temp, path)
            finally:
                try:
                    temp.unlink()
                except FileNotFoundError:
                    pass

    def _backfill_counts(self) -> None:
        """One-time per session: move any inline blob into a .jsonl and persist
        title + n_msgs in the index. Skips already-migrated rows on later startups."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT session_id, messages, n_msgs, title FROM sessions"
            ).fetchall()
            for row in rows:
                sid = row["session_id"]
                jsonl = self._file(sid)
                if jsonl.exists() and row["title"] and row["n_msgs"]:
                    continue  # already migrated
                if jsonl.exists():
                    messages = self._read_jsonl(sid) or []
                elif row["messages"]:
                    try:
                        messages = json.loads(row["messages"])
                    except json.JSONDecodeError:
                        messages = []
                    if messages:
                        self._append(sid, messages)
                    self._conn.execute(
                        "UPDATE sessions SET messages = NULL WHERE session_id = ?",
                        (sid,),
                    )
                else:
                    messages = []
                self._conn.execute(
                    "UPDATE sessions SET n_msgs = ?, title = ? WHERE session_id = ?",
                    (len(messages), row["title"] or title_from(messages), sid),
                )
            self._conn.commit()

    # -- API --------------------------------------------------------------------
    def save(self, record: SessionRecord) -> None:
        sid = record.session_id
        with self._lock:
            # lazily migrate a legacy inline blob into the .jsonl
            if not self._file(sid).exists():
                row = self._conn.execute(
                    "SELECT messages FROM sessions WHERE session_id = ?", (sid,)
                ).fetchone()
                if row and row["messages"]:
                    try:
                        legacy = json.loads(row["messages"])
                    except json.JSONDecodeError:
                        legacy = []
                    if legacy:
                        self._append(sid, legacy)

            existing = self._count(sid)
            if len(record.messages) > existing:
                self._append(sid, record.messages[existing:])
            elif len(record.messages) < existing:  # rare; not append-only
                with open(self._file(sid), "w", encoding="utf-8") as f:
                    for m in record.messages:
                        f.write(json.dumps(m) + "\n")

            title = record.title or title_from(record.messages)
            self._conn.execute(
                """
                INSERT INTO sessions (session_id, workspace, model, mode, title, agent, n_msgs, messages, extra_roots, grants, compaction, project_id, workspace_kind, managed_root, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(session_id) DO UPDATE SET
                    workspace = excluded.workspace, model = excluded.model, mode = excluded.mode,
                    title = COALESCE(sessions.title, excluded.title), agent = excluded.agent,
                    n_msgs = excluded.n_msgs, messages = NULL, extra_roots = excluded.extra_roots,
                    grants = excluded.grants, compaction = excluded.compaction,
                    project_id = COALESCE(sessions.project_id, excluded.project_id),
                    workspace_kind = excluded.workspace_kind,
                    managed_root = excluded.managed_root,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    sid,
                    record.workspace,
                    record.model,
                    record.mode,
                    title,
                    record.agent,
                    len(record.messages),
                    json.dumps(record.extra_roots or []),
                    json.dumps(record.grants or {}),
                    json.dumps(record.compaction or {}),
                    record.project_id,
                    record.workspace_kind,
                    record.managed_root,
                ),
            )
            self._conn.commit()
        self.touch_workspace(record.workspace)

    def load(self, session_id: str) -> Optional[SessionRecord]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
        if not row:
            return None
        messages = self._read_jsonl(session_id)
        if messages is None:
            try:
                messages = json.loads(row["messages"] or "[]")
            except json.JSONDecodeError:
                messages = []
        return SessionRecord(
            session_id=session_id,
            workspace=row["workspace"],
            model=row["model"],
            mode=row["mode"],
            project_id=(
                row["project_id"] if "project_id" in row.keys() else None
            ),
            workspace_kind=(
                row["workspace_kind"] if "workspace_kind" in row.keys() else None
            ),
            managed_root=row["managed_root"] if "managed_root" in row.keys() else None,
            messages=messages,
            title=_display_title(row),
            agent=row["agent"] or "openloop",
            message_count=len(messages),
            updated_at=row["updated_at"],
            extra_roots=_load_roots(
                row["extra_roots"] if "extra_roots" in row.keys() else None
            ),
            grants=_load_grants(row["grants"] if "grants" in row.keys() else None),
            # Auto-compaction state (OPE-27) — same defensive parse as grants.
            compaction=_load_grants(
                row["compaction"] if "compaction" in row.keys() else None
            ),
            pinned=bool(row["pinned"]),
            archived=bool(row["archived"]),
            origin=row["origin"],
            origin_label=row["origin_label"],
        )

    def set_extra_roots(self, session_id: str, extra_roots: list[dict]) -> None:
        """Persist just the session's added folders, independent of its message log — used when
        the user adds/removes a folder (which may happen with no active engine)."""
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET extra_roots = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?",
                (json.dumps(extra_roots or []), session_id),
            )
            self._conn.commit()

    def list(self, *, workspace: Optional[str] = None) -> list[SessionRecord]:
        with self._lock:
            if workspace is None:
                rows = self._conn.execute(
                    "SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC"
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM sessions WHERE workspace = ? ORDER BY pinned DESC, updated_at DESC",
                    (workspace,),
                ).fetchall()
        return [
            SessionRecord(
                session_id=r["session_id"],
                workspace=r["workspace"],
                model=r["model"],
                mode=r["mode"],
                project_id=(
                    r["project_id"] if "project_id" in r.keys() else None
                ),
                workspace_kind=(
                    r["workspace_kind"] if "workspace_kind" in r.keys() else None
                ),
                managed_root=r["managed_root"] if "managed_root" in r.keys() else None,
                messages=[],
                title=_display_title(r),
                agent=r["agent"] or "openloop",
                message_count=r["n_msgs"] or 0,
                updated_at=r["updated_at"],
                pinned=bool(r["pinned"]),
                archived=bool(r["archived"]),
                origin=r["origin"],
                origin_label=r["origin_label"],
            )
            for r in rows
        ]

    def touch_workspace(self, path: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO workspaces (path, last_used) VALUES (?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(path) DO UPDATE SET last_used = CURRENT_TIMESTAMP",
                (path,),
            )
            self._conn.commit()

    def recent_workspaces(self, limit: int = 20) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT path FROM workspaces ORDER BY last_used DESC LIMIT ?", (limit,)
            ).fetchall()
        return [r["path"] for r in rows]

    def canonicalize_workspaces(self) -> None:
        with self._lock:
            for (ws,) in self._conn.execute(
                "SELECT DISTINCT workspace FROM sessions WHERE workspace IS NOT NULL"
            ).fetchall():
                real = os.path.realpath(ws)
                if real != ws:
                    self._conn.execute(
                        "UPDATE sessions SET workspace = ? WHERE workspace = ?",
                        (real, ws),
                    )
            latest: dict[str, str] = {}
            for path, last in self._conn.execute(
                "SELECT path, last_used FROM workspaces"
            ).fetchall():
                real = os.path.realpath(path)
                if real not in latest or (last or "") > latest[real]:
                    latest[real] = last
            self._conn.execute("DELETE FROM workspaces")
            for path, last in latest.items():
                self._conn.execute(
                    "INSERT OR REPLACE INTO workspaces (path, last_used) VALUES (?, ?)",
                    (path, last),
                )
            self._conn.commit()

    def _set_workspace_kind(
        self, session_id: str, kind: str, root: Optional[str]
    ) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET workspace_kind = ?, managed_root = ? WHERE session_id = ?",
                (kind, root, session_id),
            )
            self._conn.commit()

    def migrate_workspace_kinds(self, project_paths: set[str]) -> None:
        canonical_projects = {
            os.path.realpath(os.path.expanduser(path)) for path in project_paths
        }
        for rec in self.list():
            if rec.workspace_kind is not None or not rec.workspace:
                continue
            workspace = os.path.realpath(os.path.expanduser(rec.workspace))
            if workspace in canonical_projects:
                self._set_workspace_kind(rec.session_id, "project", None)
            else:
                self._set_workspace_kind(
                    rec.session_id, "managed", str(Path(workspace).parent)
                )

    def delete(self, session_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM sessions WHERE session_id = ?", (session_id,)
            )
            self._conn.commit()
        path = self._file(session_id)
        if path.exists():
            path.unlink()
        return cur.rowcount > 0

    def rename(self, session_id: str, title: str) -> bool:
        clean = " ".join((title or "").split())[:120]
        if not clean:
            return False
        with self._lock:
            # renamed=1 makes the manual title final: auto-titling skips the session and
            # `_display_title` ignores any auto_title already there.
            cur = self._conn.execute(
                "UPDATE sessions SET title = ?, renamed = 1, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?",
                (clean, session_id),
            )
            self._conn.commit()
        return cur.rowcount > 0

    def set_auto_title(self, session_id: str, title: str) -> bool:
        """Store a generated title. Its own column — never `title` — so a manual rename
        (past or future) always wins; doesn't touch updated_at (a title landing after the
        turn must not reorder the session list)."""
        clean = " ".join((title or "").split())[:60]
        if not clean:
            return False
        with self._lock:
            cur = self._conn.execute(
                "UPDATE sessions SET auto_title = ? WHERE session_id = ? AND renamed = 0",
                (clean, session_id),
            )
            self._conn.commit()
        return cur.rowcount > 0

    def title_state(self, session_id: str) -> Optional[dict]:
        """The auto-title guard inputs: whether the user renamed and whether a generated
        title already exists. None when the session has no row yet."""
        with self._lock:
            row = self._conn.execute(
                "SELECT renamed, auto_title FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            return None
        return {"renamed": bool(row["renamed"]), "auto_title": row["auto_title"]}

    def set_flags(
        self,
        session_id: str,
        *,
        pinned: Optional[bool] = None,
        archived: Optional[bool] = None,
    ) -> bool:
        """Update pin/archive flags without touching updated_at (so pinning doesn't reorder)."""
        sets, params = [], []
        if pinned is not None:
            sets.append("pinned = ?")
            params.append(1 if pinned else 0)
        if archived is not None:
            sets.append("archived = ?")
            params.append(1 if archived else 0)
        if not sets:
            return False
        with self._lock:
            cur = self._conn.execute(
                f"UPDATE sessions SET {', '.join(sets)} WHERE session_id = ?",
                (*params, session_id),
            )
            self._conn.commit()
        return cur.rowcount > 0

    def set_origin(self, session_id: str, origin: str, origin_label: str = "") -> bool:
        """Mark where a spawned session came from (§31). Set once at spawn; `save()` never
        names these columns, so per-turn saves can't clobber them (the pinned mechanism).
        """
        with self._lock:
            cur = self._conn.execute(
                "UPDATE sessions SET origin = ?, origin_label = ? WHERE session_id = ?",
                (origin, origin_label or None, session_id),
            )
            self._conn.commit()
        return cur.rowcount > 0

    # -- projects (Codex-style first-class entities) ----------------------------
    @staticmethod
    def _canonical_project_path(path: str | Path) -> str:
        raw = str(path or "").strip()
        if not raw:
            return ""
        return os.path.realpath(os.path.expanduser(raw))

    def _project_payload(self, row: sqlite3.Row | dict) -> dict:
        data = dict(row)
        path = data.get("path") or ""
        data["pinned"] = bool(data.get("pinned"))
        data["hidden"] = bool(data.get("hidden"))
        data["path_exists"] = Path(path).expanduser().is_dir() if path else False
        data["n_sessions"] = int(data.get("n_sessions") or 0)
        data["unarchived_sessions"] = int(data.get("unarchived_sessions") or 0)
        data["archived_sessions"] = int(data.get("archived_sessions") or 0)
        return data

    def create_project(
        self, name: str, path: str, description: str = ""
    ) -> dict:
        """Create a project record bound to a canonical workspace path.

        Returns {"ok": True, "project": {...}} or {"ok": False, "error": ...}.
        The path must be unique — a folder maps to at most one project.
        """
        name = " ".join(str(name or "").split())[:120]
        path = self._canonical_project_path(path)
        if not name:
            return {"ok": False, "error": "project name is required"}
        if not path:
            return {"ok": False, "error": "project path is required"}
        project_id = uuid.uuid4().hex[:12]
        with self._lock:
            existing = self._conn.execute(
                "SELECT project_id, hidden FROM projects WHERE path = ?", (path,)
            ).fetchone()
            if existing:
                if bool(existing["hidden"]):
                    self._conn.execute(
                        "UPDATE projects SET hidden = 0, updated_at = CURRENT_TIMESTAMP "
                        "WHERE project_id = ?",
                        (existing["project_id"],),
                    )
                    self._conn.commit()
                    return {
                        "ok": True,
                        "reopened": True,
                        "project": self.get_project(existing["project_id"]),
                    }
                return {
                    "ok": True,
                    "existing": True,
                    "project": self.get_project(existing["project_id"]),
                }
            self._conn.execute(
                "INSERT INTO projects (project_id, name, path, description) "
                "VALUES (?, ?, ?, ?)",
                (project_id, name, path, str(description or "")[:500]),
            )
            self._conn.commit()
        return {"ok": True, "project": self.get_project(project_id)}

    def get_project(self, project_id: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(
                """SELECT p.*,
                          (SELECT COUNT(*) FROM sessions s
                            WHERE s.project_id = p.project_id) AS n_sessions,
                          (SELECT COUNT(*) FROM sessions s
                            WHERE s.project_id = p.project_id
                              AND COALESCE(s.archived, 0) = 0) AS unarchived_sessions,
                          (SELECT COUNT(*) FROM sessions s
                            WHERE s.project_id = p.project_id
                              AND COALESCE(s.archived, 0) = 1) AS archived_sessions,
                          (SELECT MAX(updated_at) FROM sessions s
                            WHERE s.project_id = p.project_id) AS last_used
                   FROM projects p WHERE p.project_id = ?""",
                (project_id,),
            ).fetchone()
        return self._project_payload(row) if row else None

    def list_projects(self, include_hidden: bool = False) -> list[dict]:
        """All projects, most recently used first (pinned first)."""
        with self._lock:
            rows = self._conn.execute(
                """SELECT p.*,
                          (SELECT COUNT(*) FROM sessions s
                            WHERE s.project_id = p.project_id) AS n_sessions,
                          (SELECT COUNT(*) FROM sessions s
                            WHERE s.project_id = p.project_id
                              AND COALESCE(s.archived, 0) = 0) AS unarchived_sessions,
                          (SELECT COUNT(*) FROM sessions s
                            WHERE s.project_id = p.project_id
                              AND COALESCE(s.archived, 0) = 1) AS archived_sessions,
                          (SELECT MAX(updated_at) FROM sessions s
                            WHERE s.project_id = p.project_id) AS last_used
                   FROM projects p
                   WHERE (? OR COALESCE(p.hidden, 0) = 0)
                   ORDER BY p.pinned DESC,
                     COALESCE((SELECT MAX(updated_at) FROM sessions s
                               WHERE s.project_id = p.project_id), p.updated_at) DESC""",
                (1 if include_hidden else 0,),
            ).fetchall()
        return [self._project_payload(r) for r in rows]

    def project_by_path(self, path: str) -> Optional[dict]:
        """The project bound to this canonical workspace path, if any."""
        canonical = self._canonical_project_path(path)
        if not canonical:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT project_id FROM projects WHERE path = ?", (canonical,)
            ).fetchone()
        return self.get_project(row["project_id"]) if row else None

    def session_ids_for_project(self, project_id: str) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT session_id FROM sessions WHERE project_id = ?",
                (project_id,),
            ).fetchall()
        return [str(row["session_id"]) for row in rows]

    def update_project(
        self,
        project_id: str,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        pinned: Optional[bool] = None,
        hidden: Optional[bool] = None,
        path: Optional[str] = None,
    ) -> bool:
        sets, params = [], []
        if name is not None:
            clean = " ".join(str(name).split())[:120]
            if clean:
                sets.append("name = ?")
                params.append(clean)
        if description is not None:
            sets.append("description = ?")
            params.append(str(description)[:500])
        if pinned is not None:
            sets.append("pinned = ?")
            params.append(1 if pinned else 0)
        if hidden is not None:
            sets.append("hidden = ?")
            params.append(1 if hidden else 0)
        canonical_path = None
        if path is not None:
            canonical_path = self._canonical_project_path(path)
            if not canonical_path:
                return False
            sets.append("path = ?")
            params.append(canonical_path)
        if not sets:
            return False
        sets.append("updated_at = CURRENT_TIMESTAMP")
        params.append(project_id)
        with self._lock:
            if canonical_path is not None:
                existing = self._conn.execute(
                    "SELECT project_id FROM projects WHERE path = ? AND project_id != ?",
                    (canonical_path, project_id),
                ).fetchone()
                if existing:
                    return False
            cur = self._conn.execute(
                f"UPDATE projects SET {', '.join(sets)} WHERE project_id = ?",
                tuple(params),
            )
            if cur.rowcount > 0 and canonical_path is not None:
                self._conn.execute(
                    """UPDATE sessions
                       SET workspace = ?, workspace_kind = 'project',
                           managed_root = NULL
                       WHERE project_id = ?""",
                    (canonical_path, project_id),
                )
            self._conn.commit()
        return cur.rowcount > 0

    def list_archived_sessions(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                """SELECT s.session_id, s.workspace, s.model, s.mode, s.title, s.agent,
                          s.n_msgs AS messages, s.pinned, s.archived, s.updated_at,
                          s.project_id,
                          p.name AS project_name,
                          p.path AS project_path,
                          p.hidden AS project_hidden
                   FROM sessions s
                   LEFT JOIN projects p ON p.project_id = s.project_id
                   WHERE COALESCE(s.archived, 0) = 1
                     AND s.session_id NOT LIKE '__run__%'
                     AND s.session_id NOT LIKE '__task__%'
                   ORDER BY s.updated_at DESC"""
            ).fetchall()
        out: list[dict] = []
        for row in rows:
            data = dict(row)
            data["pinned"] = bool(data.get("pinned"))
            data["archived"] = bool(data.get("archived"))
            data["project_hidden"] = (
                bool(data.get("project_hidden")) if data.get("project_id") else False
            )
            project_path = data.get("project_path") or ""
            if project_path:
                data["workspace"] = project_path
            data["project_path_exists"] = (
                Path(project_path).expanduser().is_dir() if project_path else None
            )
            out.append(data)
        return out

    def delete_project(self, project_id: str) -> bool:
        """Remove the project record; its sessions keep their workspace and become
        ungrouped (project_id → NULL), so no conversation is ever lost."""
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET project_id = NULL WHERE project_id = ?",
                (project_id,),
            )
            cur = self._conn.execute(
                "DELETE FROM projects WHERE project_id = ?", (project_id,)
            )
            self._conn.commit()
        return cur.rowcount > 0

    def set_session_project(
        self,
        session_id: str,
        project_id: Optional[str],
        *,
        project_path: Optional[str] = None,
    ) -> bool:
        """Bind a session to a project (or unbind with None)."""
        with self._lock:
            if project_id is not None and project_path:
                cur = self._conn.execute(
                    """UPDATE sessions
                       SET project_id = ?, workspace = ?, workspace_kind = 'project',
                           managed_root = NULL, updated_at = CURRENT_TIMESTAMP
                       WHERE session_id = ?""",
                    (
                        project_id,
                        self._canonical_project_path(project_path),
                        session_id,
                    ),
                )
            else:
                cur = self._conn.execute(
                    "UPDATE sessions SET project_id = ?, updated_at = CURRENT_TIMESTAMP "
                    "WHERE session_id = ?",
                    (project_id, session_id),
                )
            self._conn.commit()
        return cur.rowcount > 0

    def close(self) -> None:
        self._conn.close()
