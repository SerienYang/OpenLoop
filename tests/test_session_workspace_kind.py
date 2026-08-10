from openloop.conversations import ConversationStore
from openloop.sessions import SessionRecord


def test_workspace_kind_and_managed_root_roundtrip(tmp_path):
    store = ConversationStore(tmp_path)
    rec = SessionRecord(
        session_id="s1",
        workspace=str(tmp_path / "2026-08-05_s1"),
        model="m",
        mode="auto",
        messages=[],
        workspace_kind="managed",
        managed_root=str(tmp_path),
    )
    store.save(rec)
    loaded = store.load("s1")
    assert loaded is not None
    assert loaded.workspace_kind == "managed"
    assert loaded.managed_root == str(tmp_path)


def test_workspace_kind_defaults_to_none_for_legacy_rows(tmp_path):
    store = ConversationStore(tmp_path)
    rec = SessionRecord(session_id="s2", workspace="", model="m", mode="auto", messages=[])
    store.save(rec)
    loaded = store.load("s2")
    assert loaded is not None
    assert loaded.workspace_kind is None
