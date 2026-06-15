"""Tests for the Flask HTTP layer in app.py.

Each test uses Flask's test_client() and points the app at a temporary
data file (via app config) so we never touch the real data/tasks.json.
"""

import pytest

import app as app_module
import todo


@pytest.fixture
def client(tmp_path):
    """A Flask test client backed by a fresh temp data file."""
    data_file = tmp_path / "tasks.json"
    flask_app = app_module.app
    flask_app.config["TESTING"] = True
    flask_app.config["DATA_FILE"] = str(data_file)
    # Start each test from a clean, empty store.
    todo.save(str(data_file), {"active": [], "archive": []})
    with flask_app.test_client() as c:
        yield c


def _data_path(client):
    return app_module.app.config["DATA_FILE"]


def test_get_index_ok(client):
    resp = client.get("/")
    assert resp.status_code == 200


def test_get_index_shows_active_tasks(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Visible task")
    todo.save(_data_path(client), data)

    resp = client.get("/")
    assert b"Visible task" in resp.data


def test_post_add_redirects_and_adds(client):
    resp = client.post("/add", data={"title": "New task"})
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    titles = [t["title"] for t in data["active"]]
    assert "New task" in titles


def test_post_add_empty_title_not_added(client):
    resp = client.post("/add", data={"title": "   "})
    assert resp.status_code == 302   # still redirects gracefully

    data = todo.load(_data_path(client))
    assert data["active"] == []


def test_post_add_with_due(client):
    client.post("/add", data={"title": "Has due", "due": "2026-07-01T09:00"})
    data = todo.load(_data_path(client))
    assert data["active"][0]["due"] == "2026-07-01T09:00"


def test_post_add_bad_due_not_added(client):
    resp = client.post("/add", data={"title": "Bad due", "due": "not-a-date"})
    assert resp.status_code == 302   # still redirects gracefully

    data = todo.load(_data_path(client))
    assert data["active"] == []   # nothing added


def test_post_refresh_moves_to_archive(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Finish me")
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    resp = client.post("/refresh", data={"completed": task_id})
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert data["active"] == []
    assert len(data["archive"]) == 1
    assert data["archive"][0]["title"] == "Finish me"


def test_post_delete_removes_task(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Delete me")
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    resp = client.post(f"/delete/{task_id}")
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert data["active"] == []


def test_get_archive_shows_completed_only(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Active one")
    todo.add_task(data, "Will archive")
    todo.save(_data_path(client), data)
    archive_id = data["active"][1]["id"]
    client.post("/refresh", data={"completed": archive_id})

    resp = client.get("/archive")
    assert resp.status_code == 200
    assert b"Will archive" in resp.data
    assert b"Active one" not in resp.data


def test_empty_state_pages_render(client):
    assert client.get("/").status_code == 200
    assert client.get("/archive").status_code == 200


# --------------------------------------------------------------------------- #
# Recurring tasks via the add form
# --------------------------------------------------------------------------- #

def test_post_add_recurring_daily(client):
    client.post("/add", data={
        "title": "Daily standup",
        "due": "2026-07-01T09:00",
        "recurrence": "daily",
    })
    data = todo.load(_data_path(client))
    assert data["active"][0]["recurrence"] == "daily"


def test_post_add_custom_recurrence(client):
    client.post("/add", data={
        "title": "Every 3 days",
        "due": "2026-07-01T09:00",
        "recurrence": "custom",
        "custom_n": "3",
    })
    data = todo.load(_data_path(client))
    assert data["active"][0]["recurrence"] == "every:3"


def test_post_add_recurrence_without_due_not_added(client):
    resp = client.post("/add", data={
        "title": "No due recurring",
        "recurrence": "daily",
    })
    assert resp.status_code == 302   # graceful redirect
    data = todo.load(_data_path(client))
    assert data["active"] == []      # rejected, nothing added


# --------------------------------------------------------------------------- #
# Edit routes
# --------------------------------------------------------------------------- #

def test_get_edit_returns_200_and_prefills(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Original title", due="2026-07-01T09:00")
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    resp = client.get(f"/edit/{task_id}")
    assert resp.status_code == 200
    assert b"Original title" in resp.data


def test_get_edit_unknown_id_redirects(client):
    resp = client.get("/edit/does-not-exist")
    assert resp.status_code == 302


def test_post_edit_updates_task(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Before")
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    resp = client.post(f"/edit/{task_id}", data={
        "title": "After",
        "due": "2026-08-01T10:00",
        "recurrence": "weekly",
    })
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    task = data["active"][0]
    assert task["title"] == "After"
    assert task["due"] == "2026-08-01T10:00"
    assert task["recurrence"] == "weekly"


def test_post_edit_validation_failure_does_not_save(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Keep me")
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    # Empty title -> validation error -> no change.
    resp = client.post(f"/edit/{task_id}", data={"title": "   "})
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert data["active"][0]["title"] == "Keep me"


# --------------------------------------------------------------------------- #
# Expired section rendering
# --------------------------------------------------------------------------- #

def test_index_renders_expired_section(client):
    # Seed a store with an expired entry directly.
    data = {
        "active": [],
        "archive": [],
        "expired": [{
            "id": "exp1",
            "title": "Missed timesheet",
            "due": "2026-06-14T17:00:00",
            "recurrence": "daily",
            "created": "x",
            "expired_at": "2026-06-15T12:00:00",
        }],
    }
    todo.save(_data_path(client), data)

    resp = client.get("/")
    assert resp.status_code == 200
    assert b"Expired" in resp.data
    assert b"Missed timesheet" in resp.data
