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


def test_remove_section_tag_removes_from_master_list_but_keeps_entry_tags():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    # Create an entry that uses the tag before removing it from the section
    e = journal.upsert_entry(data, "2026-06-15", "t", "",
                             tags={s["id"]: ["maya"]}, now=NOW)
    journal.remove_section_tag(data, s["id"], "maya")
    # Tag is gone from the section's master list ...
    assert journal.section_by_id(data, s["id"])["tags"] == []
    # ... but the entry still carries it (historical data preserved)
    assert e["tags"] == {s["id"]: ["maya"]}


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


# --------------------------------------------------------------------------- #
# Task 6: Entry upsert & delete
# --------------------------------------------------------------------------- #

def test_upsert_creates_then_updates_same_date():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    e1 = journal.upsert_entry(data, "2026-06-15", "Day one", "body",
                              tags={s["id"]: ["maya"]}, now=NOW)
    assert e1["created"] == NOW.isoformat()
    assert e1["tags"] == {s["id"]: ["maya"]}
    # same date -> updates, does not duplicate
    later = datetime(2026, 6, 15, 21, 0, 0)
    e2 = journal.upsert_entry(data, "2026-06-15", "Edited", "new body", now=later)
    assert len(data["entries"]) == 1
    assert e2["id"] == e1["id"]
    assert e2["created"] == NOW.isoformat()       # preserved
    assert e2["updated"] == later.isoformat()     # bumped
    assert e2["title"] == "Edited"
    assert e2["body"] == "new body"


def test_upsert_validates_date_and_title():
    data = journal._empty()
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "bad-date", "t", "", now=NOW)
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "   ", "", now=NOW)


def test_upsert_cleans_tags_and_numbers():
    data = journal._empty()
    tag_s = journal.add_section(data, "people", "tag", "#fff")
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    e = journal.upsert_entry(
        data, "2026-06-15", "t", "",
        tags={tag_s["id"]: [" Maya ", "maya", "dad"], "ghost-section": ["x"]},
        numbers={num_s["id"]: "8.5", "ghost-section": "3"},
        now=NOW,
    )
    assert e["tags"] == {tag_s["id"]: ["maya", "dad"]}   # normalized, deduped, ghost dropped
    assert e["numbers"] == {num_s["id"]: 8.5}            # cast to float, ghost dropped


def test_upsert_rejects_non_numeric_value():
    data = journal._empty()
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "t", "",
                             numbers={num_s["id"]: "eight"}, now=NOW)


def test_upsert_rejects_nan_number():
    data = journal._empty()
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "t", "",
                             numbers={num_s["id"]: "nan"}, now=NOW)


def test_upsert_rejects_inf_number():
    data = journal._empty()
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "t", "",
                             numbers={num_s["id"]: "inf"}, now=NOW)


def test_upsert_accepts_archived_section_id_for_tag():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    section_id = s["id"]
    journal.archive_section(data, section_id)
    # Archived section id should be accepted so historical data is preserved
    e = journal.upsert_entry(data, "2026-06-15", "t", "",
                             tags={section_id: ["maya"]}, now=NOW)
    assert e["tags"] == {section_id: ["maya"]}


def test_delete_entry():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    journal.delete_entry(data, e["id"])
    assert data["entries"] == []


# --------------------------------------------------------------------------- #
# entry_dates
# --------------------------------------------------------------------------- #

def test_entry_dates_sorted_unique():
    data = journal._empty()
    journal.upsert_entry(data, "2026-06-15", "a", "", now=NOW)
    journal.upsert_entry(data, "2026-06-13", "b", "", now=NOW)
    assert journal.entry_dates(data) == ["2026-06-13", "2026-06-15"]
    assert journal.entry_dates(journal._empty()) == []


# --------------------------------------------------------------------------- #
# move_entry
# --------------------------------------------------------------------------- #

def test_move_entry_to_empty_date():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    journal.move_entry(data, e["id"], "2026-06-20")
    assert journal.get_entry_by_date(data, "2026-06-15") is None
    assert journal.get_entry_by_date(data, "2026-06-20")["id"] == e["id"]


def test_move_entry_rejects_occupied_target():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    journal.upsert_entry(data, "2026-06-20", "other", "", now=NOW)
    with pytest.raises(ValueError):
        journal.move_entry(data, e["id"], "2026-06-20")
    # unchanged
    assert journal.get_entry_by_date(data, "2026-06-15")["id"] == e["id"]


def test_move_entry_rejects_bad_date():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    with pytest.raises(ValueError):
        journal.move_entry(data, e["id"], "nope")


def test_move_entry_same_date_is_noop():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    journal.move_entry(data, e["id"], "2026-06-15")
    assert journal.get_entry_by_date(data, "2026-06-15")["id"] == e["id"]


# --------------------------------------------------------------------------- #
# Task 9: Search index helpers
# --------------------------------------------------------------------------- #

def test_search_index_shape_and_order():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.upsert_entry(data, "2026-06-13", "old", "ran in the park",
                         tags={s["id"]: ["maya"]}, now=NOW)
    journal.upsert_entry(data, "2026-06-15", "new", "quiet day", now=NOW)
    idx = journal.search_index(data)
    assert [i["date"] for i in idx] == ["2026-06-15", "2026-06-13"]   # newest first
    older = idx[1]
    assert older["title"] == "old" and older["body"] == "ran in the park"
    assert older["tags"] == ["maya"]


def test_numeric_bounds():
    data = journal._empty()
    s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    journal.upsert_entry(data, "2026-06-13", "a", "", numbers={s["id"]: "6"}, now=NOW)
    journal.upsert_entry(data, "2026-06-15", "b", "", numbers={s["id"]: "9"}, now=NOW)
    assert journal.numeric_bounds(data)[s["id"]] == [6.0, 9.0]
    s2 = journal.add_section(data, "weight", "numeric", "#fff", unit="lbs")
    assert s2["id"] not in journal.numeric_bounds(data)   # no values -> omitted


# --------------------------------------------------------------------------- #
# Archived tags & sections
# --------------------------------------------------------------------------- #

def test_remove_section_tag_archives_not_deletes():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.remove_section_tag(data, s["id"], "maya")
    assert "maya" not in journal.section_by_id(data, s["id"])["tags"]
    assert "maya" in journal.section_by_id(data, s["id"])["archived_tags"]


def test_readd_archived_tag_moves_it_back():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.remove_section_tag(data, s["id"], "maya")
    # Re-add the same tag.
    journal.add_section_tag(data, s["id"], "maya")
    s2 = journal.section_by_id(data, s["id"])
    assert "maya" in s2["tags"]
    assert "maya" not in s2["archived_tags"]


def test_readd_archived_tag_case_insensitive():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "Maya")   # stored as "maya"
    journal.remove_section_tag(data, s["id"], "MAYA")  # archived as "maya"
    journal.add_section_tag(data, s["id"], "maya")    # re-add unarchives
    s2 = journal.section_by_id(data, s["id"])
    assert "maya" in s2["tags"]
    assert "maya" not in s2["archived_tags"]


def test_archived_sections_helper():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    assert journal.archived_sections(data) == []
    journal.archive_section(data, s["id"])
    assert journal.archived_sections(data) == [s]
    assert journal.active_sections(data) == []


def test_restore_section():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.archive_section(data, s["id"])
    journal.restore_section(data, s["id"])
    assert journal.section_by_id(data, s["id"])["archived"] is False
    assert journal.active_sections(data) == [s]


def test_restore_section_name_collision_raises():
    data = journal._empty()
    s1 = journal.add_section(data, "people", "tag", "#fff")
    journal.archive_section(data, s1["id"])
    journal.add_section(data, "people", "tag", "#000")  # new active section with same name
    with pytest.raises(ValueError):
        journal.restore_section(data, s1["id"])


def test_restore_section_tag():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.remove_section_tag(data, s["id"], "maya")
    journal.restore_section_tag(data, s["id"], "maya")
    s2 = journal.section_by_id(data, s["id"])
    assert "maya" in s2["tags"]
    assert "maya" not in s2["archived_tags"]


def test_load_migrates_archived_tags_field(tmp_path):
    path = tmp_path / "journal.json"
    path.write_text(
        '{"sections": [{"id": "x", "name": "people", "type": "tag", "color": "#fff", "tags": ["maya"], "unit": null, "archived": false}], "entries": []}',
        encoding="utf-8",
    )
    data = journal.load(str(path))
    assert data["sections"][0].get("archived_tags") == []
