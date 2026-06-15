"""Tests for the pure journal logic in journal.py.

Fixed `now` for deterministic timestamps; pytest tmp_path for file I/O.
Stores are initialized via journal._empty() unless a test needs seeding.
"""

import json
from datetime import datetime

import pytest

import journal

NOW = datetime(2026, 6, 15, 9, 0, 0)


def test_empty_store_shape():
    assert journal._empty() == {"sections": [], "entries": []}


def test_seeded_has_six_default_tag_sections():
    data = journal._seeded()
    names = [s["name"] for s in data["sections"]]
    assert names == ["people", "places", "food", "chores", "health", "work"]
    assert all(s["type"] == "tag" for s in data["sections"])
    assert all(s["tags"] == [] and s["archived"] is False for s in data["sections"])
    # ids are unique
    assert len({s["id"] for s in data["sections"]}) == 6


def test_save_then_load_round_trips(tmp_path):
    path = str(tmp_path / "journal.json")
    data = journal._empty()
    journal.save(path, data)
    assert journal.load(path) == data


def test_load_missing_file_returns_seeded(tmp_path):
    path = str(tmp_path / "nope.json")
    data = journal.load(path)
    assert [s["name"] for s in data["sections"]][0] == "people"


def test_load_corrupt_backs_up_and_seeds(tmp_path):
    path = tmp_path / "journal.json"
    path.write_text("{ not json", encoding="utf-8")
    data = journal.load(str(path))
    assert (tmp_path / "journal.json.bak").exists()
    assert len(data["sections"]) == 6


def test_load_migrates_missing_fields(tmp_path):
    path = tmp_path / "journal.json"
    path.write_text(json.dumps({
        "sections": [{"id": "x", "name": "people", "type": "tag", "color": "#fff"}],
        "entries": [{"id": "e", "date": "2026-06-15", "title": "t", "body": ""}],
    }), encoding="utf-8")
    data = journal.load(str(path))
    s = data["sections"][0]
    assert s["tags"] == [] and s["unit"] is None and s["archived"] is False
    e = data["entries"][0]
    assert e["tags"] == {} and e["numbers"] == {}


# --------------------------------------------------------------------------- #
# Task 2: Section lookup & display helpers
# --------------------------------------------------------------------------- #

def test_active_sections_excludes_archived():
    data = journal._empty()
    a = journal.add_section(data, "people", "tag", "#fff")
    b = journal.add_section(data, "work", "tag", "#000")
    b["archived"] = True
    assert journal.active_sections(data) == [a]


def test_section_by_id_finds_archived_too():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    s["archived"] = True
    assert journal.section_by_id(data, s["id"]) is s
    assert journal.section_by_id(data, "missing") is None


def test_section_color_falls_back_to_default():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#abcdef")
    assert journal.section_color(data, s["id"]) == "#abcdef"
    assert journal.section_color(data, "missing") == journal.DEFAULT_SECTION_COLOR


def test_is_registered_tag():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    s["tags"] = ["maya"]
    assert journal.is_registered_tag(data, s["id"], "maya") is True
    assert journal.is_registered_tag(data, s["id"], "MAYA") is True   # normalized
    assert journal.is_registered_tag(data, s["id"], "ghost") is False


# --------------------------------------------------------------------------- #
# Task 3: Section CRUD with validation
# --------------------------------------------------------------------------- #

def test_add_section_validates_and_assigns_id():
    data = journal._empty()
    s = journal.add_section(data, "  People ", "tag", "#e0a955")
    assert s["name"] == "people"           # normalized
    assert s["type"] == "tag" and s["archived"] is False
    assert len(s["id"]) == 32              # uuid4 hex
    assert journal.active_sections(data) == [s]


def test_add_numeric_section_keeps_unit():
    data = journal._empty()
    s = journal.add_section(data, "sleep", "numeric", "#6fa8dc", unit="hrs")
    assert s["type"] == "numeric" and s["unit"] == "hrs"


def test_add_section_rejects_bad_name():
    data = journal._empty()
    for bad in ["", "   ", "no<script>", "a;b"]:
        with pytest.raises(ValueError):
            journal.add_section(data, bad, "tag", "#fff")


def test_add_section_rejects_bad_type_and_color():
    data = journal._empty()
    with pytest.raises(ValueError):
        journal.add_section(data, "x", "bogus", "#fff")
    with pytest.raises(ValueError):
        journal.add_section(data, "x", "tag", "not-a-color")


def test_add_section_rejects_duplicate_active_name():
    data = journal._empty()
    journal.add_section(data, "people", "tag", "#fff")
    with pytest.raises(ValueError):
        journal.add_section(data, "PEOPLE", "tag", "#000")


def test_rename_section():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.rename_section(data, s["id"], "friends")
    assert journal.section_by_id(data, s["id"])["name"] == "friends"


def test_rename_rejects_duplicate():
    data = journal._empty()
    journal.add_section(data, "people", "tag", "#fff")
    s2 = journal.add_section(data, "work", "tag", "#000")
    with pytest.raises(ValueError):
        journal.rename_section(data, s2["id"], "people")


def test_set_color_and_unit():
    data = journal._empty()
    s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    journal.set_section_color(data, s["id"], "#123456")
    journal.set_section_unit(data, s["id"], "minutes here")  # capped to 12
    s2 = journal.section_by_id(data, s["id"])
    assert s2["color"] == "#123456"
    assert s2["unit"] == "minutes here"[:12]


def test_archive_section_soft_deletes():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.archive_section(data, s["id"])
    assert journal.section_by_id(data, s["id"])["archived"] is True
    assert journal.active_sections(data) == []


# --------------------------------------------------------------------------- #
# Task 4: Permanent tags on sections
# --------------------------------------------------------------------------- #

def test_add_section_tag_appends_normalized_unique():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], " Maya ")
    journal.add_section_tag(data, s["id"], "maya")   # dup ignored
    assert journal.section_by_id(data, s["id"])["tags"] == ["maya"]


def test_add_section_tag_rejects_bad_name_and_numeric_section():
    data = journal._empty()
    tag_s = journal.add_section(data, "people", "tag", "#fff")
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    with pytest.raises(ValueError):
        journal.add_section_tag(data, tag_s["id"], "bad;name")
    with pytest.raises(ValueError):
        journal.add_section_tag(data, num_s["id"], "nope")


def test_remove_section_tag_keeps_entries_unaffected():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.remove_section_tag(data, s["id"], "maya")
    assert journal.section_by_id(data, s["id"])["tags"] == []


# --------------------------------------------------------------------------- #
# Task 5: Entry lookup & date helpers
# --------------------------------------------------------------------------- #

def test_today_iso_uses_injected_now():
    assert journal.today_iso(now=NOW) == "2026-06-15"


def test_valid_date():
    assert journal._valid_date("2026-06-15") is True
    assert journal._valid_date("2026-13-99") is False
    assert journal._valid_date("nope") is False
    assert journal._valid_date(None) is False


def test_get_entry_by_date_and_sorted():
    data = journal._empty()
    journal.upsert_entry(data, "2026-06-13", "older", "", now=NOW)
    journal.upsert_entry(data, "2026-06-15", "newer", "", now=NOW)
    assert journal.get_entry_by_date(data, "2026-06-15")["title"] == "newer"
    assert journal.get_entry_by_date(data, "2026-06-01") is None
    dates = [e["date"] for e in journal.entries_sorted(data)]
    assert dates == ["2026-06-15", "2026-06-13"]   # newest first
