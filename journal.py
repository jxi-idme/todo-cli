"""Core journal logic.

Pure, testable functions over a plain data dict of the shape:

    {"sections": [...], "entries": [...]}

NO Flask imports -- this is the journal "brain". The only dependency is a
one-way import of todo.py's pure validation regexes, so hex/name validation
has a single source of truth.

Dates: entry `date` is a YYYY-MM-DD string; timestamps are ISO 8601. All naive
local time, matching todo.py.
"""

import json
import math
import os
import re
import statistics
import uuid
from collections import Counter
from datetime import datetime, timedelta

from todo import _HEX_COLOR_RE, _TAG_NAME_RE

# Default sections seeded on first run: six tag sections with distinct colors.
_DEFAULT_SECTIONS = [
    ("people", "#e0a955"),
    ("places", "#6fa8dc"),
    ("food", "#93c47d"),
    ("chores", "#c27ba0"),
    ("health", "#76a5af"),
    ("work", "#e06666"),
]

DEFAULT_SECTION_COLOR = "#8a8f99"
_MAX_UNIT_LEN = 12  # keep unit labels short for the section-card layout


def _empty():
    """A fresh, truly empty store (used by tests)."""
    return {"sections": [], "entries": []}


def _seeded():
    """A fresh store with the six default tag sections."""
    data = _empty()
    for name, color in _DEFAULT_SECTIONS:
        add_section(data, name, "tag", color)
    return data


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #

def load(path):
    """Read the journal store. Missing file -> a seeded store. Corrupt file ->
    backed up to <path>.bak and a seeded store returned. Missing per-section /
    per-entry fields are defaulted (forgiving, backward-compatible migration).
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
    except FileNotFoundError:
        return _seeded()
    except json.JSONDecodeError:
        _backup(path)
        return _seeded()

    if (
        isinstance(parsed, dict)
        and isinstance(parsed.get("sections"), list)
        and isinstance(parsed.get("entries"), list)
    ):
        for s in parsed["sections"]:
            s.setdefault("tags", [])
            s.setdefault("archived_tags", [])
            s.setdefault("unit", None)
            s.setdefault("archived", False)
        for e in parsed["entries"]:
            if not isinstance(e.get("tags"), dict):
                e["tags"] = {}
            if not isinstance(e.get("numbers"), dict):
                e["numbers"] = {}
            e.setdefault("mood", None)
        return parsed
    _backup(path)
    return _seeded()


def _backup(path):
    """Move a bad store aside to <path>.bak (best effort)."""
    try:
        os.replace(path, path + ".bak")
    except OSError:
        pass


def save(path, data):
    """Atomically write `data` as JSON to `path` (temp file + os.replace).
    Creates the containing directory on first run.
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# Task 2: Section lookup & display helpers
# --------------------------------------------------------------------------- #

def _normalize_name(name):
    """Strip + lowercase a single name (sections, tags)."""
    return (name or "").strip().lower()


def active_sections(data):
    """Non-archived sections, in stored order."""
    return [s for s in data.get("sections", []) if not s.get("archived")]


def section_by_id(data, section_id):
    """A section by id (archived ones included), or None."""
    for s in data.get("sections", []):
        if s.get("id") == section_id:
            return s
    return None


def section_color(data, section_id):
    """The section's hex color, or a neutral default if unknown."""
    s = section_by_id(data, section_id)
    return s["color"] if s else DEFAULT_SECTION_COLOR


def is_registered_tag(data, section_id, tag):
    """True if `tag` is in the section's permanent tag list (normalized)."""
    s = section_by_id(data, section_id)
    return bool(s) and _normalize_name(tag) in (s.get("tags") or [])


# --------------------------------------------------------------------------- #
# Task 3: Section CRUD with validation
# --------------------------------------------------------------------------- #

# Expects an already-normalized (stripped, lowercased) name.
def _valid_name(name):
    return bool(name) and bool(_TAG_NAME_RE.match(name))


def add_section(data, name, type_, color, unit=None):
    """Create a section. Validates name (allowlist), type, and hex color.
    Names must be unique among non-archived sections. Returns the new section.
    """
    name = _normalize_name(name)
    if not _valid_name(name):
        raise ValueError(f"Invalid section name: {name!r}")
    if type_ not in ("tag", "numeric"):
        raise ValueError(f"Invalid section type: {type_!r}")
    if not isinstance(color, str) or not _HEX_COLOR_RE.match(color):
        raise ValueError(f"Invalid hex color: {color!r}")
    for s in active_sections(data):
        if s["name"] == name:
            raise ValueError(f"Section already exists: {name!r}")
    section = {
        "id": uuid.uuid4().hex,
        "name": name,
        "type": type_,
        "color": color,
        "tags": [],
        "archived_tags": [],
        "unit": ((unit or "").strip()[:_MAX_UNIT_LEN] or None) if type_ == "numeric" else None,
        "archived": False,
    }
    data.setdefault("sections", []).append(section)
    return section


def rename_section(data, section_id, new_name):
    """Rename a section (unknown id = no-op). New name validated and unique
    among non-archived sections."""
    new_name = _normalize_name(new_name)
    if not _valid_name(new_name):
        raise ValueError(f"Invalid section name: {new_name!r}")
    for s in active_sections(data):
        if s["name"] == new_name and s["id"] != section_id:
            raise ValueError(f"Section already exists: {new_name!r}")
    target = section_by_id(data, section_id)
    if target is not None:
        target["name"] = new_name
    return data


def set_section_color(data, section_id, color):
    """Update a section's color (validated hex). Unknown id = no-op."""
    if not isinstance(color, str) or not _HEX_COLOR_RE.match(color):
        raise ValueError(f"Invalid hex color: {color!r}")
    s = section_by_id(data, section_id)
    if s is not None:
        s["color"] = color
    return data


def set_section_unit(data, section_id, unit):
    """Set a section's unit label (stripped, capped). Unknown id = no-op."""
    s = section_by_id(data, section_id)
    if s is not None:
        s["unit"] = (unit or "").strip()[:_MAX_UNIT_LEN] or None
    return data


def archive_section(data, section_id):
    """Soft-delete a section (kept for history/analytics). Unknown id = no-op."""
    s = section_by_id(data, section_id)
    if s is not None:
        s["archived"] = True
    return data


# --------------------------------------------------------------------------- #
# Task 4: Permanent tags on sections
# --------------------------------------------------------------------------- #

def add_section_tag(data, section_id, tag):
    """Add a permanent tag to a tag-section (normalized, validated, unique).
    If the tag was previously archived, it is unarchived instead of duplicated.
    Raises on a bad name or a numeric section. Unknown id = no-op."""
    tag = _normalize_name(tag)
    if not _valid_name(tag):
        raise ValueError(f"Invalid tag name: {tag!r}")
    s = section_by_id(data, section_id)
    if s is None:
        return data
    if s.get("type") != "tag":
        raise ValueError("Cannot add tags to a numeric section")
    archived = s.setdefault("archived_tags", [])
    if tag in archived:
        archived.remove(tag)
    if tag not in s.setdefault("tags", []):
        s["tags"].append(tag)
    return data


def remove_section_tag(data, section_id, tag):
    """Move a permanent tag to the archived list (entries keep it).
    Unknown id/tag = safe no-op."""
    tag = _normalize_name(tag)
    s = section_by_id(data, section_id)
    if s is not None and isinstance(s.get("tags"), list):
        if tag in s["tags"]:
            s["tags"].remove(tag)
            archived = s.setdefault("archived_tags", [])
            if tag not in archived:
                archived.append(tag)
    return data


def archived_sections(data):
    """Sections that have been archived (soft-deleted), in stored order."""
    return [s for s in data.get("sections", []) if s.get("archived")]


def restore_section(data, section_id):
    """Un-archive a section. Raises ValueError if an active section already
    has the same name. Unknown id = no-op."""
    s = section_by_id(data, section_id)
    if s is None:
        return data
    for active in active_sections(data):
        if active["name"] == s["name"] and active["id"] != section_id:
            raise ValueError(f"An active section named {s['name']!r} already exists")
    s["archived"] = False
    return data


def restore_section_tag(data, section_id, tag):
    """Move a tag from archived_tags back to tags. Unknown id/tag = no-op."""
    tag = _normalize_name(tag)
    s = section_by_id(data, section_id)
    if s is None:
        return data
    archived = s.setdefault("archived_tags", [])
    if tag in archived:
        archived.remove(tag)
        if tag not in s.setdefault("tags", []):
            s["tags"].append(tag)
    return data


# --------------------------------------------------------------------------- #
# Task 5: Entry lookup & date helpers
# --------------------------------------------------------------------------- #

def today_iso(now=None):
    """Today's date as a YYYY-MM-DD string."""
    now = now or datetime.now()
    return now.date().isoformat()


def _valid_date(date_str):
    """True if `date_str` is a YYYY-MM-DD calendar date."""
    if not isinstance(date_str, str):
        return False
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def _valid_mood(value):
    """True if `value` is an int (or int-coercible) in the 1..7 range.

    Rejects floats with a fractional part, bools, and non-numeric strings —
    the mood is a discrete 1..7 scale, so only whole-number values are valid.
    """
    if isinstance(value, bool):
        return False
    try:
        n = int(value)
    except (TypeError, ValueError):
        return False
    # An int-coercible value must equal its int form (e.g. reject 3.5).
    if isinstance(value, float) and not value.is_integer():
        return False
    return 1 <= n <= 7


def get_entry_by_date(data, date):
    """The entry for `date`, or None (date is the unique key)."""
    for e in data.get("entries", []):
        if e.get("date") == date:
            return e
    return None


def entries_sorted(data):
    """Entries newest date first."""
    return sorted(data.get("entries", []), key=lambda e: e.get("date", ""), reverse=True)


# --------------------------------------------------------------------------- #
# Task 6: Entry upsert & delete
# --------------------------------------------------------------------------- #

def upsert_entry(data, date, title, body, tags=None, numbers=None, mood=None, now=None):
    """Create or update the entry for `date` (the unique key).

    `tags` is {section_id: [tag names]} and `numbers` is {section_id: value};
    both are keyed by stable section id. Tag names are normalized/validated and
    deduped; number values are cast to float. Section ids that don't resolve to
    any active section are dropped; ids for archived sections are accepted so
    historical data is preserved. Raises ValueError on an invalid date, empty
    title, or a non-numeric/non-finite number. `created` is set once; `updated`
    on every save.
    """
    if not _valid_date(date):
        raise ValueError(f"Invalid date: {date!r}")
    title = (title or "").strip()
    if not title:
        raise ValueError("Entry title must not be empty")
    body = body or ""
    now = now or datetime.now()

    clean_tags = {}
    for section_id, names in (tags or {}).items():
        if section_by_id(data, section_id) is None:
            continue
        norm = []
        for raw in names or []:
            n = _normalize_name(raw) if isinstance(raw, str) else ""
            if n and _valid_name(n) and n not in norm:
                norm.append(n)
        if norm:
            clean_tags[section_id] = norm

    clean_numbers = {}
    for section_id, value in (numbers or {}).items():
        if section_by_id(data, section_id) is None:
            continue
        try:
            v = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid number for section {section_id!r}: {value!r}")
        if not math.isfinite(v):
            raise ValueError(f"Invalid number for section {section_id!r}: {value!r}")
        clean_numbers[section_id] = v

    # Mood is an optional 1..7 scale, independent of the section structures.
    # None/empty -> null; an int-coercible 1..7 -> int; anything else -> raise.
    if mood is None or mood == "":
        clean_mood = None
    elif _valid_mood(mood):
        clean_mood = int(mood)
    else:
        raise ValueError(f"Invalid mood: {mood!r}")

    existing = get_entry_by_date(data, date)
    if existing is not None:
        existing["title"] = title
        existing["body"] = body
        existing["tags"] = clean_tags
        existing["numbers"] = clean_numbers
        existing["mood"] = clean_mood
        existing["updated"] = now.isoformat()
        return existing

    entry = {
        "id": uuid.uuid4().hex,
        "date": date,
        "title": title,
        "body": body,
        "created": now.isoformat(),
        "updated": now.isoformat(),
        "tags": clean_tags,
        "numbers": clean_numbers,
        "mood": clean_mood,
    }
    data.setdefault("entries", []).append(entry)
    return entry


def delete_entry(data, entry_id):
    """Remove an entry by id. Unknown id = no-op."""
    data["entries"] = [e for e in data.get("entries", []) if e.get("id") != entry_id]
    return data


# --------------------------------------------------------------------------- #
# Rich entries: @mention tag lookup, extraction, and merge (all pure)
# --------------------------------------------------------------------------- #

# A mention token: '@' at a word boundary (start of string or a non-word char
# before it) followed by one or more name chars. The leading boundary group is
# captured so `a@b.com` does NOT match (the char before '@' is a word char).
_MENTION_RE = re.compile(r"(?:^|(?<=\W))@([A-Za-z0-9_-]+)")


def tag_section_index(data):
    """Build the @mention lookup: {normalized_name: section_id}.

    Construction + precedence:
      1. Seed with permanent (`section.tags`) + archived (`section.archived_tags`)
         tags from every section. A registered name's section always wins, so
         these authoritative "homes" are never overridden by temporary use.
      2. Overlay temporary tags harvested from entries -- any name NOT already
         registered is mapped to the section it was used under. Entries are
         iterated in ASCENDING date order so that, for a purely-temporary name
         used under more than one section, the most-recent entry's section wins.

    Names are normalized (strip + lowercase).
    """
    index = {}
    registered = set()
    for s in data.get("sections", []):
        sid = s.get("id")
        for name in (s.get("tags") or []) + (s.get("archived_tags") or []):
            n = _normalize_name(name)
            if n:
                index[n] = sid
                registered.add(n)

    entries = sorted(data.get("entries", []), key=lambda e: e.get("date", ""))
    for e in entries:
        for sid, names in (e.get("tags") or {}).items():
            for name in names or []:
                n = _normalize_name(name)
                if n and n not in registered:
                    index[n] = sid  # later (more recent) entries overwrite
    return index


def _resolve_mention(token, index):
    """Resolve a mention token to a known tag name in `index`, or None.

    Tries the token as-is (normalized), then with underscores treated as
    spaces — so `@alex_dad` matches a multi-word tag `alex dad`. A literal
    underscore tag wins over the spaced form when both exist.
    """
    direct = _normalize_name(token)
    if direct in index:
        return direct
    spaced = _normalize_name(token.replace("_", " "))
    if spaced in index:
        return spaced
    return None


def extract_mentions(body, index):
    """Find @mentions in `body` that match a known tag.

    Returns {section_id: [names]}. A mention is an '@' at a word boundary
    followed by [A-Za-z0-9_-]+ (so `a@b.com` does not match). Each token is
    resolved to a known tag name (underscores match spaces, so `@alex_dad`
    matches `alex dad`); unknown tokens are dropped. Resolved names are grouped
    by section id and deduped within a section, preserving first-seen order.
    """
    out = {}
    for raw in _MENTION_RE.findall(body or ""):
        n = _resolve_mention(raw, index)
        if n is None:
            continue
        sid = index[n]
        names = out.setdefault(sid, [])
        if n not in names:
            names.append(n)
    return out


def merge_entry_tags(base, mentions):
    """Union two {section_id: [names]} dicts, non-destructively.

    For each section id, concatenate names and dedupe preserving order. Never
    removes anything; does not mutate the inputs.
    """
    out = {sid: list(names) for sid, names in (base or {}).items()}
    for sid, names in (mentions or {}).items():
        merged = out.setdefault(sid, [])
        for n in names or []:
            if n not in merged:
                merged.append(n)
    return out


# --------------------------------------------------------------------------- #
# Calendar helpers
# --------------------------------------------------------------------------- #

def entry_dates(data):
    """Sorted list of YYYY-MM-DD strings that have an entry (for calendar dots)."""
    return sorted(e["date"] for e in data.get("entries", []) if e.get("date"))


# --------------------------------------------------------------------------- #
# Task 9: Search index helpers
# --------------------------------------------------------------------------- #

def search_index(data):
    """Per-entry payload for the client-side search tab (newest date first).

    Each item: id, date, title, body, `tags` (flat sorted unique list of every
    tag string on the entry, across all sections — used by the JS filter),
    `tag_chips` (sorted unique [{name, color}] pairs carrying each tag's own
    section color, for color-coded rendering), and `numbers`
    ({section_id: value}). Designed to be JSON-serialized into the page.
    """
    out = []
    for e in entries_sorted(data):
        tags = set()
        chips = []          # [{name, color}], deduped by name (first wins)
        seen = set()
        for sid, names in (e.get("tags") or {}).items():
            color = section_color(data, sid)
            for n in names or []:
                tags.add(n)
                if n not in seen:
                    seen.add(n)
                    chips.append({"name": n, "color": color})
        chips.sort(key=lambda c: c["name"])
        out.append({
            "id": e["id"],
            "date": e["date"],
            "title": e.get("title", ""),
            "body": e.get("body", ""),
            "tags": sorted(tags),
            "tag_chips": chips,
            "numbers": dict(e.get("numbers") or {}),
        })
    return out


def numeric_bounds(data):
    """{section_id: [min, max]} over recorded values, for every numeric section
    that has at least one value among entries. Used to size the range sliders;
    sections with no recorded values are omitted."""
    bounds = {}
    for s in data.get("sections", []):
        if s.get("type") != "numeric":
            continue
        vals = [e["numbers"][s["id"]] for e in data.get("entries", [])
                if isinstance(e.get("numbers"), dict) and s["id"] in e["numbers"]]
        if vals:
            bounds[s["id"]] = [min(vals), max(vals)]
    return bounds


def move_entry(data, entry_id, new_date):
    """Move an entry to `new_date`.

    Raises ValueError if `new_date` is not a valid YYYY-MM-DD, or if another
    entry already occupies `new_date`. If `new_date` equals the entry's current
    date, returns data unchanged (no-op). Unknown `entry_id` is also a no-op.
    """
    if not _valid_date(new_date):
        raise ValueError(f"Invalid date: {new_date!r}")
    entry = next((e for e in data.get("entries", []) if e.get("id") == entry_id), None)
    if entry is None:
        return data
    if entry["date"] == new_date:
        return data
    conflict = get_entry_by_date(data, new_date)
    if conflict is not None:
        raise ValueError(f"An entry already exists for {new_date!r}")
    entry["date"] = new_date
    return data


# --------------------------------------------------------------------------- #
# Analytics: pure aggregation helpers (consumed by /journal/analytics/data)
# --------------------------------------------------------------------------- #

def _filter_entries_by_date(entries, start, end):
    """Entries whose `date` falls in [start, end] inclusive. A None bound is
    unbounded. YYYY-MM-DD strings compare lexically == chronologically."""
    return [
        e for e in entries
        if (start is None or e.get("date", "") >= start)
        and (end is None or e.get("date", "") <= end)
    ]


def describe(values):
    """Summary statistics over a list of numbers (None/NaN-free callers).

    Returns mean/median/mode/stdev/min/max/count. `mode` is None when no value
    repeats (all unique); `stdev` is None for fewer than 2 values; an empty
    input yields all-None with count 0. Sample stdev (n-1), matching JS.
    """
    vals = [float(v) for v in values if v is not None]
    n = len(vals)
    if n == 0:
        return {"mean": None, "median": None, "mode": None,
                "stdev": None, "min": None, "max": None, "count": 0}
    counts = Counter(vals)
    top = max(counts.values())
    mode = None if top == 1 else min(v for v, c in counts.items() if c == top)
    return {
        "mean": statistics.mean(vals),
        "median": statistics.median(vals),
        "mode": mode,
        "stdev": statistics.stdev(vals) if n >= 2 else None,
        "min": min(vals),
        "max": max(vals),
        "count": n,
    }


def _tags_for(entry, section_id):
    """The tag-name list this entry recorded for `section_id` (possibly empty)."""
    return (entry.get("tags") or {}).get(section_id, []) or []


def tag_frequency(entries, section_id, start, end):
    """{tag: count} across date-filtered entries for one section."""
    out = {}
    for e in _filter_entries_by_date(entries, start, end):
        for tag in _tags_for(e, section_id):
            out[tag] = out.get(tag, 0) + 1
    return out


def tag_cooccurrence(entries, section_id, start, end):
    """{tag: {other_tag: count}} of tags appearing together on the same entry,
    within one section. Symmetric; self-pairs excluded."""
    out = {}
    for e in _filter_entries_by_date(entries, start, end):
        tags = sorted(set(_tags_for(e, section_id)))
        for a in tags:
            for b in tags:
                if a == b:
                    continue
                out.setdefault(a, {})
                out[a][b] = out[a].get(b, 0) + 1
    return out


def tag_trend(entries, section_id, tag, start, end):
    """[{week, count}] of a single tag's frequency per ISO week, sorted."""
    weeks = {}
    for e in _filter_entries_by_date(entries, start, end):
        if tag in _tags_for(e, section_id):
            d = datetime.strptime(e["date"], "%Y-%m-%d").date()
            iso = d.isocalendar()
            key = f"{iso[0]}-W{iso[1]:02d}"
            weeks[key] = weeks.get(key, 0) + 1
    return [{"week": k, "count": weeks[k]} for k in sorted(weeks)]


def tag_streak(entries, section_id, tag):
    """{current, longest, avg} over consecutive-day runs where `tag` appears.
    `current` is the run ending at the latest tagged day; `avg` is the mean run
    length. All zero when the tag never appears."""
    dates = sorted({
        e["date"] for e in entries
        if e.get("date") and tag in _tags_for(e, section_id)
    })
    if not dates:
        return {"current": 0, "longest": 0, "avg": 0}
    parsed = [datetime.strptime(d, "%Y-%m-%d").date() for d in dates]
    runs = []
    run = 1
    for i in range(1, len(parsed)):
        if parsed[i] - parsed[i - 1] == timedelta(days=1):
            run += 1
        else:
            runs.append(run)
            run = 1
    runs.append(run)
    return {"current": runs[-1], "longest": max(runs), "avg": sum(runs) / len(runs)}


_DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def numeric_series(entries, section_id, start, end):
    """[{date, value}] of one numeric section's recorded values, sorted by date."""
    out = [
        {"date": e["date"], "value": (e.get("numbers") or {})[section_id]}
        for e in _filter_entries_by_date(entries, start, end)
        if section_id in (e.get("numbers") or {})
    ]
    out.sort(key=lambda d: d["date"])
    return out


def dow_averages(entries, section_id, start, end):
    """{weekday_name: mean value | None} for one numeric section, Mon..Sun."""
    buckets = {i: [] for i in range(7)}
    for e in _filter_entries_by_date(entries, start, end):
        nums = e.get("numbers") or {}
        if section_id in nums:
            d = datetime.strptime(e["date"], "%Y-%m-%d").date()
            buckets[d.weekday()].append(nums[section_id])
    return {
        _DOW_NAMES[i]: (sum(v) / len(v) if v else None)
        for i, v in buckets.items()
    }


def word_counts(entries, start, end):
    """[{date, count}] of body word counts (whitespace split), sorted by date."""
    out = [
        {"date": e["date"], "count": len((e.get("body") or "").split())}
        for e in _filter_entries_by_date(entries, start, end)
    ]
    out.sort(key=lambda d: d["date"])
    return out


def entry_gaps(entries, start, end):
    """[{gap_days, after_date}] day-gaps between consecutive entry dates."""
    dates = sorted({
        e["date"] for e in _filter_entries_by_date(entries, start, end)
        if e.get("date")
    })
    parsed = [datetime.strptime(d, "%Y-%m-%d").date() for d in dates]
    return [
        {"gap_days": (parsed[i] - parsed[i - 1]).days, "after_date": dates[i]}
        for i in range(1, len(parsed))
    ]


def creation_hours(entries, start, end):
    """{0..23: count} histogram of entry `created` timestamps' hour."""
    out = {h: 0 for h in range(24)}
    for e in _filter_entries_by_date(entries, start, end):
        created = e.get("created")
        if not created:
            continue
        try:
            out[datetime.fromisoformat(created).hour] += 1
        except ValueError:
            continue
    return out


def date_density(entries, start, end):
    """{date: 1} for every day that has an entry (calendar heatmap presence)."""
    return {
        e["date"]: 1
        for e in _filter_entries_by_date(entries, start, end)
        if e.get("date")
    }


def entry_streak(entries):
    """{current, longest, last_date} over consecutive calendar days with an
    entry. `current` is the run ending at the most recent entry date."""
    dates = sorted({e["date"] for e in entries if e.get("date")})
    if not dates:
        return {"current": 0, "longest": 0, "last_date": None}
    parsed = [datetime.strptime(d, "%Y-%m-%d").date() for d in dates]
    longest = run = 1
    for i in range(1, len(parsed)):
        run = run + 1 if parsed[i] - parsed[i - 1] == timedelta(days=1) else 1
        longest = max(longest, run)
    current = 1
    for i in range(len(parsed) - 1, 0, -1):
        if parsed[i] - parsed[i - 1] == timedelta(days=1):
            current += 1
        else:
            break
    return {"current": current, "longest": longest, "last_date": dates[-1]}


def section_coverage(entries, active_section_ids, start, end):
    """[{date, covered:[section_id]}] per entry (date-sorted). A section counts
    as covered when the entry has a non-empty tag list or a number for it."""
    ids = list(active_section_ids)
    out = []
    for e in sorted(_filter_entries_by_date(entries, start, end),
                    key=lambda x: x.get("date", "")):
        tags = e.get("tags") or {}
        nums = e.get("numbers") or {}
        covered = [sid for sid in ids if tags.get(sid) or sid in nums]
        out.append({"date": e["date"], "covered": covered})
    return out


def analytics_payload(data):
    """The full JSON payload for the analytics page.

    `sections` lists active sections only (archived ones are dropped, but their
    historical values stay in `entries` keyed by section id — the JS simply
    never references an unknown id). `date_range` spans all entry dates.
    """
    sections = [
        {
            "id": s["id"],
            "name": s["name"],
            "type": s["type"],
            "color": s["color"],
            "tags": list(s.get("tags") or []),
            "unit": s.get("unit"),
        }
        for s in active_sections(data)
    ]
    entries = [
        {
            "date": e["date"],
            "tags": dict(e.get("tags") or {}),
            "numbers": dict(e.get("numbers") or {}),
            "body": e.get("body", ""),
            "created": e.get("created"),
        }
        for e in data.get("entries", [])
    ]
    dates = sorted(e["date"] for e in entries if e.get("date"))
    date_range = ({"min": dates[0], "max": dates[-1]}
                  if dates else {"min": None, "max": None})
    return {"sections": sections, "entries": entries, "date_range": date_range}
