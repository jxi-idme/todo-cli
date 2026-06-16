"""Tests for the journal HTTP layer. Uses test_client() and a temp
JOURNAL_FILE so the real data/journal.json is never touched."""

import pytest

import app as app_module
import journal


@pytest.fixture
def client(tmp_path):
    journal_file = tmp_path / "journal.json"
    flask_app = app_module.app
    flask_app.config["TESTING"] = True
    flask_app.config["JOURNAL_FILE"] = str(journal_file)
    # Seeded store (six default sections), mirroring first run.
    journal.save(str(journal_file), journal._seeded())
    with flask_app.test_client() as c:
        yield c


def _journal_path():
    return app_module.app.config["JOURNAL_FILE"]


def test_todo_index_has_brand_toggle_link_to_journal(client):
    """The brand mascot on the todo page links to the journal, with a
    'journal ->' caption."""
    resp = client.get("/")
    assert resp.status_code == 200
    assert b'class="brand-toggle"' in resp.data
    assert b'href="/journal"' in resp.data
    assert b"journal" in resp.data.lower()


def test_journal_page_brand_toggles_back_to_tasks(client):
    """On the journal side the brand is Pompompurin and links back to /."""
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b"pompompurin" in resp.data.lower()
    assert b'href="/"' in resp.data
    assert b"todo &rarr;" in resp.data or b"todo \xe2\x86\x92" in resp.data


def _first_tag_section_id():
    data = journal.load(_journal_path())
    return journal.active_sections(data)[0]["id"]   # "people"


def test_journal_today_renders_form(client):
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b"What happened today" in resp.data
    assert b"people" in resp.data       # seeded section card


def test_save_creates_entry_and_redirects(client):
    sid = _first_tag_section_id()
    resp = client.post("/journal/save", data={
        "date": "2026-06-15", "title": "A good day", "body": "stuff",
        f"tag:{sid}": "maya",
    })
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert e["title"] == "A good day"
    assert e["tags"][sid] == ["maya"]


def test_save_permanent_new_tag_joins_registry(client):
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "",
        f"newtag-name:{sid}": "cousin lee", f"newtag-kind:{sid}": "permanent",
    })
    data = journal.load(_journal_path())
    assert "cousin lee" in journal.section_by_id(data, sid)["tags"]
    assert "cousin lee" in journal.get_entry_by_date(data, "2026-06-15")["tags"][sid]


def test_save_temporary_new_tag_stays_off_registry(client):
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "",
        f"newtag-name:{sid}": "aunt rosa", f"newtag-kind:{sid}": "temporary",
    })
    data = journal.load(_journal_path())
    assert "aunt rosa" not in journal.section_by_id(data, sid)["tags"]
    assert "aunt rosa" in journal.get_entry_by_date(data, "2026-06-15")["tags"][sid]


def test_save_invalid_title_flashes_and_saves_nothing(client):
    resp = client.post("/journal/save", data={"date": "2026-06-15", "title": "  ", "body": ""})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15") is None


def test_edit_existing_date_prefills(client):
    client.post("/journal/save", data={"date": "2026-06-10", "title": "Past", "body": "hi"})
    resp = client.get("/journal/2026-06-10")
    assert resp.status_code == 200
    assert b"Past" in resp.data
    assert b"Update entry" in resp.data


def test_save_preserves_archived_section_data(client):
    """Editing an entry must not drop data for a section archived after the
    entry was written (the archived-section merge)."""
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", f"tag:{sid}": "maya"})
    data = journal.load(_journal_path())
    journal.archive_section(data, sid)
    journal.save(_journal_path(), data)
    # Re-save the same date WITHOUT the archived section's fields.
    client.post("/journal/save", data={"date": "2026-06-15", "title": "t2", "body": "more"})
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert e["tags"].get(sid) == ["maya"]   # archived data preserved
    assert e["title"] == "t2"


def test_save_unchecking_tag_clears_it(client):
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", f"tag:{sid}": "maya"})
    client.post("/journal/save", data={"date": "2026-06-15", "title": "t", "body": ""})
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert sid not in e["tags"]


def test_save_numeric_zero_round_trips(client):
    data = journal.load(_journal_path())
    s = journal.add_section(data, "sleep", "numeric", "#6fa8dc", unit="hrs")
    journal.save(_journal_path(), data)
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", f"num:{s['id']}": "0"})
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert e["numbers"][s["id"]] == 0.0


def test_save_bad_number_aborts_entirely(client):
    """A bad numeric value aborts the whole save: no entry AND the permanent
    new tag in another section is not persisted (all-or-nothing)."""
    data = journal.load(_journal_path())
    num = journal.add_section(data, "sleep", "numeric", "#6fa8dc", unit="hrs")
    journal.save(_journal_path(), data)
    tag_sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "",
        f"newtag-name:{tag_sid}": "cousin lee", f"newtag-kind:{tag_sid}": "permanent",
        f"num:{num['id']}": "abc"})
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15") is None
    assert "cousin lee" not in journal.section_by_id(data, tag_sid)["tags"]


def test_move_entry_route(client):
    client.post("/journal/save", data={"date": "2026-06-15", "title": "t", "body": ""})
    data = journal.load(_journal_path())
    eid = journal.get_entry_by_date(data, "2026-06-15")["id"]
    resp = client.post(f"/journal/entry/{eid}/move", data={"date": "2026-06-20"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15") is None
    assert journal.get_entry_by_date(data, "2026-06-20") is not None


def test_move_entry_route_rejects_occupied(client):
    client.post("/journal/save", data={"date": "2026-06-15", "title": "t", "body": ""})
    client.post("/journal/save", data={"date": "2026-06-20", "title": "x", "body": ""})
    data = journal.load(_journal_path())
    eid = journal.get_entry_by_date(data, "2026-06-15")["id"]
    resp = client.post(f"/journal/entry/{eid}/move", data={"date": "2026-06-20"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    # both still exist; nothing moved
    assert journal.get_entry_by_date(data, "2026-06-15") is not None
    assert journal.get_entry_by_date(data, "2026-06-20")["title"] == "x"


def test_move_entry_route_rejects_invalid_date(client):
    client.post("/journal/save", data={"date": "2026-06-15", "title": "t", "body": ""})
    data = journal.load(_journal_path())
    eid = journal.get_entry_by_date(data, "2026-06-15")["id"]
    resp = client.post(f"/journal/entry/{eid}/move", data={"date": "not-a-date"})
    assert resp.status_code == 302
    # the entry stays put on its original day
    assert journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-15") is not None


# --------------------------------------------------------------------------- #
# Task 9: Search route and delete route
# --------------------------------------------------------------------------- #

def test_search_lists_all_entries_newest_first(client):
    client.post("/journal/save", data={"date": "2026-06-10", "title": "Older", "body": ""})
    client.post("/journal/save", data={"date": "2026-06-14", "title": "Newer", "body": ""})
    resp = client.get("/journal/search")
    assert resp.status_code == 200
    body = resp.data.decode()
    assert body.index("Newer") < body.index("Older")
    assert b"journal-search.js" in resp.data        # live filtering wired
    assert b"entries-data" in resp.data             # entries embedded as JSON


def test_delete_entry_removes_it(client):
    client.post("/journal/save", data={"date": "2026-06-10", "title": "Bye", "body": ""})
    eid = journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-10")["id"]
    resp = client.post(f"/journal/entry/{eid}/delete")
    assert resp.status_code == 302
    assert journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-10") is None


# --------------------------------------------------------------------------- #
# Task 10: Sections management page
# --------------------------------------------------------------------------- #

def test_sections_page_lists_sections(client):
    resp = client.get("/journal/sections")
    assert resp.status_code == 200
    assert b"people" in resp.data
    assert b"work" in resp.data


def test_add_tag_section(client):
    resp = client.post("/journal/sections/add", data={
        "name": "mood", "type": "tag", "color": "#abcdef"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert any(s["name"] == "mood" and s["type"] == "tag" for s in data["sections"])


def test_add_numeric_section_with_unit(client):
    resp = client.post("/journal/sections/add", data={
        "name": "sleep", "type": "numeric", "color": "#6fa8dc", "unit": "hrs"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    s = next(s for s in data["sections"] if s["name"] == "sleep")
    assert s["type"] == "numeric" and s["unit"] == "hrs"


def test_add_section_bad_color_flashes_and_saves_nothing(client):
    resp = client.post("/journal/sections/add", data={
        "name": "mood", "type": "numeric", "color": "purple"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert not any(s["name"] == "mood" for s in data["sections"])


def test_edit_section_rename_and_color(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    resp = client.post(f"/journal/sections/{sid}/edit", data={
        "name": "friends", "color": "#111111"})
    assert resp.status_code == 302
    s = journal.section_by_id(journal.load(_journal_path()), sid)
    assert s["name"] == "friends" and s["color"] == "#111111"


def test_edit_section_bad_name_flashes(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    original = journal.section_by_id(journal.load(_journal_path()), sid)["name"]
    client.post(f"/journal/sections/{sid}/edit", data={
        "name": "bad;name!", "color": "#abcdef"})
    assert journal.section_by_id(journal.load(_journal_path()), sid)["name"] == original


def test_archive_section_soft_deletes(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    resp = client.post(f"/journal/sections/{sid}/delete")
    assert resp.status_code == 302
    s = journal.section_by_id(journal.load(_journal_path()), sid)
    assert s["archived"] is True


def test_add_permanent_tag_to_section(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    resp = client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    assert resp.status_code == 302
    assert "maya" in journal.section_by_id(journal.load(_journal_path()), sid)["tags"]


def test_remove_permanent_tag_does_not_affect_entries(client):
    """Removing a tag from the master list must NOT remove it from existing entries."""
    sid = _first_tag_section_id()
    # Add the tag to the master list.
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    # Save an entry that uses that tag.
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "Day one", "body": "",
        f"tag:{sid}": "maya",
    })
    # Remove the tag from the master list.
    resp = client.post(f"/journal/sections/{sid}/tags/maya/delete")
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    # Not in the master list anymore.
    assert "maya" not in journal.section_by_id(data, sid)["tags"]
    # Still on the entry.
    entry = journal.get_entry_by_date(data, "2026-06-15")
    assert "maya" in entry["tags"][sid]


# --------------------------------------------------------------------------- #
# Archive page routes
# --------------------------------------------------------------------------- #

def test_archive_page_lists_archived_section(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    client.post(f"/journal/sections/{sid}/delete")
    resp = client.get("/journal/sections/archive")
    assert resp.status_code == 200
    assert b"people" in resp.data


def test_archive_page_lists_archived_tags(client):
    sid = _first_tag_section_id()
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    client.post(f"/journal/sections/{sid}/tags/maya/delete")
    resp = client.get("/journal/sections/archive")
    assert resp.status_code == 200
    assert b"maya" in resp.data


def test_restore_section(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    client.post(f"/journal/sections/{sid}/delete")
    resp = client.post(f"/journal/sections/{sid}/restore")
    assert resp.status_code == 302
    assert journal.section_by_id(journal.load(_journal_path()), sid)["archived"] is False


def test_restore_section_tag(client):
    sid = _first_tag_section_id()
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    client.post(f"/journal/sections/{sid}/tags/maya/delete")
    resp = client.post(f"/journal/sections/{sid}/tags/maya/restore")
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert "maya" in journal.section_by_id(data, sid)["tags"]
    assert "maya" not in journal.section_by_id(data, sid)["archived_tags"]


def test_readd_archived_tag_via_form_unarchives_it(client):
    sid = _first_tag_section_id()
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    client.post(f"/journal/sections/{sid}/tags/maya/delete")
    # Re-add via the normal add-tag form (not the restore route).
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "MAYA"})
    data = journal.load(_journal_path())
    assert "maya" in journal.section_by_id(data, sid)["tags"]
    assert "maya" not in journal.section_by_id(data, sid)["archived_tags"]
