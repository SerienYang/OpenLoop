"""Phase 2 gate — self-wake: timer + on-completion wake records and the tools."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from openloop.selfwake import WakeStore, selfwake_tools


def _now():
    return datetime.now(timezone.utc)


def test_timer_due_only_after_fire_time(tmp_path):
    store = WakeStore(tmp_path / "wakes.json")
    soon = store.add_timer("s1", _now() + timedelta(seconds=60))
    past = store.add_timer("s1", _now() - timedelta(seconds=1))
    due_ids = {w.id for w in store.due()}
    assert past.id in due_ids and soon.id not in due_ids


def test_completion_due_only_after_job_completes(tmp_path):
    store = WakeStore(tmp_path / "wakes.json")
    w = store.add_completion("s1", job_id="job-42")
    assert w.id not in {x.id for x in store.due()}  # not yet
    marked = store.complete_job("job-42")
    assert [x.id for x in marked] == [w.id]
    assert w.id in {x.id for x in store.due()}  # now due


def test_mark_fired_removes_from_due(tmp_path):
    store = WakeStore(tmp_path / "wakes.json")
    w = store.add_timer("s1", _now() - timedelta(seconds=1))
    store.mark_fired(w.id)
    assert w.id not in {x.id for x in store.due()}
    assert w.id not in {x.id for x in store.pending("s1")}


def test_claim_due_hides_wake_until_delivery_finishes(tmp_path):
    store = WakeStore(tmp_path / "wakes.json")
    wake = store.add_timer("s1", _now() - timedelta(seconds=1))

    claimed = store.claim_due()

    assert [item.id for item in claimed] == [wake.id]
    assert store.claim_due() == []
    assert store.due() == []
    assert [item.id for item in store.pending("s1")] == [wake.id]


def test_new_wake_replaces_claim_without_old_completion_touching_it(tmp_path):
    store = WakeStore(tmp_path / "wakes.json")
    old = store.add_timer("s1", _now() - timedelta(seconds=1))
    assert [item.id for item in store.claim_due()] == [old.id]

    latest = store.add_timer("s1", _now() + timedelta(minutes=1))
    store.mark_fired(old.id)
    store.release_claim(old.id)

    assert [item.id for item in store.pending("s1")] == [latest.id]


def test_reload_retries_wake_claimed_before_process_exit(tmp_path):
    path = tmp_path / "wakes.json"
    store = WakeStore(path)
    wake = store.add_timer("s1", _now() - timedelta(seconds=1))
    assert [item.id for item in store.claim_due()] == [wake.id]

    reloaded = WakeStore(path)

    assert [item.id for item in reloaded.due()] == [wake.id]


def test_persistence(tmp_path):
    store = WakeStore(tmp_path / "wakes.json")
    w = store.add_completion("s1", "job-1")
    reloaded = WakeStore(tmp_path / "wakes.json")
    assert any(x.id == w.id for x in reloaded.pending("s1"))


def test_new_wake_replaces_previous_wake_for_session(tmp_path):
    store = WakeStore(tmp_path / "wakes.json")
    old = store.add_timer("s1", _now() + timedelta(minutes=1))
    other = store.add_timer("s2", _now() + timedelta(minutes=1))
    latest = store.add_completion("s1", "job-1")

    assert [w.id for w in store.pending("s1")] == [latest.id]
    assert [w.id for w in store.pending("s2")] == [other.id]
    reloaded_ids = {
        w.id for w in WakeStore(tmp_path / "wakes.json").pending("s1")
    }
    assert old.id not in reloaded_ids


def test_reload_collapses_legacy_stacked_wakes_per_session(tmp_path):
    path = tmp_path / "wakes.json"
    path.write_text(
        """
        {
          "wakes": [
            {"id": "old", "session_id": "s1", "kind": "timer", "state": "pending",
             "fire_at": "2026-08-13T09:00:00+00:00",
             "created_at": "2026-08-13T08:00:00+00:00"},
            {"id": "latest", "session_id": "s1", "kind": "timer", "state": "pending",
             "fire_at": "2026-08-13T10:00:00+00:00",
             "created_at": "2026-08-13T08:30:00+00:00"}
          ]
        }
        """,
        encoding="utf-8",
    )

    reloaded = WakeStore(path)
    assert [w.id for w in reloaded.pending("s1")] == ["latest"]
    assert [
        w.id
        for w in reloaded.due(datetime(2026, 8, 13, 11, tzinfo=timezone.utc))
    ] == ["latest"]


def test_event_due_only_after_event_fires(tmp_path):
    store = WakeStore(tmp_path / "wakes.json")
    w = store.add_event("s1", event_key="pr-opened")
    assert w.id not in {x.id for x in store.due()}
    marked = store.fire_event("pr-opened")
    assert [x.id for x in marked] == [w.id]
    assert w.id in {x.id for x in store.due()}


def test_selfwake_tools(tmp_path):
    store = WakeStore(tmp_path / "wakes.json")
    sleep_for, sleep_until, wake_on, wake_on_event = selfwake_tools(store, "s1")

    assert sleep_for(30)["ok"]
    assert wake_on("job-9")["job_id"] == "job-9"
    assert sleep_until((_now() + timedelta(minutes=5)).isoformat())["fire_at"]
    assert wake_on_event("alert-fired")["event_key"] == "alert-fired"

    pend = store.pending("s1")
    assert len(pend) == 1
    assert pend[0].kind == "event"
