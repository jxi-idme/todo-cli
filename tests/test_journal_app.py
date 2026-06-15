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
