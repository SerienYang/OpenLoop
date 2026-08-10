import datetime as dt

from openloop.audit import AuditStore


def test_purge_removes_rows_older_than_30_days(tmp_path):
    store = AuditStore(str(tmp_path / "openloop.db"))
    store.append({"tool": "files", "stage": "post", "status": "ok"})
    old = (dt.datetime.utcnow() - dt.timedelta(days=40)).strftime("%Y-%m-%d %H:%M:%S")
    store._conn.execute("UPDATE audit_events SET timestamp = ?", (old,))
    store._conn.commit()
    store.purge_expired(days=30)
    assert store.list(limit=10) == []


def test_clear_all_empties_log(tmp_path):
    store = AuditStore(str(tmp_path / "openloop.db"))
    store.append({"tool": "files", "stage": "post", "status": "ok"})
    store.clear_all()
    assert store.list(limit=10) == []
