from openloop.conversations import ConversationStore
from openloop.sessions import SessionRecord


def test_managed_classification_independent_of_current_root(tmp_path):
    store = ConversationStore(tmp_path)
    former_root = tmp_path / "old_root"
    ws = former_root / "2026-0805-legacyid"
    store.save(
        SessionRecord(
            "legacyid",
            str(ws),
            "m",
            "auto",
            [{"role": "user", "content": "keep me"}],
        )
    )
    project_ws = tmp_path / "my_project"
    store.save(SessionRecord("proj1", str(project_ws), "m", "auto", [], project_id="p1"))

    store.migrate_workspace_kinds(project_paths={str(project_ws)})

    a = store.load("legacyid")
    assert a is not None
    assert a.workspace_kind == "managed"
    assert a.managed_root == str(former_root)
    assert a.messages == [{"role": "user", "content": "keep me"}]
    b = store.load("proj1")
    assert b is not None
    assert b.workspace_kind == "project"
    assert b.managed_root is None


def test_migration_is_idempotent(tmp_path):
    store = ConversationStore(tmp_path)
    store.save(SessionRecord("s", str(tmp_path / "r" / "2026-08-05_s"), "m", "auto", []))
    store.migrate_workspace_kinds(project_paths=set())
    first = store.load("s")
    store.migrate_workspace_kinds(project_paths=set())
    second = store.load("s")
    assert first is not None
    assert second is not None
    assert second.__dict__ == first.__dict__
