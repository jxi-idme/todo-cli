"""Core to-do logic.

Pure, testable functions that operate on a plain data dict of the shape:

    {"active": [...], "archive": [...], "expired": [...]}

There are NO Flask imports here on purpose -- this module is the brain and
can be unit-tested without spinning up a web server.

Date assumption: all dates are naive local time (no timezone info). We use
datetime.now() as the reference clock, and ISO 8601 strings for storage.
"""

import json
import os
import uuid
from datetime import datetime, timedelta


def _empty():
    """A fresh, empty store."""
    return {"active": [], "archive": [], "expired": []}


# Recurrence values we accept. "every:N" (N a positive int) is handled
# separately since N varies.
_FIXED_RECURRENCES = {"daily", "weekly", "monthly"}


def _valid_recurrence(recurrence):
    """True if `recurrence` is a recognized recurrence value (or None)."""
    if recurrence is None:
        return True
    if recurrence in _FIXED_RECURRENCES:
        return True
    # Custom interval: "every:N" with N a positive integer.
    if isinstance(recurrence, str) and recurrence.startswith("every:"):
        try:
            return int(recurrence.split(":", 1)[1]) > 0
        except ValueError:
            return False
    return False


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #

def load(path):
    """Read the JSON store from `path`.

    If the file is missing or malformed we don't crash: a corrupt file is
    backed up to `<path>.bak` and we return a fresh empty store.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
    except FileNotFoundError:
        return _empty()
    except json.JSONDecodeError:
        # Preserve the bad data for inspection, then start clean.
        _backup(path)
        return _empty()

    # Valid JSON, but is it the shape we expect? It must be a dict with both
    # "active" and "archive" keys, each holding a list. Anything else is
    # treated like a corrupt file: back it up and start clean.
    if (
        isinstance(parsed, dict)
        and isinstance(parsed.get("active"), list)
        and isinstance(parsed.get("archive"), list)
    ):
        # Backward compatibility: older stores have no "expired" list. A
        # missing (or non-list) "expired" is NOT corruption -- we just
        # default it to [] and migrate gracefully.
        if not isinstance(parsed.get("expired"), list):
            parsed["expired"] = []
        return parsed
    _backup(path)
    return _empty()


def _backup(path):
    """Move a bad store aside to `<path>.bak` (best effort)."""
    try:
        os.replace(path, path + ".bak")
    except OSError:
        pass


def save(path, data):
    """Atomically write `data` as JSON to `path`.

    We write to a temp file first and then os.replace() it into place so a
    crash mid-write can never leave a half-written (corrupt) file.
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# Date helpers
# --------------------------------------------------------------------------- #

def _parse(due):
    """Parse an ISO date string into a datetime, or None if empty/invalid."""
    if not due:
        return None
    try:
        return datetime.fromisoformat(due)
    except ValueError:
        return None


def time_remaining(due, now=None):
    """Return a human-readable badge describing time left until `due`.

    Examples: "", "3 day(s) left", "5 hour(s) left", "due soon",
    "overdue by 2 day(s)", "overdue by 5 hour(s)", "overdue".

    Note: the instant a task passes its due time (delta == 0) it is treated
    as overdue. Within the first hour past due we just say "overdue" -- we
    never print "overdue by 0 hour(s)".
    """
    when = _parse(due)
    if when is None:
        return ""
    now = now or datetime.now()
    delta = when - now
    seconds = delta.total_seconds()

    if seconds <= 0:
        # Overdue: report how far past we are. Mirrors the forward-looking
        # tiers below (days, then hours, then a sub-hour catch-all).
        past = -seconds
        if past >= 86400:
            return f"overdue by {int(past // 86400)} day(s)"
        if past >= 3600:
            return f"overdue by {int(past // 3600)} hour(s)"
        # Less than an hour past (including the 0-second boundary): just say
        # "overdue" -- never "overdue by 0 hour(s)".
        return "overdue"

    if seconds >= 86400:
        return f"{int(seconds // 86400)} day(s) left"
    if seconds >= 3600:
        return f"{int(seconds // 3600)} hour(s) left"
    return "due soon"


def is_overdue(due, now=None):
    """True if `due` is in the past. No due date is never overdue."""
    when = _parse(due)
    if when is None:
        return False
    now = now or datetime.now()
    return when < now


def _add_one_month(when):
    """Return `when` advanced by one calendar month, clamping the day to the
    last valid day of the target month (e.g. Jan 31 -> Feb 28/29).
    """
    month = when.month + 1
    year = when.year
    if month > 12:
        month = 1
        year += 1
    # Clamp the day to the last day of the target month.
    day = min(when.day, _days_in_month(year, month))
    return when.replace(year=year, month=month, day=day)


def _days_in_month(year, month):
    """Number of days in a given month, leap-year aware."""
    if month == 12:
        nxt = datetime(year + 1, 1, 1)
    else:
        nxt = datetime(year, month + 1, 1)
    return (nxt - timedelta(days=1)).day


def next_occurrence(due_iso, recurrence):
    """Return the next due datetime (ISO string) after `due_iso`, advancing
    by one `recurrence` interval.

    daily   -> +1 day
    weekly  -> +7 days
    monthly -> +1 calendar month (day clamped to month end)
    every:N -> +N days

    Returns None if `due_iso` doesn't parse or `recurrence` is not a
    recognized repeating value.
    """
    when = _parse(due_iso)
    if when is None or not recurrence:
        return None

    if recurrence == "daily":
        return (when + timedelta(days=1)).isoformat()
    if recurrence == "weekly":
        return (when + timedelta(days=7)).isoformat()
    if recurrence == "monthly":
        return _add_one_month(when).isoformat()
    if isinstance(recurrence, str) and recurrence.startswith("every:"):
        try:
            n = int(recurrence.split(":", 1)[1])
        except ValueError:
            return None
        if n <= 0:
            return None
        return (when + timedelta(days=n)).isoformat()
    return None


def _advance_until_future(due_iso, recurrence, now):
    """Advance a recurring due date by its interval until it lands strictly
    after `now`. Returns the first future due ISO string.

    Used to spawn the next live occurrence of a recurring task that was
    missed: if several intervals elapsed, we skip past all of them.
    """
    nxt = next_occurrence(due_iso, recurrence)
    # Guard against a malformed recurrence that can't advance.
    if nxt is None:
        return None
    while _parse(nxt) <= now:
        following = next_occurrence(nxt, recurrence)
        if following is None or following == nxt:
            break
        nxt = following
    return nxt


# --------------------------------------------------------------------------- #
# Task operations
# --------------------------------------------------------------------------- #

def add_task(data, title, due=None, recurrence=None, now=None):
    """Add a new active task.

    Raises ValueError on an empty/whitespace title, on a non-empty `due`
    string that doesn't parse as an ISO date, or on an unrecognized
    `recurrence`.

    Recurrence requires a due date (a repeating task with no due date makes
    no sense). If a recurrence is given without a due date we raise ValueError.
    """
    title = (title or "").strip()
    if not title:
        raise ValueError("Task title must not be empty")
    if due and _parse(due) is None:
        raise ValueError(f"Invalid due date: {due!r}")
    if not _valid_recurrence(recurrence):
        raise ValueError(f"Invalid recurrence: {recurrence!r}")
    if recurrence and not due:
        raise ValueError("A recurring task must have a due date")
    now = now or datetime.now()
    task = {
        "id": uuid.uuid4().hex,
        "title": title,
        "due": due or None,
        "recurrence": recurrence or None,
        "created": now.isoformat(),
    }
    data["active"].append(task)
    return data


def edit_task(data, task_id, title, due=None, recurrence=None):
    """Update an existing active task in place.

    Applies the same validation rules as add_task (non-empty title,
    parseable due, valid recurrence, recurrence requires a due date).
    Raises ValueError on bad input. An unknown id is a safe no-op.
    """
    title = (title or "").strip()
    if not title:
        raise ValueError("Task title must not be empty")
    if due and _parse(due) is None:
        raise ValueError(f"Invalid due date: {due!r}")
    if not _valid_recurrence(recurrence):
        raise ValueError(f"Invalid recurrence: {recurrence!r}")
    if recurrence and not due:
        raise ValueError("A recurring task must have a due date")

    for task in data["active"]:
        if task["id"] == task_id:
            task["title"] = title
            task["due"] = due or None
            task["recurrence"] = recurrence or None
            break
    return data


def delete_task(data, task_id):
    """Remove a task by id from active, archive, and/or expired.
    Unknown id = no-op.
    """
    data["active"] = [t for t in data["active"] if t["id"] != task_id]
    data["archive"] = [t for t in data["archive"] if t["id"] != task_id]
    if isinstance(data.get("expired"), list):
        data["expired"] = [t for t in data["expired"] if t["id"] != task_id]
    return data


def sort_active(tasks, now=None):
    """Sort active tasks: overdue first (most overdue on top), then soonest
    due, then tasks with NO due date last.
    """
    now = now or datetime.now()

    def key(task):
        when = _parse(task.get("due"))
        if when is None:
            # No due date -> sort to the very end.
            return (2, 0.0)
        delta = (when - now).total_seconds()
        if delta < 0:
            # Overdue: group 0, most overdue (smallest delta) first.
            return (0, delta)
        # Future: group 1, soonest first.
        return (1, delta)

    return sorted(tasks, key=key)


def _spawn_next(task, due_iso, now):
    """Build a fresh active task for the next occurrence of a recurring task.

    New id, the given `due`, same title + recurrence. Returns None if the
    next due can't be computed.
    """
    if not due_iso:
        return None
    return {
        "id": uuid.uuid4().hex,
        "title": task["title"],
        "due": due_iso,
        "recurrence": task.get("recurrence"),
        "created": now.isoformat(),
    }


def refresh(data, completed_ids, now=None):
    """Process the active list:

    - Checked (completed) tasks -> archived (stamped `completed`). A completed
      recurring task ALSO spawns its next occurrence as a new active task.
    - Recurring tasks that are overdue and were NOT completed -> the missed
      occurrence moves to `expired` (stamped `expired_at`), and the next
      future occurrence is spawned into active.
    - Non-recurring overdue tasks stay in active (they remain at the top as
      normal overdue items).

    Finally the remaining active list is re-sorted.
    """
    now = now or datetime.now()
    completed = set(completed_ids or [])
    # Backward compatibility: a store loaded the old way may lack "expired".
    data.setdefault("expired", [])

    still_active = []
    for task in data["active"]:
        recurrence = task.get("recurrence")

        if task["id"] in completed:
            # Completed: archive it, stamping when.
            archived = dict(task)
            archived["completed"] = now.isoformat()
            data["archive"].append(archived)
            # Recurring? Spawn the next occurrence too.
            if recurrence and task.get("due"):
                nxt = next_occurrence(task["due"], recurrence)
                spawned = _spawn_next(task, nxt, now)
                if spawned:
                    still_active.append(spawned)
            continue

        # Not completed. Recurring + overdue means we missed this occurrence:
        # file it under expired and spawn the next future one.
        if recurrence and task.get("due") and is_overdue(task["due"], now=now):
            missed = dict(task)
            missed["expired_at"] = now.isoformat()
            data["expired"].append(missed)
            nxt = _advance_until_future(task["due"], recurrence, now)
            spawned = _spawn_next(task, nxt, now)
            if spawned:
                still_active.append(spawned)
            continue

        # Everything else (future tasks, non-recurring overdue) stays active.
        still_active.append(task)

    data["active"] = sort_active(still_active, now=now)
    return data
