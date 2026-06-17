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
    # Start each test from a clean, fully-initialized store (includes the
    # "tags" key) rather than the migration path.
    todo.save(str(data_file), todo._empty())
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


def test_post_add_recurrence_without_due_defaults(client):
    resp = client.post("/add", data={
        "title": "No due recurring",
        "recurrence": "daily",
    })
    assert resp.status_code == 302
    data = todo.load(_data_path(client))
    assert len(data["active"]) == 1          # added with a defaulted due date
    t = data["active"][0]
    assert t["recurrence"] == "daily"
    assert t["due"] and t["due"].endswith("T23:59:00")


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


# --------------------------------------------------------------------------- #
# Tags -- filtering on the index
# --------------------------------------------------------------------------- #

def test_get_index_filters_by_tags(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.set_tag_color(data, "home", "#3fae5a")
    todo.add_task(data, "Work thing", tags=["work"])
    todo.add_task(data, "Home thing", tags=["home"])
    todo.save(_data_path(client), data)

    # Filtering to ?tags=work shows only the work task.
    resp = client.get("/?tags=work")
    assert resp.status_code == 200
    assert b"Work thing" in resp.data
    assert b"Home thing" not in resp.data


def test_get_index_no_filter_shows_all(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Work thing", tags=["work"])
    todo.add_task(data, "Untagged thing", tags=[])
    todo.save(_data_path(client), data)

    resp = client.get("/")
    assert resp.status_code == 200
    assert b"Work thing" in resp.data
    assert b"Untagged thing" in resp.data


def test_get_index_unknown_tag_shows_all(client):
    # A stale/unknown tag in ?tags= should be dropped (behaves like no filter)
    # rather than silently showing an empty list.
    data = todo.load(_data_path(client))
    todo.add_task(data, "Work thing", tags=["work"])
    todo.add_task(data, "Untagged thing", tags=[])
    todo.save(_data_path(client), data)

    resp = client.get("/?tags=nonexistent")
    assert resp.status_code == 200
    assert b"Work thing" in resp.data
    assert b"Untagged thing" in resp.data


def test_filter_chip_link_url_encodes_tag_with_space(client):
    # A tag name containing a space must produce a properly percent-encoded
    # filter link (space -> %20), and filtering by the encoded query must work.
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work item", "#e0a955")
    todo.add_task(data, "Spaced thing", tags=["work item"])
    todo.add_task(data, "Other thing", tags=[])
    todo.save(_data_path(client), data)

    resp = client.get("/")
    assert resp.status_code == 200
    # The chip link encodes the space (Werkzeug uses "+" for spaces in a query)
    # rather than embedding it raw, which would break the URL.
    assert b"tags=work+item" in resp.data
    assert b"tags=work item" not in resp.data

    # Filtering via the encoded query works and narrows the list. Both "+"
    # and "%20" decode to a space, so either form filters correctly.
    for encoded in ("/?tags=work+item", "/?tags=work%20item"):
        resp = client.get(encoded)
        assert resp.status_code == 200
        assert b"Spaced thing" in resp.data
        assert b"Other thing" not in resp.data


def test_get_index_filter_union(client):
    data = todo.load(_data_path(client))
    # Register the tags so they survive the index's registry intersection.
    todo.set_tag_color(data, "work", "#e0a955")
    todo.set_tag_color(data, "home", "#3fae5a")
    todo.set_tag_color(data, "errand", "#2b5cb8")
    todo.add_task(data, "Aaa", tags=["work"])
    todo.add_task(data, "Bbb", tags=["home"])
    todo.add_task(data, "Ccc", tags=["errand"])
    todo.save(_data_path(client), data)

    resp = client.get("/?tags=work,home")
    assert resp.status_code == 200
    assert b"Aaa" in resp.data
    assert b"Bbb" in resp.data
    assert b"Ccc" not in resp.data


# --------------------------------------------------------------------------- #
# Tags -- filtering on the archive page
# --------------------------------------------------------------------------- #

def _archive_task(client, title, tags):
    """Helper: add a tagged active task then refresh it into the archive."""
    data = todo.load(_data_path(client))
    todo.add_task(data, title, tags=tags)
    todo.save(_data_path(client), data)
    task_id = next(t["id"] for t in data["active"] if t["title"] == title)
    client.post("/refresh", data={"completed": task_id})


def test_get_archive_filters_by_tags(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.set_tag_color(data, "home", "#3fae5a")
    todo.save(_data_path(client), data)
    _archive_task(client, "Work thing", ["work"])
    _archive_task(client, "Home thing", ["home"])

    # Filtering to ?tags=work shows only the archived work task.
    resp = client.get("/archive?tags=work")
    assert resp.status_code == 200
    assert b"Work thing" in resp.data
    assert b"Home thing" not in resp.data


def test_get_archive_renders_tags(client):
    # A tagged archived task should render its tag name (highlight + chips),
    # not just the bare title.
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)
    _archive_task(client, "Tagged archived", ["work"])

    resp = client.get("/archive")
    assert resp.status_code == 200
    assert b"Tagged archived" in resp.data
    # The tag name appears (filter chip row and/or extra-tag chips).
    assert b"work" in resp.data


def test_get_archive_unknown_tag_shows_all(client):
    # A stale/unknown tag in ?tags= should be dropped (behaves like no filter).
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)
    _archive_task(client, "Work thing", ["work"])
    _archive_task(client, "Untagged thing", [])

    resp = client.get("/archive?tags=nonexistent")
    assert resp.status_code == 200
    assert b"Work thing" in resp.data
    assert b"Untagged thing" in resp.data


def test_get_archive_empty_filter_renders_empty_state(client):
    # Filtering down to nothing still renders the page (friendly empty state).
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.set_tag_color(data, "home", "#3fae5a")
    todo.save(_data_path(client), data)
    _archive_task(client, "Work thing", ["work"])

    # Filter by a known tag that no archived task carries -> empty result.
    resp = client.get("/archive?tags=home")
    assert resp.status_code == 200
    assert b"Work thing" not in resp.data


# --------------------------------------------------------------------------- #
# Tags -- add / edit with tags + new-tag color registration
# --------------------------------------------------------------------------- #

def test_post_add_with_existing_and_new_tag(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    client.post("/add", data={
        "title": "Tagged task",
        "tags": ["work"],                 # existing tag (checkbox)
        "new_tag": "Urgent",              # brand-new tag
        "new_tag_color": "#e0524d",
    })

    data = todo.load(_data_path(client))
    task = data["active"][0]
    # Both tags attached, normalized.
    assert task["tags"] == ["work", "urgent"]
    # The new tag's color was registered.
    assert data["tags"]["urgent"] == "#e0524d"


def test_post_add_invalid_new_tag_color_not_saved(client):
    resp = client.post("/add", data={
        "title": "Bad tag",
        "new_tag": "weird",
        "new_tag_color": "notacolor",
    })
    assert resp.status_code == 302   # graceful redirect
    data = todo.load(_data_path(client))
    # Nothing saved -- task not added and tag not registered.
    assert data["active"] == []
    assert "weird" not in data["tags"]


def test_post_edit_updates_tags(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "home", "#3fae5a")
    todo.add_task(data, "Task", tags=["home"])
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    client.post(f"/edit/{task_id}", data={
        "title": "Task",
        "tags": ["home"],
        "new_tag": "weekend",
        "new_tag_color": "#abc",
    })

    data = todo.load(_data_path(client))
    task = data["active"][0]
    assert task["tags"] == ["home", "weekend"]
    assert data["tags"]["weekend"] == "#abc"


# --------------------------------------------------------------------------- #
# Tags -- manage tags page
# --------------------------------------------------------------------------- #

def test_get_tags_page_renders(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    resp = client.get("/tags")
    assert resp.status_code == 200
    assert b"work" in resp.data


def test_get_tags_page_empty_state(client):
    resp = client.get("/tags")
    assert resp.status_code == 200   # friendly empty state, no tags yet


def test_post_tags_updates_color(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    resp = client.post("/tags", data={"name": "work", "color": "#123456"})
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert data["tags"]["work"] == "#123456"


def test_post_tags_invalid_color_rejected(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    resp = client.post("/tags", data={"name": "work", "color": "nope"})
    assert resp.status_code == 302   # graceful redirect

    data = todo.load(_data_path(client))
    # Color unchanged -- registry not corrupted.
    assert data["tags"]["work"] == "#e0a955"


def test_post_tags_unregistered_name_not_created(client):
    # The manage page may only recolor EXISTING tags; a POST naming an unknown
    # tag must not create a spurious registry entry.
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    resp = client.post("/tags", data={"name": "ghost", "color": "#123456"})
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert "ghost" not in data["tags"]
    assert data["tags"] == {"work": "#e0a955"}   # registry unchanged


def test_post_tag_delete_removes_tag_and_redirects(client):
    # Deleting a tag via the route removes it from the registry AND from a
    # task that carried it, then redirects back to the tags page.
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.add_task(data, "Work thing", tags=["work"])
    todo.save(_data_path(client), data)

    resp = client.post("/tags/work/delete")
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert "work" not in data["tags"]
    assert data["active"][0]["tags"] == []


# --------------------------------------------------------------------------- #
# Flashed validation messages
# --------------------------------------------------------------------------- #

def test_add_empty_title_flashes_and_not_added(client):
    # A bad submission surfaces a flash message (visible after the redirect)
    # and adds nothing.
    resp = client.post("/add", data={"title": "   "}, follow_redirects=True)
    assert resp.status_code == 200
    assert b"Could not add task" in resp.data

    data = todo.load(_data_path(client))
    assert data["active"] == []


def test_post_tags_invalid_color_flashes(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    resp = client.post(
        "/tags", data={"name": "work", "color": "nope"}, follow_redirects=True
    )
    assert resp.status_code == 200
    assert b"Could not update tag color" in resp.data


def test_heartbeat_returns_204(client):
    resp = client.get("/heartbeat")
    assert resp.status_code == 204


def test_refresh_saves_difficulty(client):
    client.post("/add", data={"title": "rate me"})
    data = todo.load(_data_path(client))
    tid = data["active"][0]["id"]
    resp = client.post("/refresh", data={"completed": tid, f"difficulty:{tid}": "hard"})
    assert resp.status_code == 302
    data = todo.load(_data_path(client))
    assert data["archive"][0]["difficulty"] == "hard"


def test_active_page_has_difficulty_picker(client):
    client.post("/add", data={"title": "task one"})
    html = client.get("/").get_data(as_text=True)
    assert 'class="difficulty-picker"' in html
    data = todo.load(_data_path(client))
    tid = data["active"][0]["id"]
    assert f'name="difficulty:{tid}"' in html
