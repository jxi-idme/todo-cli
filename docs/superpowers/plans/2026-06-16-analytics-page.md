# Analytics Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/journal/analytics` page that visualizes journal data (tag frequency, streaks, numeric trends, co-occurrence, consistency) as client-rendered vanilla SVG charts driven by a JSON API endpoint.

**Architecture:** Pure aggregation helpers in `journal.py` (no Flask, fully unit-tested) feed a thin JSON route `GET /journal/analytics/data`. A single `static/analytics.js` fetches that data, filters by date in-memory, and renders charts via a registry pattern (add a chart = append one descriptor). All colors are read from CSS custom properties at render time so charts match the existing dark amber/monospace theme and adapt to any section/tag added later.

**Tech Stack:** Python 3.12+, Flask 3.1, vanilla JS (no ES modules, no build step), inline SVG, pytest. Python stdlib `statistics`/`collections`/`datetime` only.

## Global Constraints

- Python 3.12+; **no new dependencies** (stdlib only — `statistics`, `collections`, `datetime`).
- **No new CSS variables** — charts read existing `:root` vars (`--bg`, `--panel`, `--text`, `--muted`, `--border`, `--accent`, `--danger`) via `getComputedStyle`.
- **Pure-logic/HTTP split**: every function in `journal.py` has zero Flask imports and takes/returns plain dicts/lists.
- **Nothing hardcoded by section/tag name or count** — all charts derive sections, tags, and colors from the API response.
- All date filtering is **inclusive** on both ends; `start`/`end` are `YYYY-MM-DD` strings or `None` for unbounded. `YYYY-MM-DD` strings compare lexically == chronologically.
- Tests use `journal._empty()` / hand-built fixtures with fixed dates (TDD: test first).
- `todo.py`, `journal.js`, `journal-search.js` are **untouched**.
- Commit after every task.

---

### Task 1: Pure utilities — `_filter_entries_by_date` and `describe`

**Files:**
- Modify: `journal.py` (add imports + two functions at the end, in a new "Analytics" section)
- Test: `tests/test_journal_analytics.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `_filter_entries_by_date(entries, start, end) -> list[dict]` — entries whose `date` is within `[start, end]` inclusive; `None` bound = unbounded.
  - `describe(values) -> dict` with keys `mean, median, mode, stdev, min, max, count`. `mode` is `None` when no value repeats; `stdev` is `None` for fewer than 2 values; all-empty input returns all-`None` values with `count: 0`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_journal_analytics.py`:

```python
"""Tests for the pure analytics aggregation helpers in journal.py.

Fixed dates for determinism; no file I/O needed (helpers take plain lists).
Entry fixtures mirror the real entry shape: date, tags {sid: [names]},
numbers {sid: float}, body, created.
"""

import journal


def _entry(date, tags=None, numbers=None, body="", created=None):
    return {
        "id": date,  # id is irrelevant to aggregation; reuse the date
        "date": date,
        "title": "t",
        "body": body,
        "created": created or (date + "T09:00:00"),
        "tags": tags or {},
        "numbers": numbers or {},
    }


# --------------------------------------------------------------------------- #
# _filter_entries_by_date + describe
# --------------------------------------------------------------------------- #

def test_filter_by_date_inclusive_bounds():
    entries = [_entry("2026-06-01"), _entry("2026-06-05"), _entry("2026-06-10")]
    got = journal._filter_entries_by_date(entries, "2026-06-05", "2026-06-10")
    assert [e["date"] for e in got] == ["2026-06-05", "2026-06-10"]


def test_filter_by_date_none_bounds_means_unbounded():
    entries = [_entry("2026-06-01"), _entry("2026-06-10")]
    assert journal._filter_entries_by_date(entries, None, None) == entries


def test_describe_basic_stats():
    d = journal.describe([1, 2, 2, 3, 4])
    assert d["mean"] == 2.4
    assert d["median"] == 2
    assert d["mode"] == 2
    assert d["min"] == 1 and d["max"] == 4 and d["count"] == 5
    assert round(d["stdev"], 4) == 1.1402


def test_describe_mode_none_when_all_unique():
    assert journal.describe([1, 2, 3])["mode"] is None


def test_describe_stdev_none_for_single_value():
    d = journal.describe([7])
    assert d["stdev"] is None and d["mean"] == 7 and d["count"] == 1


def test_describe_empty_is_all_none():
    d = journal.describe([])
    assert d == {"mean": None, "median": None, "mode": None,
                 "stdev": None, "min": None, "max": None, "count": 0}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_journal_analytics.py -v`
Expected: FAIL — `AttributeError: module 'journal' has no attribute '_filter_entries_by_date'`

- [ ] **Step 3: Add imports and implement the helpers**

In `journal.py`, the import block currently reads:

```python
import json
import math
import os
import uuid
from datetime import datetime
```

Replace it with:

```python
import json
import math
import os
import statistics
import uuid
from collections import Counter
from datetime import datetime, timedelta
```

Then append to the **end** of `journal.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_journal_analytics.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal_analytics.py
git commit -m "feat(analytics): add _filter_entries_by_date and describe helpers"
```

---

### Task 2: Tag aggregation helpers

**Files:**
- Modify: `journal.py` (append four functions)
- Test: `tests/test_journal_analytics.py` (append tests)

**Interfaces:**
- Consumes: `_filter_entries_by_date` (Task 1).
- Produces:
  - `tag_frequency(entries, section_id, start, end) -> {tag: count}`
  - `tag_cooccurrence(entries, section_id, start, end) -> {tag: {other_tag: count}}` (symmetric; no self-pairs)
  - `tag_trend(entries, section_id, tag, start, end) -> [{"week": "YYYY-Www", "count": N}]` sorted by week
  - `tag_streak(entries, section_id, tag) -> {"current": N, "longest": N, "avg": N}` over consecutive-day runs where the tag appears (`avg` is mean run length; 0/0/0 when the tag never appears)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_journal_analytics.py`:

```python
# --------------------------------------------------------------------------- #
# Tag aggregations
# --------------------------------------------------------------------------- #

SID = "sec-people"


def test_tag_frequency_counts_per_tag():
    entries = [
        _entry("2026-06-01", tags={SID: ["alex", "sam"]}),
        _entry("2026-06-02", tags={SID: ["alex"]}),
        _entry("2026-06-03", tags={"other": ["alex"]}),  # different section ignored
    ]
    assert journal.tag_frequency(entries, SID, None, None) == {"alex": 2, "sam": 1}


def test_tag_frequency_respects_date_range():
    entries = [
        _entry("2026-06-01", tags={SID: ["alex"]}),
        _entry("2026-06-09", tags={SID: ["alex"]}),
    ]
    assert journal.tag_frequency(entries, SID, "2026-06-05", None) == {"alex": 1}


def test_tag_cooccurrence_pairs_within_entry():
    entries = [
        _entry("2026-06-01", tags={SID: ["alex", "sam"]}),
        _entry("2026-06-02", tags={SID: ["alex", "sam"]}),
        _entry("2026-06-03", tags={SID: ["alex"]}),  # lone tag, no pair
    ]
    co = journal.tag_cooccurrence(entries, SID, None, None)
    assert co["alex"]["sam"] == 2
    assert co["sam"]["alex"] == 2
    assert "alex" not in co.get("alex", {})  # no self-pair


def test_tag_trend_buckets_by_iso_week():
    entries = [
        _entry("2026-06-01", tags={SID: ["alex"]}),  # ISO week 23
        _entry("2026-06-02", tags={SID: ["alex"]}),  # week 23
        _entry("2026-06-08", tags={SID: ["alex"]}),  # week 24
    ]
    trend = journal.tag_trend(entries, SID, "alex", None, None)
    assert trend == [
        {"week": "2026-W23", "count": 2},
        {"week": "2026-W24", "count": 1},
    ]


def test_tag_streak_runs_and_average():
    entries = [
        _entry("2026-06-01", tags={SID: ["walk"]}),
        _entry("2026-06-02", tags={SID: ["walk"]}),  # run of 2
        _entry("2026-06-05", tags={SID: ["walk"]}),  # gap -> new run
        _entry("2026-06-06", tags={SID: ["walk"]}),
        _entry("2026-06-07", tags={SID: ["walk"]}),  # run of 3 (latest)
    ]
    s = journal.tag_streak(entries, SID, "walk")
    assert s == {"current": 3, "longest": 3, "avg": 2.5}


def test_tag_streak_absent_tag_is_zeroes():
    assert journal.tag_streak([], SID, "walk") == {"current": 0, "longest": 0, "avg": 0}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_journal_analytics.py -k "tag_" -v`
Expected: FAIL — `AttributeError: module 'journal' has no attribute 'tag_frequency'`

- [ ] **Step 3: Implement the helpers**

Append to `journal.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_journal_analytics.py -k "tag_" -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal_analytics.py
git commit -m "feat(analytics): add tag frequency, co-occurrence, trend, streak helpers"
```

---

### Task 3: Temporal & numeric aggregation helpers

**Files:**
- Modify: `journal.py` (append six functions)
- Test: `tests/test_journal_analytics.py` (append tests)

**Interfaces:**
- Consumes: `_filter_entries_by_date` (Task 1).
- Produces:
  - `numeric_series(entries, section_id, start, end) -> [{"date", "value"}]` sorted ascending
  - `dow_averages(entries, section_id, start, end) -> {"Mon": avg|None, ... "Sun": ...}`
  - `word_counts(entries, start, end) -> [{"date", "count"}]` sorted ascending (count = whitespace-split words in body)
  - `entry_gaps(entries, start, end) -> [{"gap_days", "after_date"}]` between consecutive entry dates
  - `creation_hours(entries, start, end) -> {0..23: count}` from each entry's `created` hour
  - `date_density(entries, start, end) -> {"YYYY-MM-DD": 1}` (presence per day)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_journal_analytics.py`:

```python
# --------------------------------------------------------------------------- #
# Temporal & numeric aggregations
# --------------------------------------------------------------------------- #

NUM = "sec-sleep"


def test_numeric_series_sorted_and_filtered():
    entries = [
        _entry("2026-06-03", numbers={NUM: 7.0}),
        _entry("2026-06-01", numbers={NUM: 6.5}),
        _entry("2026-06-02", numbers={}),  # no value -> skipped
    ]
    assert journal.numeric_series(entries, NUM, None, None) == [
        {"date": "2026-06-01", "value": 6.5},
        {"date": "2026-06-03", "value": 7.0},
    ]


def test_dow_averages_by_weekday():
    # 2026-06-01 is a Monday.
    entries = [
        _entry("2026-06-01", numbers={NUM: 6.0}),  # Mon
        _entry("2026-06-08", numbers={NUM: 8.0}),  # Mon
        _entry("2026-06-02", numbers={NUM: 5.0}),  # Tue
    ]
    dow = journal.dow_averages(entries, NUM, None, None)
    assert dow["Mon"] == 7.0
    assert dow["Tue"] == 5.0
    assert dow["Wed"] is None


def test_word_counts_counts_body_words():
    entries = [
        _entry("2026-06-02", body="three little words"),
        _entry("2026-06-01", body=""),
    ]
    assert journal.word_counts(entries, None, None) == [
        {"date": "2026-06-01", "count": 0},
        {"date": "2026-06-02", "count": 3},
    ]


def test_entry_gaps_between_consecutive_dates():
    entries = [_entry("2026-06-01"), _entry("2026-06-02"), _entry("2026-06-06")]
    assert journal.entry_gaps(entries, None, None) == [
        {"gap_days": 1, "after_date": "2026-06-02"},
        {"gap_days": 4, "after_date": "2026-06-06"},
    ]


def test_creation_hours_histogram():
    entries = [
        _entry("2026-06-01", created="2026-06-01T09:30:00"),
        _entry("2026-06-02", created="2026-06-02T09:05:00"),
        _entry("2026-06-03", created="2026-06-03T22:00:00"),
    ]
    hours = journal.creation_hours(entries, None, None)
    assert hours[9] == 2
    assert hours[22] == 1
    assert hours[0] == 0
    assert len(hours) == 24


def test_date_density_presence_per_day():
    entries = [_entry("2026-06-01"), _entry("2026-06-03")]
    assert journal.date_density(entries, None, None) == {"2026-06-01": 1, "2026-06-03": 1}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_journal_analytics.py -k "numeric_series or dow or word_counts or entry_gaps or creation_hours or date_density" -v`
Expected: FAIL — `AttributeError: module 'journal' has no attribute 'numeric_series'`

- [ ] **Step 3: Implement the helpers**

Append to `journal.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_journal_analytics.py -k "numeric_series or dow or word_counts or entry_gaps or creation_hours or date_density" -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal_analytics.py
git commit -m "feat(analytics): add numeric, day-of-week, word-count, gap, hour, density helpers"
```

---

### Task 4: Entry-level aggregation helpers

**Files:**
- Modify: `journal.py` (append two functions)
- Test: `tests/test_journal_analytics.py` (append tests)

**Interfaces:**
- Consumes: `_filter_entries_by_date` (Task 1).
- Produces:
  - `entry_streak(entries) -> {"current": N, "longest": N, "last_date": str|None}` over all entries (no date filter); `current` is the run ending at the most recent entry date
  - `section_coverage(entries, active_section_ids, start, end) -> [{"date", "covered": [section_id]}]` sorted by date; a section is "covered" when the entry has a non-empty tag list or a recorded number for it

- [ ] **Step 1: Write the failing test**

Append to `tests/test_journal_analytics.py`:

```python
# --------------------------------------------------------------------------- #
# Entry-level aggregations
# --------------------------------------------------------------------------- #

def test_entry_streak_current_longest_last():
    entries = [
        _entry("2026-06-01"), _entry("2026-06-02"), _entry("2026-06-03"),  # run 3
        _entry("2026-06-10"), _entry("2026-06-11"),  # run 2 (latest)
    ]
    assert journal.entry_streak(entries) == {
        "current": 2, "longest": 3, "last_date": "2026-06-11"}


def test_entry_streak_empty():
    assert journal.entry_streak([]) == {"current": 0, "longest": 0, "last_date": None}


def test_section_coverage_marks_filled_sections():
    entries = [
        _entry("2026-06-01", tags={"a": ["x"]}, numbers={"b": 1.0}),
        _entry("2026-06-02", tags={"a": []}),  # empty tag list -> not covered
    ]
    cov = journal.section_coverage(entries, ["a", "b"], None, None)
    assert cov == [
        {"date": "2026-06-01", "covered": ["a", "b"]},
        {"date": "2026-06-02", "covered": []},
    ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_journal_analytics.py -k "entry_streak or section_coverage" -v`
Expected: FAIL — `AttributeError: module 'journal' has no attribute 'entry_streak'`

- [ ] **Step 3: Implement the helpers**

Append to `journal.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_journal_analytics.py -k "entry_streak or section_coverage" -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal_analytics.py
git commit -m "feat(analytics): add entry_streak and section_coverage helpers"
```

---

### Task 5: `analytics_payload` assembler

**Files:**
- Modify: `journal.py` (append one function)
- Test: `tests/test_journal_analytics.py` (append tests)

**Interfaces:**
- Consumes: `active_sections` (existing in `journal.py`).
- Produces: `analytics_payload(data) -> {"sections": [...], "entries": [...], "date_range": {"min", "max"}}`. `sections` includes only active sections, each as `{id, name, type, color, tags, unit}`. `entries` include `{date, tags, numbers, body, created}` for **all** entries (archived-section ids included; JS ignores unreferenced ids). `date_range` spans all entry dates, `{None, None}` if empty.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_journal_analytics.py`:

```python
# --------------------------------------------------------------------------- #
# analytics_payload
# --------------------------------------------------------------------------- #

def test_analytics_payload_shape():
    data = journal._empty()
    sec = journal.add_section(data, "people", "tag", "#e0a955")
    journal.add_section_tag(data, sec["id"], "alex")
    journal.upsert_entry(
        data, "2026-06-10", "title", "two words",
        tags={sec["id"]: ["alex"]}, numbers={},
        now=datetime(2026, 6, 10, 9, 0, 0),
    )
    payload = journal.analytics_payload(data)

    assert set(payload) == {"sections", "entries", "date_range"}
    s = payload["sections"][0]
    assert set(s) == {"id", "name", "type", "color", "tags", "unit"}
    assert s["name"] == "people" and s["tags"] == ["alex"]
    e = payload["entries"][0]
    assert set(e) == {"date", "tags", "numbers", "body", "created"}
    assert e["date"] == "2026-06-10"
    assert payload["date_range"] == {"min": "2026-06-10", "max": "2026-06-10"}


def test_analytics_payload_excludes_archived_sections():
    data = journal._empty()
    keep = journal.add_section(data, "people", "tag", "#e0a955")
    gone = journal.add_section(data, "work", "tag", "#e06666")
    journal.archive_section(data, gone["id"])
    payload = journal.analytics_payload(data)
    names = [s["name"] for s in payload["sections"]]
    assert names == ["people"]
    assert keep["id"] in {s["id"] for s in payload["sections"]}


def test_analytics_payload_empty_date_range():
    payload = journal.analytics_payload(journal._empty())
    assert payload["entries"] == []
    assert payload["date_range"] == {"min": None, "max": None}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_journal_analytics.py -k "analytics_payload" -v`
Expected: FAIL — `AttributeError: module 'journal' has no attribute 'analytics_payload'`

- [ ] **Step 3: Implement the function**

Append to `journal.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_journal_analytics.py -v`
Expected: PASS (all analytics tests green)

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal_analytics.py
git commit -m "feat(analytics): add analytics_payload assembler"
```

---

### Task 6: Flask routes

**Files:**
- Modify: `app.py` (add `jsonify` import; add two routes after the existing journal routes)
- Test: `tests/test_journal_app.py` (append tests)

**Interfaces:**
- Consumes: `journal.analytics_payload` (Task 5), `journal.load`, `journal_file()`.
- Produces:
  - `GET /journal/analytics` (endpoint `journal_analytics`) → renders `journal_analytics.html`, 200
  - `GET /journal/analytics/data` (endpoint `journal_analytics_data`) → `jsonify(analytics_payload(...))`

Note: `/journal/analytics` is a static rule and Werkzeug ranks it above the dynamic `/journal/<date>` rule, so no ordering hazard — a test locks this in.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_journal_app.py`:

```python
# --------------------------------------------------------------------------- #
# Analytics page
# --------------------------------------------------------------------------- #

def test_analytics_page_renders(client):
    resp = client.get("/journal/analytics")
    assert resp.status_code == 200
    assert b"analytics-root" in resp.data        # the JS mount point
    assert b"analytics.js" in resp.data          # script is wired up


def test_analytics_data_returns_json(client):
    resp = client.get("/journal/analytics/data")
    assert resp.status_code == 200
    assert resp.is_json
    payload = resp.get_json()
    assert set(payload) == {"sections", "entries", "date_range"}
    # seeded store has the six default sections
    assert [s["name"] for s in payload["sections"]][0] == "people"


def test_analytics_route_not_shadowed_by_date_route(client):
    """`/journal/analytics` must hit the analytics page, not be parsed as a
    date by /journal/<date>."""
    resp = client.get("/journal/analytics")
    assert resp.status_code == 200
    assert b"analytics-root" in resp.data
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_journal_app.py -k "analytics" -v`
Expected: FAIL — 404 / `jinja2.exceptions.TemplateNotFound: journal_analytics.html` (route missing)

- [ ] **Step 3: Add the import and routes**

In `app.py`, change the Flask import line:

```python
from flask import Flask, flash, redirect, render_template, request, url_for
```

to:

```python
from flask import Flask, flash, jsonify, redirect, render_template, request, url_for
```

Then, immediately **after** the `journal_entry` route (the `@app.route("/journal/<date>")` function, which ends with `return _render_entry(data, date)`), insert:

```python
@app.route("/journal/analytics")
def journal_analytics():
    """The analytics dashboard shell. Data is fetched client-side from
    /journal/analytics/data, so no data is passed to the template."""
    return render_template("journal_analytics.html")


@app.route("/journal/analytics/data")
def journal_analytics_data():
    """JSON feed for the analytics charts. Fetched on page load and on window
    focus, so it always reflects the latest saved entries."""
    data = journal.load(journal_file())
    return jsonify(journal.analytics_payload(data))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_journal_app.py -k "analytics" -v`
Expected: PASS (3 passed). The page test passes because Task 9 creates the template — if running strictly in order, this step will still fail on `TemplateNotFound` until Task 9. **Therefore: implement Task 9's template file before running Step 4 of this task, OR run only `test_analytics_data_returns_json` now and the two render tests after Task 9.**

Run now (data endpoint only): `pytest tests/test_journal_app.py::test_analytics_data_returns_json -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_journal_app.py
git commit -m "feat(analytics): add /journal/analytics and /journal/analytics/data routes"
```

---

### Task 7: Nav links in journal templates

**Files:**
- Modify: `templates/journal_entry.html` (nav block)
- Modify: `templates/journal_search.html` (nav block)
- Modify: `templates/journal_sections.html` (nav block)
- Modify: `templates/journal_sections_archive.html` (nav block)
- Test: `tests/test_journal_app.py` (append one test)

**Interfaces:**
- Consumes: `journal_analytics` endpoint (Task 6).
- Produces: an "Analytics" nav link on every journal page.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_journal_app.py`:

```python
def test_journal_nav_has_analytics_link(client):
    """Every journal page exposes the Analytics link in its nav."""
    for path in ["/journal", "/journal/search", "/journal/sections"]:
        resp = client.get(path)
        assert resp.status_code == 200
        assert b'href="/journal/analytics"' in resp.data, path
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_journal_app.py::test_journal_nav_has_analytics_link -v`
Expected: FAIL — `assert b'href="/journal/analytics"' in resp.data` is False

- [ ] **Step 3: Add the nav link to all four templates**

In **each** of `templates/journal_entry.html`, `templates/journal_search.html`, `templates/journal_sections.html`, `templates/journal_sections_archive.html`, the `{% block nav %}` currently contains these three links:

```html
  <a href="{{ url_for('journal_today') }}">New entry</a>
  <a href="{{ url_for('journal_search') }}">Search</a>
  <a href="{{ url_for('journal_sections') }}">Manage sections &amp; tags</a>
```

Add the Analytics link after the Search link so the block becomes:

```html
  <a href="{{ url_for('journal_today') }}">New entry</a>
  <a href="{{ url_for('journal_search') }}">Search</a>
  <a href="{{ url_for('journal_analytics') }}">Analytics</a>
  <a href="{{ url_for('journal_sections') }}">Manage sections &amp; tags</a>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_journal_app.py::test_journal_nav_has_analytics_link -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/journal_entry.html templates/journal_search.html templates/journal_sections.html templates/journal_sections_archive.html tests/test_journal_app.py
git commit -m "feat(analytics): add Analytics link to journal nav"
```

---

### Task 8: CSS for analytics page

**Files:**
- Modify: `static/style.css` (append an analytics section at the end)

**Interfaces:**
- Consumes: existing `:root` variables.
- Produces: classes `.analytics`, `.analytics-tabs`, `.analytics-tab`, `.analytics-tab.active`, `.analytics-filter`, `.analytics-panels`, `.analytics-panel`, `.analytics-empty`, `.stats-row`, `.stat`, `.stat-label`, `.stat-value`, `.chart-svg`, `.heat-cell`, `.matrix-table`.

No test (pure styling; verified visually in Task 10+).

- [ ] **Step 1: Append the styles**

Append to the end of `static/style.css`:

```css
/* ===================== analytics page ===================== */

.analytics { margin-top: 1rem; }

/* Tab bar — same segmented look as the .kind-toggle control. */
.analytics-tabs {
  display: inline-flex;
  flex-wrap: wrap;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 1rem;
}
.analytics-tab {
  background: var(--panel);
  color: var(--muted);
  border: none;
  border-left: 1px solid var(--border);
  padding: 0.5rem 0.9rem;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}
.analytics-tab:first-child { border-left: none; }
.analytics-tab:hover { color: var(--text); }
.analytics-tab.active {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
}

/* Shared date filter. */
.analytics-filter {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-bottom: 1.2rem;
  color: var(--muted);
  font-size: 0.85rem;
}
.analytics-filter input[type="date"] { width: 165px; }

/* One card per chart. */
.analytics-panels { display: flex; flex-direction: column; gap: 1rem; }
.analytics-panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1rem 1.1rem;
}
.analytics-panel h3 {
  margin: 0 0 0.8rem;
  font-size: 0.95rem;
  color: var(--accent);
}
.analytics-panel h4 {
  margin: 0.4rem 0 0.5rem;
  font-size: 0.85rem;
  color: var(--text);
}
.analytics-empty { color: var(--muted); font-style: italic; font-size: 0.85rem; }

/* SVG charts fill the card width; height is set per chart. */
.chart-svg { display: block; width: 100%; height: auto; overflow: visible; }

/* Compact stats row under a chart. */
.stats-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1rem;
  margin-top: 0.7rem;
  font-size: 0.8rem;
}
.stat { display: inline-flex; gap: 0.35rem; }
.stat-label { color: var(--muted); }
.stat-value { color: var(--text); }

/* Calendar / per-tag heatmap cells. */
.heat-cell { stroke: var(--bg); stroke-width: 1; }

/* Co-occurrence matrix. */
.matrix-table { border-collapse: collapse; font-size: 0.75rem; }
.matrix-table th, .matrix-table td {
  border: 1px solid var(--border);
  padding: 0.25rem 0.4rem;
  text-align: center;
  color: var(--text);
}
.matrix-table th { color: var(--muted); font-weight: normal; }

/* A sub-card per section inside the Tags / Numeric panels. */
.section-block { margin-bottom: 1.2rem; }
.section-block:last-child { margin-bottom: 0; }
```

- [ ] **Step 2: Verify CSS loads without error**

Run: `flask --app app run --port 5001` in the background, then `curl -s http://127.0.0.1:5001/static/style.css | tail -5`
Expected: the new `.section-block` rules appear. Stop the server.

- [ ] **Step 3: Commit**

```bash
git add static/style.css
git commit -m "feat(analytics): add analytics page styles"
```

---

### Task 9: Analytics page template

**Files:**
- Create: `templates/journal_analytics.html`

**Interfaces:**
- Consumes: `base.html` blocks (`brand_mascot`, `brand_title`, `nav`, `content`, `scripts`); `journal_analytics` and `journal_analytics_data` endpoints.
- Produces: the DOM shell `#analytics-root[data-endpoint]` containing `.analytics-tabs`, `.analytics-filter` (with `#date-from`, `#date-to`, `#date-reset`), and `.analytics-panels`; loads `static/analytics.js`.

- [ ] **Step 1: Create the template**

Create `templates/journal_analytics.html`:

```html
{% extends "base.html" %}
{% block brand_mascot %}
  <img class="mascot" src="{{ url_for('static', filename='img/pompompurin.gif') }}"
       width="56" height="56" alt="pompompurin">
{% endblock %}
{% block brand_title %}
  <span class="site-title">journal</span>
{% endblock %}
{% block nav %}
  <a href="{{ url_for('journal_today') }}">New entry</a>
  <a href="{{ url_for('journal_search') }}">Search</a>
  <a href="{{ url_for('journal_analytics') }}">Analytics</a>
  <a href="{{ url_for('journal_sections') }}">Manage sections &amp; tags</a>
{% endblock %}
{% block content %}
  <div class="analytics" id="analytics-root"
       data-endpoint="{{ url_for('journal_analytics_data') }}">
    <div class="analytics-tabs" role="tablist"></div>
    <div class="analytics-filter">
      <label>from <input type="date" id="date-from"></label>
      <label>to <input type="date" id="date-to"></label>
      <button type="button" id="date-reset">reset</button>
    </div>
    <div class="analytics-panels"></div>
    <p class="analytics-empty" id="analytics-loading">Loading…</p>
  </div>
{% endblock %}
{% block scripts %}
  <script src="{{ url_for('static', filename='analytics.js') }}" defer></script>
{% endblock %}
```

- [ ] **Step 2: Run the route render tests (deferred from Task 6)**

Run: `pytest tests/test_journal_app.py -k "analytics" -v`
Expected: PASS (all 3 analytics route tests now green — template exists)

- [ ] **Step 3: Commit**

```bash
git add templates/journal_analytics.html
git commit -m "feat(analytics): add analytics page template shell"
```

---

### Task 10: analytics.js infrastructure (fetch, state, tabs, filter, SVG utils, registry)

**Files:**
- Create: `static/analytics.js`

**Interfaces:**
- Consumes: `#analytics-root[data-endpoint]` and child elements from Task 9.
- Produces (module-internal, used by Tasks 11–13 via the `CHARTS` array and `U` utility object):
  - `CHARTS` — array of `{id, panel, title, render(container, entries, sections, colors)}`. Tasks 11–13 push descriptors here.
  - `U` — utility namespace: `U.svgEl(tag, attrs)`, `U.svg(width, height)`, `U.drawGrid`, `U.drawAxis`, `U.drawBar`, `U.drawLine`, `U.drawDot`, `U.text`, `U.describe(values)`, `U.statsRow(container, pairs)`, `U.empty(container, msg)`, `U.colorMix(hex, pct)`, `U.tagSections(sections)`, `U.numericSections(sections)`.
  - Panels: `overview`, `consistency`, `tags`, `numeric`, `coverage`. The `numeric` tab is hidden when there are no numeric sections.

This file has no unit-test harness in this project; verification is by running the app (Step 3).

- [ ] **Step 1: Create the infrastructure file**

Create `static/analytics.js`:

```javascript
/* Analytics dashboard. Fetches /journal/analytics/data, filters by date in
 * memory, and renders charts via the CHARTS registry. To add a chart, push a
 * descriptor onto CHARTS (see analytics.js chart sections). No chart hardcodes
 * a section/tag name or a theme color — colors come from CSS variables and the
 * fetched section list, so new sections/tags appear automatically. */
(function () {
  "use strict";

  var root = document.getElementById("analytics-root");
  if (!root) return;

  // ----- state -----
  var ENDPOINT = root.dataset.endpoint;
  var _data = { sections: [], entries: [], date_range: { min: null, max: null } };
  var _from = null, _to = null;
  var _activeTab = "overview";
  var _rendered = {};       // panel id -> true once rendered for current data
  var _lastFetch = 0;

  // Panel definitions. `needs` optionally gates a tab's visibility.
  var PANELS = [
    { id: "overview", label: "Overview" },
    { id: "consistency", label: "Consistency" },
    { id: "tags", label: "Tags" },
    { id: "numeric", label: "Numeric", needs: hasNumeric },
    { id: "coverage", label: "Coverage" },
  ];

  // Filled by the chart sections (Tasks 11-13).
  var CHARTS = [];
  window.__ANALYTICS_CHARTS__ = CHARTS;  // exposed so chart files can push

  function hasNumeric() {
    return _data.sections.some(function (s) { return s.type === "numeric"; });
  }

  // ----- color resolution (live, from CSS vars) -----
  function colors() {
    var cs = getComputedStyle(document.documentElement);
    function v(name) { return cs.getPropertyValue(name).trim(); }
    return {
      bg: v("--bg"), panel: v("--panel"), text: v("--text"),
      muted: v("--muted"), border: v("--border"),
      accent: v("--accent"), danger: v("--danger"),
    };
  }

  // ----- SVG / stats utilities (U) -----
  var SVGNS = "http://www.w3.org/2000/svg";

  var U = {
    svgEl: function (tag, attrs) {
      var el = document.createElementNS(SVGNS, tag);
      for (var k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
      return el;
    },

    svg: function (width, height) {
      var s = U.svgEl("svg", {
        viewBox: "0 0 " + width + " " + height,
        class: "chart-svg",
        preserveAspectRatio: "xMidYMid meet",
      });
      s.dataset.w = width; s.dataset.h = height;
      return s;
    },

    text: function (svg, x, y, str, fill, opts) {
      opts = opts || {};
      var t = U.svgEl("text", {
        x: x, y: y, fill: fill,
        "font-family": "inherit",
        "font-size": opts.size || 10,
        "text-anchor": opts.anchor || "start",
      });
      t.textContent = str;
      svg.appendChild(t);
      return t;
    },

    drawGrid: function (svg, x, y, w, h, rows, c) {
      for (var i = 0; i <= rows; i++) {
        var yy = y + (h * i) / rows;
        svg.appendChild(U.svgEl("line", {
          x1: x, y1: yy, x2: x + w, y2: yy,
          stroke: c.border, "stroke-width": 1,
        }));
      }
    },

    drawAxis: function (svg, x, y, w, h, labels, c) {
      // X-axis baseline + evenly spaced tick labels below it.
      svg.appendChild(U.svgEl("line", {
        x1: x, y1: y + h, x2: x + w, y2: y + h,
        stroke: c.muted, "stroke-width": 1,
      }));
      var n = labels.length;
      for (var i = 0; i < n; i++) {
        var cx = n === 1 ? x + w / 2 : x + (w * i) / (n - 1);
        U.text(svg, cx, y + h + 12, labels[i], c.muted,
               { anchor: "middle", size: 9 });
      }
    },

    drawBar: function (svg, x, y, w, h, color) {
      svg.appendChild(U.svgEl("rect", {
        x: x, y: y, width: Math.max(w, 0), height: Math.max(h, 0),
        fill: color, rx: 2,
      }));
    },

    drawLine: function (svg, points, color, width) {
      if (points.length < 2) return;
      var d = points.map(function (p, i) {
        return (i ? "L" : "M") + p.x + " " + p.y;
      }).join(" ");
      svg.appendChild(U.svgEl("path", {
        d: d, fill: "none", stroke: color, "stroke-width": width || 1.5,
      }));
    },

    drawDot: function (svg, cx, cy, r, color) {
      svg.appendChild(U.svgEl("circle", { cx: cx, cy: cy, r: r, fill: color }));
    },

    // mean/median/mode/stdev/min/max/count; matches journal.describe (sample stdev).
    describe: function (values) {
      var vals = values.filter(function (v) { return v != null; }).map(Number);
      var n = vals.length;
      if (!n) return { mean: null, median: null, mode: null,
                       stdev: null, min: null, max: null, count: 0 };
      var sorted = vals.slice().sort(function (a, b) { return a - b; });
      var mean = vals.reduce(function (a, b) { return a + b; }, 0) / n;
      var median = n % 2 ? sorted[(n - 1) / 2]
                         : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      var counts = new Map();
      vals.forEach(function (v) { counts.set(v, (counts.get(v) || 0) + 1); });
      var top = 0;
      counts.forEach(function (c) { if (c > top) top = c; });
      var mode = null;
      if (top > 1) {
        var modes = [];
        counts.forEach(function (c, v) { if (c === top) modes.push(v); });
        mode = Math.min.apply(null, modes);
      }
      var stdev = n >= 2 ? Math.sqrt(vals.reduce(function (a, b) {
        return a + (b - mean) * (b - mean);
      }, 0) / (n - 1)) : null;
      return { mean: mean, median: median, mode: mode, stdev: stdev,
               min: sorted[0], max: sorted[n - 1], count: n };
    },

    // pairs: [["label", "value"], ...]; null/undefined values are skipped.
    statsRow: function (container, pairs) {
      var row = document.createElement("div");
      row.className = "stats-row";
      pairs.forEach(function (p) {
        if (p[1] == null || p[1] === "") return;
        var stat = document.createElement("span");
        stat.className = "stat";
        var l = document.createElement("span");
        l.className = "stat-label"; l.textContent = p[0] + ":";
        var v = document.createElement("span");
        v.className = "stat-value"; v.textContent = p[1];
        stat.appendChild(l); stat.appendChild(v);
        row.appendChild(stat);
      });
      if (row.children.length) container.appendChild(row);
    },

    empty: function (container, msg) {
      var p = document.createElement("p");
      p.className = "analytics-empty";
      p.textContent = msg;
      container.appendChild(p);
    },

    colorMix: function (hex, pct) {
      return "color-mix(in srgb, " + hex + " " + pct + "%, transparent)";
    },

    tagSections: function (sections) {
      return sections.filter(function (s) { return s.type === "tag"; });
    },

    numericSections: function (sections) {
      return sections.filter(function (s) { return s.type === "numeric"; });
    },

    fmt: function (n) {  // tidy number for stat display
      if (n == null) return null;
      return Math.round(n * 100) / 100 + "";
    },
  };

  window.__ANALYTICS_U__ = U;  // exposed for chart files

  // ----- date filtering -----
  function filterEntries() {
    return _data.entries.filter(function (e) {
      return (!_from || e.date >= _from) && (!_to || e.date <= _to);
    });
  }

  // ----- tabs -----
  function buildTabs() {
    var bar = root.querySelector(".analytics-tabs");
    bar.innerHTML = "";
    PANELS.forEach(function (p) {
      if (p.needs && !p.needs()) return;
      var btn = document.createElement("button");
      btn.className = "analytics-tab" + (p.id === _activeTab ? " active" : "");
      btn.textContent = p.label;
      btn.dataset.panel = p.id;
      btn.addEventListener("click", function () { switchTab(p.id); });
      bar.appendChild(btn);
    });
    // If the active tab got hidden (e.g. numeric data removed), fall back.
    if (!PANELS.some(function (p) {
      return p.id === _activeTab && (!p.needs || p.needs());
    })) {
      _activeTab = "overview";
    }
  }

  function switchTab(id) {
    _activeTab = id;
    root.querySelectorAll(".analytics-tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.panel === id);
    });
    renderActivePanel();
  }

  // ----- rendering -----
  function renderActivePanel() {
    var host = root.querySelector(".analytics-panels");
    host.innerHTML = "";
    var entries = filterEntries();
    var c = colors();
    var charts = CHARTS.filter(function (ch) { return ch.panel === _activeTab; });

    if (!charts.length) {
      U.empty(host, "No charts for this section yet.");
      return;
    }
    charts.forEach(function (ch) {
      var panel = document.createElement("div");
      panel.className = "analytics-panel";
      panel.id = "chart-" + ch.id;
      var h3 = document.createElement("h3");
      h3.textContent = ch.title;
      panel.appendChild(h3);
      try {
        ch.render(panel, entries, _data.sections, c);
      } catch (err) {
        U.empty(panel, "Could not render this chart.");
        if (window.console) console.error(ch.id, err);
      }
      host.appendChild(panel);
    });
  }

  // ----- data load -----
  function applyData(payload) {
    _data = payload || _data;
    var loading = document.getElementById("analytics-loading");
    if (loading) loading.remove();
    // Initialize date inputs to full range on first load only.
    var fromEl = document.getElementById("date-from");
    var toEl = document.getElementById("date-to");
    if (_from === null && _to === null) {
      _from = _data.date_range.min;
      _to = _data.date_range.max;
      fromEl.value = _from || "";
      toEl.value = _to || "";
    }
    buildTabs();
    renderActivePanel();
  }

  function fetchData(force) {
    var now = Date.now();
    if (!force && now - _lastFetch < 10000) return;
    _lastFetch = now;
    fetch(ENDPOINT, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(applyData)
      .catch(function (err) {
        if (window.console) console.error("analytics fetch failed", err);
      });
  }

  // ----- wiring -----
  document.getElementById("date-from").addEventListener("change", function (e) {
    _from = e.target.value || null;
    renderActivePanel();
  });
  document.getElementById("date-to").addEventListener("change", function (e) {
    _to = e.target.value || null;
    renderActivePanel();
  });
  document.getElementById("date-reset").addEventListener("click", function () {
    _from = _data.date_range.min;
    _to = _data.date_range.max;
    document.getElementById("date-from").value = _from || "";
    document.getElementById("date-to").value = _to || "";
    renderActivePanel();
  });

  // Live refresh: re-fetch when the tab regains focus (debounced in fetchData).
  window.addEventListener("focus", function () { fetchData(false); });

  // Initial load.
  fetchData(true);
})();
```

- [ ] **Step 2: Verify the JS file is served**

Run: `flask --app app run --port 5001` (background), then `curl -s http://127.0.0.1:5001/static/analytics.js | head -3`
Expected: the file's leading comment prints.

- [ ] **Step 3: Verify the page loads in a browser**

With the server running, open `http://127.0.0.1:5001/journal/analytics`.
Expected: tab bar shows **Overview, Consistency, Tags, Coverage** (no Numeric tab — the seeded store has no numeric sections); date inputs populated to the entry range; each tab shows "No charts for this section yet." (charts arrive in Tasks 11–13); no console errors. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add static/analytics.js
git commit -m "feat(analytics): add analytics.js infrastructure (fetch, tabs, filter, SVG utils)"
```

---

### Task 11: Overview & Consistency charts

**Files:**
- Modify: `static/analytics.js` (append chart descriptors before the final `fetchData(true);` line is NOT required — push onto `CHARTS` inside the IIFE; see placement note)

**Placement note:** All chart descriptors live **inside** the existing IIFE so they can read `CHARTS` and `U`. Insert the code from this task immediately **after** the `var U = {...}; window.__ANALYTICS_U__ = U;` block and **before** the `// ----- date filtering -----` comment. Tasks 12 and 13 append in the same spot, in order.

**Interfaces:**
- Consumes: `CHARTS`, `U`, the `colors` object passed to `render`.
- Produces: chart descriptors `overview-summary`, `calendar-heatmap`, `word-count`, `entry-gaps`, `time-of-day`.

This task replicates the Python helper logic in JS (the spec calls these client-side). Logic mirrors Task 1–4 helpers exactly.

- [ ] **Step 1: Append the Overview & Consistency charts**

Insert into `static/analytics.js` at the placement point described above:

```javascript
  // ===================== Overview & Consistency charts ===================== //

  // Shared JS reimplementations of the streak/gap logic (mirror journal.py).
  function uniqueDates(entries) {
    var set = {};
    entries.forEach(function (e) { if (e.date) set[e.date] = true; });
    return Object.keys(set).sort();
  }
  function dayDiff(a, b) {  // whole days between two YYYY-MM-DD strings
    return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  }
  function streaks(dates) {
    if (!dates.length) return { current: 0, longest: 0, runs: [] };
    var runs = [], run = 1;
    for (var i = 1; i < dates.length; i++) {
      if (dayDiff(dates[i - 1], dates[i]) === 1) run++;
      else { runs.push(run); run = 1; }
    }
    runs.push(run);
    return { current: runs[runs.length - 1], longest: Math.max.apply(null, runs), runs: runs };
  }

  CHARTS.push({
    id: "overview-summary",
    panel: "overview",
    title: "Overview",
    render: function (container, entries, sections, c) {
      if (!entries.length) { U.empty(container, "No entries in this range."); return; }
      var dates = uniqueDates(entries);
      var st = streaks(dates);
      var words = entries.map(function (e) { return (e.body || "").split(/\s+/).filter(Boolean).length; });
      var wd = U.describe(words);
      var coveredCounts = entries.map(function (e) {
        var n = 0;
        sections.forEach(function (s) {
          var t = (e.tags || {})[s.id];
          if ((t && t.length) || (e.numbers || {})[s.id] != null) n++;
        });
        return n;
      });
      var avgCov = U.describe(coveredCounts).mean;
      U.statsRow(container, [
        ["entries", entries.length],
        ["current streak", st.current + "d"],
        ["longest streak", st.longest + "d"],
        ["last entry", dates[dates.length - 1]],
        ["avg words/entry", U.fmt(wd.mean)],
        ["avg sections filled", U.fmt(avgCov)],
      ]);
    },
  });

  CHARTS.push({
    id: "calendar-heatmap",
    panel: "consistency",
    title: "Entry calendar",
    render: function (container, entries, sections, c) {
      var dates = uniqueDates(entries);
      if (!dates.length) { U.empty(container, "No entries in this range."); return; }
      var present = {};
      dates.forEach(function (d) { present[d] = true; });
      // Grid: columns = ISO weeks, rows = weekday (Mon..Sun), from first to last date.
      var start = new Date(dates[0] + "T00:00:00");
      var end = new Date(dates[dates.length - 1] + "T00:00:00");
      // Snap start back to Monday.
      var startDow = (start.getDay() + 6) % 7;  // 0=Mon
      start.setDate(start.getDate() - startDow);
      var cell = 13, gap = 2, rows = 7;
      var totalDays = Math.round((end - start) / 86400000) + 1;
      var cols = Math.ceil((totalDays + ((start.getDay() + 6) % 7)) / 7) + 1;
      var w = cols * (cell + gap) + 30, h = rows * (cell + gap) + 20;
      var svg = U.svg(w, h);
      var d = new Date(start);
      var col = 0;
      while (d <= end) {
        var dow = (d.getDay() + 6) % 7;
        var iso = d.toISOString().slice(0, 10);
        var on = !!present[iso];
        svg.appendChild(U.svgEl("rect", {
          x: 30 + col * (cell + gap),
          y: dow * (cell + gap),
          width: cell, height: cell, rx: 2,
          class: "heat-cell",
          fill: on ? c.accent : U.colorMix(c.muted, 18),
        }));
        if (dow === 6) col++;
        d.setDate(d.getDate() + 1);
      }
      ["Mon", "", "Wed", "", "Fri", "", "Sun"].forEach(function (lbl, i) {
        if (lbl) U.text(svg, 0, i * (cell + gap) + cell, lbl, c.muted, { size: 9 });
      });
      container.appendChild(svg);
      U.statsRow(container, [["days with an entry", dates.length]]);
    },
  });

  CHARTS.push({
    id: "word-count",
    panel: "consistency",
    title: "Words per entry over time",
    render: function (container, entries, sections, c) {
      var series = entries.map(function (e) {
        return { date: e.date, count: (e.body || "").split(/\s+/).filter(Boolean).length };
      }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) { U.empty(container, "No entries in this range."); return; }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, series.map(function (s) { return s.count; })) || 1;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      var pts = series.map(function (s, i) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - s.count / max);
        return { x: x, y: y };
      });
      U.drawLine(svg, pts, c.accent, 1.5);
      pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      container.appendChild(svg);
      var wd = U.describe(series.map(function (s) { return s.count; }));
      U.statsRow(container, [["mean", U.fmt(wd.mean)], ["median", U.fmt(wd.median)]]);
    },
  });

  CHARTS.push({
    id: "entry-gaps",
    panel: "consistency",
    title: "Gaps between entries",
    render: function (container, entries, sections, c) {
      var dates = uniqueDates(entries);
      var gaps = [];
      for (var i = 1; i < dates.length; i++) gaps.push(dayDiff(dates[i - 1], dates[i]));
      if (!gaps.length) { U.empty(container, "Need at least two entries to show gaps."); return; }
      // Histogram by gap size.
      var hist = {};
      gaps.forEach(function (g) { hist[g] = (hist[g] || 0) + 1; });
      var keys = Object.keys(hist).map(Number).sort(function (a, b) { return a - b; });
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, keys.map(function (k) { return hist[k]; }));
      var bw = (w - pad - 10) / keys.length;
      keys.forEach(function (k, i) {
        var bh = (h - pad - 10) * (hist[k] / max);
        U.drawBar(svg, pad + i * bw + 2, 10 + (h - pad - 10) - bh, bw - 4, bh, c.accent);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 keys.map(function (k) { return k + "d"; }), c);
      container.appendChild(svg);
      var gd = U.describe(gaps);
      U.statsRow(container, [["mean gap", U.fmt(gd.mean) + "d"],
                             ["median gap", U.fmt(gd.median) + "d"]]);
    },
  });

  CHARTS.push({
    id: "time-of-day",
    panel: "consistency",
    title: "When entries are written",
    render: function (container, entries, sections, c) {
      var hours = {};
      for (var i = 0; i < 24; i++) hours[i] = 0;
      var any = false;
      entries.forEach(function (e) {
        if (!e.created) return;
        var hr = new Date(e.created).getHours();
        if (!isNaN(hr)) { hours[hr]++; any = true; }
      });
      if (!any) { U.empty(container, "No creation timestamps in this range."); return; }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, Object.keys(hours).map(function (k) { return hours[k]; })) || 1;
      var bw = (w - pad - 10) / 24;
      for (var hgt = 0; hgt < 24; hgt++) {
        var bh = (h - pad - 10) * (hours[hgt] / max);
        U.drawBar(svg, pad + hgt * bw + 1, 10 + (h - pad - 10) - bh, bw - 2, bh, c.accent);
      }
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, ["0", "6", "12", "18", "23"], c);
      container.appendChild(svg);
      // Mode hour as "usually journals at Xam/pm".
      var counts = Object.keys(hours).map(function (k) { return [Number(k), hours[k]]; });
      counts.sort(function (a, b) { return b[1] - a[1]; });
      var topHr = counts[0][1] > 0 ? counts[0][0] : null;
      var label = topHr == null ? null
        : (topHr % 12 === 0 ? 12 : topHr % 12) + (topHr < 12 ? "am" : "pm");
      U.statsRow(container, [["usually writes around", label]]);
    },
  });
```

- [ ] **Step 2: Verify in the browser**

Run the server, open `http://127.0.0.1:5001/journal/analytics`.
Expected:
- **Overview** tab: a stats row (entries, current/longest streak, last entry, avg words, avg sections filled).
- **Consistency** tab: calendar heatmap with amber cells on entry days, a words-per-entry line chart, a gaps histogram, and a time-of-day bar chart. Colors match the theme; no console errors.
- Change the date inputs → charts re-render to the narrowed range. Stop the server.

- [ ] **Step 3: Commit**

```bash
git add static/analytics.js
git commit -m "feat(analytics): add overview and consistency charts"
```

---

### Task 12: Tag charts

**Files:**
- Modify: `static/analytics.js` (append descriptors at the same placement point, after Task 11's block)

**Interfaces:**
- Consumes: `CHARTS`, `U`, per-render `colors`; each chart loops `U.tagSections(sections)` and uses `section.color` per section.
- Produces: chart descriptors `tag-frequency`, `tag-trend`, `tag-heatmap`, `tag-cooccurrence` (all in panel `tags`, one sub-card per tag section).

- [ ] **Step 1: Append the Tag charts**

Insert into `static/analytics.js` after Task 11's pushed block:

```javascript
  // ===================== Tag charts (one block per tag section) ============ //

  function tagsForSectionEntry(e, sid) {
    return ((e.tags || {})[sid]) || [];
  }
  function sectionTagFreq(entries, sid) {
    var freq = {};
    entries.forEach(function (e) {
      tagsForSectionEntry(e, sid).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; });
    });
    return freq;
  }

  CHARTS.push({
    id: "tag-frequency",
    panel: "tags",
    title: "Tag frequency",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      if (!tagSecs.length) { U.empty(container, "No tag sections."); return; }
      var rendered = false;
      tagSecs.forEach(function (s) {
        var freq = sectionTagFreq(entries, s.id);
        var keys = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
        if (!keys.length) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name;
        block.appendChild(h4);
        var rowH = 18, w = 600, pad = 90;
        var svg = U.svg(w, keys.length * rowH + 6);
        var max = Math.max.apply(null, keys.map(function (k) { return freq[k]; }));
        keys.forEach(function (k, i) {
          var y = i * rowH + 2;
          U.text(svg, pad - 6, y + 12, k, c.text, { anchor: "end", size: 10 });
          var bw = (w - pad - 30) * (freq[k] / max);
          U.drawBar(svg, pad, y + 3, bw, 11, s.color);
          U.text(svg, pad + bw + 4, y + 12, freq[k], c.muted, { size: 9 });
        });
        block.appendChild(svg);
        // mode (most-used tag) + mean uses/tag.
        var d = U.describe(keys.map(function (k) { return freq[k]; }));
        U.statsRow(block, [["most-used", keys[0]],
                           ["mean uses/tag", U.fmt(d.mean)]]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No tags recorded in this range.");
    },
  });

  CHARTS.push({
    id: "tag-trend",
    panel: "tags",
    title: "Top-tag trend (per ISO week)",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      var rendered = false;
      tagSecs.forEach(function (s) {
        var freq = sectionTagFreq(entries, s.id);
        var keys = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
        if (!keys.length) return;
        var tag = keys[0];  // chart the section's most-used tag
        // Weekly counts.
        var weeks = {};
        entries.forEach(function (e) {
          if (tagsForSectionEntry(e, s.id).indexOf(tag) === -1) return;
          var d = new Date(e.date + "T00:00:00");
          var wk = isoWeekKey(d);
          weeks[wk] = (weeks[wk] || 0) + 1;
        });
        var wk = Object.keys(weeks).sort();
        if (wk.length < 2) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + " — “" + tag + "”";
        block.appendChild(h4);
        var w = 600, h = 160, pad = 30;
        var svg = U.svg(w, h);
        var max = Math.max.apply(null, wk.map(function (k) { return weeks[k]; }));
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 3, c);
        var pts = wk.map(function (k, i) {
          var x = pad + ((w - pad - 10) * i) / (wk.length - 1);
          var y = 10 + (h - pad - 10) * (1 - weeks[k] / max);
          return { x: x, y: y };
        });
        U.drawLine(svg, pts, s.color, 1.5);
        pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, s.color); });
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                   [wk[0], wk[wk.length - 1]], c);
        block.appendChild(svg);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "Not enough data for a weekly trend yet.");
    },
  });

  function isoWeekKey(date) {
    // ISO-8601 week number, matching Python's isocalendar().
    var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    var dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    var firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    var week = 1 + Math.round(
      ((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + "-W" + (week < 10 ? "0" + week : week);
  }

  CHARTS.push({
    id: "tag-heatmap",
    panel: "tags",
    title: "Per-tag activity",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      var dates = uniqueDates(entries);
      if (!dates.length) { U.empty(container, "No entries in this range."); return; }
      var rendered = false;
      tagSecs.forEach(function (s) {
        var freq = sectionTagFreq(entries, s.id);
        var tags = Object.keys(freq).sort();
        if (!tags.length) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name;
        block.appendChild(h4);
        // rows = tags, cols = dates; cell filled (section color) if tag present that day.
        var byDate = {};
        entries.forEach(function (e) { byDate[e.date] = tagsForSectionEntry(e, s.id); });
        var cell = 12, gap = 2, labelW = 90;
        var w = labelW + dates.length * (cell + gap);
        var h = tags.length * (cell + gap) + 4;
        var svg = U.svg(w, h);
        tags.forEach(function (t, r) {
          U.text(svg, labelW - 6, r * (cell + gap) + cell, t, c.text,
                 { anchor: "end", size: 9 });
          dates.forEach(function (d, col) {
            var on = (byDate[d] || []).indexOf(t) !== -1;
            svg.appendChild(U.svgEl("rect", {
              x: labelW + col * (cell + gap), y: r * (cell + gap),
              width: cell, height: cell, rx: 2, class: "heat-cell",
              fill: on ? s.color : U.colorMix(c.muted, 16),
            }));
          });
        });
        block.appendChild(svg);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No tags recorded in this range.");
    },
  });

  CHARTS.push({
    id: "tag-cooccurrence",
    panel: "tags",
    title: "Tag co-occurrence",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      var rendered = false;
      tagSecs.forEach(function (s) {
        // Build co-occurrence within this section.
        var co = {};
        var tagSet = {};
        entries.forEach(function (e) {
          var tags = Array.from(new Set(tagsForSectionEntry(e, s.id))).sort();
          tags.forEach(function (a) {
            tagSet[a] = true;
            tags.forEach(function (b) {
              if (a === b) return;
              co[a] = co[a] || {};
              co[a][b] = (co[a][b] || 0) + 1;
            });
          });
        });
        var tags = Object.keys(tagSet).sort();
        if (tags.length < 2) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name;
        block.appendChild(h4);
        var table = document.createElement("table");
        table.className = "matrix-table";
        var thead = document.createElement("tr");
        thead.appendChild(document.createElement("th"));
        tags.forEach(function (t) {
          var th = document.createElement("th"); th.textContent = t; thead.appendChild(th);
        });
        table.appendChild(thead);
        tags.forEach(function (a) {
          var tr = document.createElement("tr");
          var rh = document.createElement("th"); rh.textContent = a; tr.appendChild(rh);
          tags.forEach(function (b) {
            var td = document.createElement("td");
            if (a === b) { td.textContent = "·"; td.style.color = c.muted; }
            else {
              var n = (co[a] && co[a][b]) || 0;
              td.textContent = n || "";
              if (n) td.style.background = U.colorMix(s.color, Math.min(80, 20 + n * 20));
            }
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        block.appendChild(table);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "Need a section with 2+ co-occurring tags.");
    },
  });
```

- [ ] **Step 2: Verify in the browser**

Seed some data first if needed: the existing `data/journal.json` has tags on the "people" section. Run the server, open the **Tags** tab.
Expected: per-section sub-cards for frequency bars (in each section's own color), a top-tag weekly trend (when ≥2 weeks of data), a per-tag activity heatmap, and a co-occurrence matrix (when a section has 2+ tags appearing together). No console errors. Add a new tag/section via the journal UI, return to analytics, regain window focus → the new tag appears without a code change. Stop the server.

- [ ] **Step 3: Commit**

```bash
git add static/analytics.js
git commit -m "feat(analytics): add tag frequency, trend, heatmap, co-occurrence charts"
```

---

### Task 13: Numeric & Coverage charts

**Files:**
- Modify: `static/analytics.js` (append descriptors at the same placement point, after Task 12's block)

**Interfaces:**
- Consumes: `CHARTS`, `U`, per-render `colors`; loops `U.numericSections(sections)` for numeric charts.
- Produces: chart descriptors `numeric-line`, `numeric-dow`, `numeric-scatter` (panel `numeric`), and `section-coverage` (panel `coverage`).

- [ ] **Step 1: Append the Numeric & Coverage charts**

Insert into `static/analytics.js` after Task 12's pushed block:

```javascript
  // ===================== Numeric & Coverage charts ========================= //

  function numericSeries(entries, sid) {
    return entries
      .filter(function (e) { return (e.numbers || {})[sid] != null; })
      .map(function (e) { return { date: e.date, value: Number(e.numbers[sid]) }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }
  function rollingAvg(values, win) {
    return values.map(function (_, i) {
      var s = Math.max(0, i - win + 1);
      var slice = values.slice(s, i + 1);
      return slice.reduce(function (a, b) { return a + b; }, 0) / slice.length;
    });
  }

  CHARTS.push({
    id: "numeric-line",
    panel: "numeric",
    title: "Numeric values over time",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var rendered = false;
      nums.forEach(function (s) {
        var series = numericSeries(entries, s.id);
        if (!series.length) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 180, pad = 34;
        var svg = U.svg(w, h);
        var vals = series.map(function (p) { return p.value; });
        var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
        var span = max - min || 1;
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
        function ptAt(i, v) {
          var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                      : pad + ((w - pad - 10) * i) / (series.length - 1);
          var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
          return { x: x, y: y };
        }
        var pts = series.map(function (p, i) { return ptAt(i, p.value); });
        // 7-point rolling average overlay (muted).
        var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
        U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);
        U.drawLine(svg, pts, s.color, 1.5);
        pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, s.color); });
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                   [series[0].date, series[series.length - 1].date], c);
        U.text(svg, 0, 14, U.fmt(max), c.muted, { size: 9 });
        U.text(svg, 0, h - pad + 2, U.fmt(min), c.muted, { size: 9 });
        block.appendChild(svg);
        var d = U.describe(vals);
        U.statsRow(block, [
          ["mean", U.fmt(d.mean)], ["median", U.fmt(d.median)],
          ["mode", U.fmt(d.mode)], ["std dev", U.fmt(d.stdev)],
          ["min", U.fmt(d.min)], ["max", U.fmt(d.max)],
        ]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No numeric values in this range.");
    },
  });

  CHARTS.push({
    id: "numeric-dow",
    panel: "numeric",
    title: "Average by day of week",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      var names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      var rendered = false;
      nums.forEach(function (s) {
        var buckets = [[], [], [], [], [], [], []];
        entries.forEach(function (e) {
          var v = (e.numbers || {})[s.id];
          if (v == null) return;
          var dow = (new Date(e.date + "T00:00:00").getDay() + 6) % 7;
          buckets[dow].push(Number(v));
        });
        var avgs = buckets.map(function (b) {
          return b.length ? b.reduce(function (a, x) { return a + x; }, 0) / b.length : null;
        });
        if (avgs.every(function (a) { return a == null; })) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 180, pad = 30;
        var svg = U.svg(w, h);
        var present = avgs.filter(function (a) { return a != null; });
        var max = Math.max.apply(null, present), min = Math.min.apply(null, present.concat(0));
        var bw = (w - pad - 10) / 7;
        avgs.forEach(function (a, i) {
          if (a == null) return;
          var bh = (h - pad - 10) * ((a - Math.min(0, min)) / ((max - Math.min(0, min)) || 1));
          U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, s.color);
        });
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, names, c);
        block.appendChild(svg);
        // highest / lowest day.
        var ranked = names
          .map(function (n, i) { return [n, avgs[i]]; })
          .filter(function (p) { return p[1] != null; })
          .sort(function (a, b) { return b[1] - a[1]; });
        U.statsRow(block, [
          ["highest", ranked[0][0] + " (" + U.fmt(ranked[0][1]) + ")"],
          ["lowest", ranked[ranked.length - 1][0] + " (" + U.fmt(ranked[ranked.length - 1][1]) + ")"],
        ]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No numeric values in this range.");
    },
  });

  CHARTS.push({
    id: "numeric-scatter",
    panel: "numeric",
    title: "Correlation between two numeric sections",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (nums.length < 2) { U.empty(container, "Need two numeric sections to correlate."); return; }
      var sx = nums[0], sy = nums[1];
      var pairs = entries.filter(function (e) {
        return (e.numbers || {})[sx.id] != null && (e.numbers || {})[sy.id] != null;
      }).map(function (e) {
        return { x: Number(e.numbers[sx.id]), y: Number(e.numbers[sy.id]) };
      });
      if (!pairs.length) { U.empty(container, "No days with both values recorded."); return; }
      var w = 600, h = 240, pad = 36;
      var svg = U.svg(w, h);
      var xs = pairs.map(function (p) { return p.x; }), ys = pairs.map(function (p) { return p.y; });
      var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
      var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
      var xSpan = xMax - xMin || 1, ySpan = yMax - yMin || 1;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      pairs.forEach(function (p) {
        var x = pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
        var y = 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
        U.drawDot(svg, x, y, 3, U.colorMix(sx.color, 80));
      });
      U.text(svg, w / 2, h - 2, sx.name + " (x)  vs  " + sy.name + " (y)", c.muted,
             { anchor: "middle", size: 9 });
      container.appendChild(svg);
      U.statsRow(container, [["points", pairs.length]]);
    },
  });

  CHARTS.push({
    id: "section-coverage",
    panel: "coverage",
    title: "Section coverage per entry",
    render: function (container, entries, sections, c) {
      if (!entries.length) { U.empty(container, "No entries in this range."); return; }
      var sorted = entries.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      var cell = 14, gap = 2, labelW = 90;
      var w = labelW + sorted.length * (cell + gap);
      var h = sections.length * (cell + gap) + 4;
      var svg = U.svg(w, h);
      var coveredCounts = [];
      sections.forEach(function (s, r) {
        U.text(svg, labelW - 6, r * (cell + gap) + cell, s.name, c.text,
               { anchor: "end", size: 9 });
        sorted.forEach(function (e, col) {
          var t = (e.tags || {})[s.id];
          var on = (t && t.length) || (e.numbers || {})[s.id] != null;
          svg.appendChild(U.svgEl("rect", {
            x: labelW + col * (cell + gap), y: r * (cell + gap),
            width: cell, height: cell, rx: 2, class: "heat-cell",
            fill: on ? s.color : U.colorMix(c.muted, 16),
          }));
        });
      });
      sorted.forEach(function (e) {
        var n = 0;
        sections.forEach(function (s) {
          var t = (e.tags || {})[s.id];
          if ((t && t.length) || (e.numbers || {})[s.id] != null) n++;
        });
        coveredCounts.push(n);
      });
      container.appendChild(svg);
      var pct = sections.length
        ? U.describe(coveredCounts.map(function (n) { return (n / sections.length) * 100; })).mean
        : null;
      U.statsRow(container, [["mean sections filled", U.fmt(pct) + "%"]]);
    },
  });
```

- [ ] **Step 2: Verify in the browser (with a numeric section)**

The seeded/real store has no numeric section, so first create one to exercise these charts:
1. Run the server, go to **Manage sections & tags**, add a numeric section (e.g. "sleep", unit "hrs").
2. Add a couple of journal entries on different dates with sleep values.
3. Open **Analytics** → a **Numeric** tab now appears.

Expected: numeric line chart with a muted 7-day rolling-average overlay and a full describe stats row; day-of-week average bars with highest/lowest stats; the correlation scatter shows its "need two numeric sections" message until a second numeric section exists. The **Coverage** tab shows a grid of section-colored cells per entry with a "mean sections filled %" stat. No console errors. Stop the server.

- [ ] **Step 3: Run the full test suite**

Run: `pytest`
Expected: PASS (all existing tests + new analytics tests green).

- [ ] **Step 4: Commit**

```bash
git add static/analytics.js
git commit -m "feat(analytics): add numeric line/dow/scatter and coverage charts"
```

---

## Self-Review

**1. Spec coverage:**

| Spec item | Task |
|---|---|
| `GET /journal/analytics` route | Task 6 |
| `GET /journal/analytics/data` route | Task 6 |
| Nav link in 4 templates | Task 7 |
| `analytics_payload` shape (sections/entries/date_range, archived excluded) | Task 5 |
| All 13 helpers + `describe` | Tasks 1–5 |
| Statistical displays per chart | Tasks 11–13 (`U.describe` + `U.statsRow`) |
| Chart registry / easy to extend | Task 10 (`CHARTS` array; push in 11–13) |
| Render args `(container, entries, sections, colors)` | Task 10 |
| Colors from CSS vars + section hex | Task 10 (`colors()`), used in 11–13 |
| SVG utility functions | Task 10 (`U.*`) |
| Five tabs; Numeric hidden when no numeric sections | Task 10 (`PANELS`, `hasNumeric`) |
| Lazy render per tab | Task 10 (`renderActivePanel` on switch) |
| Date filter (from/to/reset, persists) | Task 10 |
| Live refresh (load + focus, 10s debounce) | Task 10 (`fetchData`, focus listener) |
| Styling (`.analytics-panel`, tabs like `.kind-toggle`, empty states) | Task 8 |
| Tests for helpers + routes | Tasks 1–7 |
| No new deps / CSS vars / touching todo.py etc. | Global Constraints |

All charts named in the spec (calendar heatmap, word count, gap histogram, time-of-day, tag frequency/trend/heatmap/co-occurrence, numeric line+rolling avg, day-of-week, scatter, coverage, overview streak/summary) are implemented across Tasks 11–13.

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases" placeholders — every code step contains complete code.

**3. Type consistency:** Helper signatures in the Interfaces blocks match their implementations and the spec table. JS `U.describe` returns the same key set as Python `describe`. Chart `render(container, entries, sections, colors)` signature is consistent across Tasks 10–13. The `CHARTS` array defined in Task 10 is appended to (never reassigned) in Tasks 11–13.

**Known sequencing note (called out in-task):** Task 6's two *render* tests (`test_analytics_page_renders`, `test_analytics_route_not_shadowed_by_date_route`) depend on the template from Task 9, so they are run at Task 9 Step 2; Task 6 Step 4 runs only the data-endpoint test. This is intentional and documented in both tasks.
