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
