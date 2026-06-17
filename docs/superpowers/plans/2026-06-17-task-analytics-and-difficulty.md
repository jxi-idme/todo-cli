# Task Analytics + Difficulty Rating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional easy/medium/hard difficulty rating to tasks (set at completion, editable on Archive) and a new "Tasks" tab in `/journal/analytics` holding all task analytics.

**Architecture:** Keep the pure-logic / HTTP split. `todo.py` gains difficulty handling + pure aggregation helpers (unit-tested). The analytics data route merges a raw `tasks` block into the existing payload; `static/analytics.js` aggregates + date-filters tasks client-side and renders via the existing `CHARTS` registry + `U` SVG utilities — exactly how journal charts already work. No new dependencies.

**Tech Stack:** Python 3.12, Flask, Jinja2, vanilla JS (SVG), pytest. JSON file storage.

**Spec:** `docs/superpowers/specs/2026-06-17-task-analytics-and-difficulty-design.md`

## Global Constraints

- **No third-party libraries** (JS or CSS); vanilla JS + SVG only.
- Pure logic in `todo.py` has **zero Flask imports**; time-sensitive functions take an injectable `now=None`.
- Routes use **Post/Redirect/Get** + `flask.flash()` for errors.
- Difficulty values are exactly `{"easy", "medium", "hard"}` (lowercased); anything else = unrated/clear.
- Dark theme via existing CSS vars (`--bg`, `--panel`, `--text`, `--muted`, `--border`, `--accent`, `--accent-dim`, `--danger`); monospace.
- Tests use fixed `now` + `tmp_path`; stores initialized via `todo._empty()` / `journal._empty()`.
- `difficulty` is optional → read with `.get(...)`; **no `load()` migration needed**.

---

## File structure

- **Modify `todo.py`** — difficulty constant + `_norm_difficulty`, `set_difficulty`, `refresh(difficulties=...)`; pure task-analytics helpers; `task_payload`.
- **Modify `app.py`** — `/refresh` captures difficulties; new `POST /archive/<id>/difficulty`; `/journal/analytics/data` merges the `tasks` block.
- **Modify `templates/active.html`** — reveal-on-check difficulty picker inside the refresh form.
- **Modify `templates/archive.html`** — difficulty chip + inline editor.
- **Modify `templates/base.html`** — small inline script toggling each task's picker on check.
- **Modify `static/analytics.js`** — `"tasks"` panel + task chart descriptors.
- **Modify `static/style.css`** — difficulty picker/chip styles; any task-tab chart tweaks.
- **Modify `tests/test_todo.py`**, **`tests/test_app.py`**; **create `tests/test_task_analytics.py`**.

Helpers/patterns to reuse (read these before starting): `todo.refresh` (todo.py ~512), the refresh form (active.html ~59), the archive list (archive.html), the `CHARTS.push({...render})` pattern + `U.*` utilities + `_data`/`_from`/`_to` (static/analytics.js), `journal.analytics_payload` (journal.py ~687).

---

## Task 1: Difficulty in the core (`set_difficulty`, `refresh`)

**Files:**
- Modify: `todo.py`
- Test: `tests/test_todo.py`

**Interfaces:**
- Produces: `todo._DIFFICULTIES` (set), `todo._norm_difficulty(value) -> str|None`, `todo.set_difficulty(data, task_id, difficulty) -> data`, and `todo.refresh(data, completed_ids, difficulties=None, now=None) -> data` (new optional `difficulties` = `{task_id: value}`).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_todo.py — append
def test_norm_difficulty():
    assert todo._norm_difficulty(" Hard ") == "hard"
    assert todo._norm_difficulty("MEDIUM") == "medium"
    assert todo._norm_difficulty("bogus") is None
    assert todo._norm_difficulty("") is None
    assert todo._norm_difficulty(None) is None


def test_refresh_stamps_difficulty_on_completed():
    data = todo._empty()
    todo.add_task(data, "rate me", now=NOW)
    tid = data["active"][0]["id"]
    todo.refresh(data, [tid], difficulties={tid: "hard"}, now=NOW)
    assert data["active"] == []
    assert data["archive"][0]["difficulty"] == "hard"


def test_refresh_ignores_invalid_difficulty_and_missing():
    data = todo._empty()
    todo.add_task(data, "a", now=NOW)
    todo.add_task(data, "b", now=NOW)
    a, b = data["active"][0]["id"], data["active"][1]["id"]
    todo.refresh(data, [a, b], difficulties={a: "nope"}, now=NOW)  # b has none
    arch = {t["title"]: t for t in data["archive"]}
    assert "difficulty" not in arch["a"]      # invalid -> unrated
    assert "difficulty" not in arch["b"]      # not provided -> unrated


def test_refresh_difficulty_not_carried_to_spawned_recurrence():
    data = todo._empty()
    due = NOW.isoformat()
    todo.add_task(data, "daily", due=due, recurrence="daily", now=NOW)
    tid = data["active"][0]["id"]
    todo.refresh(data, [tid], difficulties={tid: "easy"}, now=NOW)
    assert data["archive"][0]["difficulty"] == "easy"
    assert "difficulty" not in data["active"][0]   # fresh occurrence is unrated


def test_set_difficulty_sets_and_clears():
    data = todo._empty()
    todo.add_task(data, "x", now=NOW)
    tid = data["active"][0]["id"]
    todo.refresh(data, [tid], now=NOW)            # archive it (unrated)
    todo.set_difficulty(data, tid, "medium")
    assert data["archive"][0]["difficulty"] == "medium"
    todo.set_difficulty(data, tid, "")            # clear
    assert "difficulty" not in data["archive"][0]
    todo.set_difficulty(data, "ghost", "hard")    # unknown id = no-op (no raise)
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_todo.py -k "difficulty" -q`
Expected: FAIL — `_norm_difficulty`/`set_difficulty` missing; `refresh` has no `difficulties` param.

- [ ] **Step 3: Implement in `todo.py`**

Add near the top (after the existing module constants):

```python
# Allowed task difficulty ratings (set at completion, editable on Archive).
_DIFFICULTIES = {"easy", "medium", "hard"}


def _norm_difficulty(value):
    """Normalize a difficulty to one of _DIFFICULTIES, or None if invalid/empty."""
    v = (value or "").strip().lower()
    return v if v in _DIFFICULTIES else None


def set_difficulty(data, task_id, difficulty):
    """Set or clear a task's difficulty (searches all buckets). A valid value
    (easy/medium/hard) sets it; anything else clears it. Unknown id = no-op."""
    norm = _norm_difficulty(difficulty)
    for bucket in ("archive", "active", "expired"):
        for t in data.get(bucket, []):
            if t.get("id") == task_id:
                if norm:
                    t["difficulty"] = norm
                else:
                    t.pop("difficulty", None)
                return data
    return data
```

Change the `refresh` signature and the completed branch:

```python
def refresh(data, completed_ids, difficulties=None, now=None):
```

Immediately after `completed = set(completed_ids or [])` add:

```python
    difficulties = difficulties or {}
```

In the completed branch (where `archived = dict(task)` / `archived["completed"] = now.isoformat()`), after stamping `completed` and before appending, add:

```python
            diff = _norm_difficulty(difficulties.get(task["id"]))
            if diff:
                archived["difficulty"] = diff
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_todo.py -q`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add todo.py tests/test_todo.py
git commit -m "Add task difficulty: set_difficulty + refresh(difficulties=)"
```

---

## Task 2: Reveal-on-check difficulty picker (active list)

**Files:**
- Modify: `app.py` (the `refresh` route)
- Modify: `templates/active.html`
- Modify: `templates/base.html` (inline toggle script)
- Modify: `static/style.css`
- Test: `tests/test_app.py`

**Interfaces:**
- Consumes: `todo.refresh(data, completed_ids, difficulties=..., now=None)` (Task 1).
- The active form posts checkboxes `name="completed" value="<id>"` and radios `name="difficulty:<id>"`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_app.py — append
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
```

(`_data_path` already exists in `tests/test_app.py`.)

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_app.py -k "difficulty" -q`
Expected: FAIL — route ignores difficulties; no picker markup.

- [ ] **Step 3: Capture difficulties in the `/refresh` route (`app.py`)**

Replace the body of the `refresh()` route with:

```python
@app.route("/refresh", methods=["POST"])
def refresh():
    completed_ids = request.form.getlist("completed")
    # Optional per-task difficulty radios: difficulty:<id> = easy|medium|hard.
    difficulties = {tid: request.form.get("difficulty:" + tid)
                    for tid in completed_ids}
    data = todo.load(data_file())
    todo.refresh(data, completed_ids, difficulties=difficulties)
    todo.save(data_file(), data)
    return redirect(url_for("index"))
```

- [ ] **Step 4: Add the picker to `templates/active.html`**

Inside the refresh `<form>`, within each `<li class="task">`, after the delete button (line ~92, before `</li>`), add:

```html
            {# Difficulty picker — hidden until this task is checked done.
               Optional: no option is selected by default. #}
            <span class="difficulty-picker" hidden>
              <span class="difficulty-prompt">difficulty:</span>
              <label class="kind-toggle-opt"><input type="radio"
                     name="difficulty:{{ task.id }}" value="easy"> easy</label>
              <label class="kind-toggle-opt"><input type="radio"
                     name="difficulty:{{ task.id }}" value="medium"> medium</label>
              <label class="kind-toggle-opt"><input type="radio"
                     name="difficulty:{{ task.id }}" value="hard"> hard</label>
            </span>
```

- [ ] **Step 5: Toggle the picker on check (inline script in `base.html`)**

In `templates/base.html`, inside the existing inline `<script>` (before the closing `</script>` that precedes the deferred script tags), add:

```javascript
    // Reveal a task's difficulty picker only while it's checked done.
    document.querySelectorAll('.task-check').forEach(function (cb) {
      var li = cb.closest('.task');
      if (!li) return;
      var picker = li.querySelector('.difficulty-picker');
      if (!picker) return;
      function sync() {
        picker.hidden = !cb.checked;
        if (!cb.checked) {
          picker.querySelectorAll('input[type="radio"]').forEach(function (r) {
            r.checked = false;  // clearing the check also clears the rating
          });
        }
      }
      cb.addEventListener('change', sync);
      sync();
    });
```

- [ ] **Step 6: Style the picker (`static/style.css`)**

```css
/* ----- task difficulty picker (active list) ----- */
.difficulty-picker {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin-left: 0.5rem;
  font-size: 0.78rem;
}
.difficulty-prompt { color: var(--muted); }
.kind-toggle-opt {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  color: var(--muted);
  cursor: pointer;
}
.kind-toggle-opt input { accent-color: var(--accent); }
.kind-toggle-opt:hover { color: var(--accent); }
```

- [ ] **Step 7: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_app.py -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app.py templates/active.html templates/base.html static/style.css tests/test_app.py
git commit -m "Add reveal-on-check difficulty picker to the active list"
```

---

## Task 3: Difficulty on the Archive page (display + edit)

**Files:**
- Modify: `app.py` (new `POST /archive/<task_id>/difficulty`)
- Modify: `templates/archive.html`
- Modify: `static/style.css`
- Test: `tests/test_app.py`

**Interfaces:**
- Consumes: `todo.set_difficulty(data, task_id, value)` (Task 1).
- Produces: route endpoint name `set_task_difficulty` (`POST /archive/<task_id>/difficulty`, form field `difficulty`).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_app.py — append
def _archive_one(client, title="done"):
    client.post("/add", data={"title": title})
    data = todo.load(_data_path(client))
    tid = data["active"][0]["id"]
    client.post("/refresh", data={"completed": tid})
    return tid


def test_archive_difficulty_edit_sets_value(client):
    tid = _archive_one(client)
    resp = client.post(f"/archive/{tid}/difficulty", data={"difficulty": "medium"})
    assert resp.status_code == 302
    data = todo.load(_data_path(client))
    assert data["archive"][0]["difficulty"] == "medium"


def test_archive_difficulty_edit_clears_value(client):
    tid = _archive_one(client)
    client.post(f"/archive/{tid}/difficulty", data={"difficulty": "hard"})
    client.post(f"/archive/{tid}/difficulty", data={"difficulty": ""})
    data = todo.load(_data_path(client))
    assert "difficulty" not in data["archive"][0]


def test_archive_page_shows_difficulty_control(client):
    _archive_one(client)
    html = client.get("/archive").get_data(as_text=True)
    assert "difficulty-select" in html
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_app.py -k "archive_difficulty or difficulty_control" -q`
Expected: FAIL — route + control missing.

- [ ] **Step 3: Add the route (`app.py`)**

After the `archive()` route add:

```python
@app.route("/archive/<task_id>/difficulty", methods=["POST"])
def set_task_difficulty(task_id):
    data = todo.load(data_file())
    todo.set_difficulty(data, task_id, request.form.get("difficulty", ""))
    todo.save(data_file(), data)
    return redirect(url_for("archive"))
```

- [ ] **Step 4: Add the control to `templates/archive.html`**

Replace the archived task `<li>` body so each row shows a difficulty `<select>` (auto-submits on change) before the delete button. Change the block starting at `<span class="badge">completed {{ task.completed }}</span>`:

```html
          <span class="badge">completed {{ task.completed }}</span>
          <form class="difficulty-form" method="post"
                action="{{ url_for('set_task_difficulty', task_id=task.id) }}">
            <select name="difficulty" class="difficulty-select"
                    onchange="this.form.submit()">
              <option value="" {% if not task.difficulty %}selected{% endif %}>— difficulty —</option>
              {% for opt in ["easy", "medium", "hard"] %}
                <option value="{{ opt }}" {% if task.difficulty == opt %}selected{% endif %}>{{ opt }}</option>
              {% endfor %}
            </select>
          </form>
          <button form="delete-{{ task.id }}" type="submit" class="delete">x</button>
```

(The existing `custom-select.js` will theme this `<select>` automatically.)

- [ ] **Step 5: Style (`static/style.css`)**

```css
/* ----- archive difficulty control ----- */
.difficulty-form { display: inline; }
.difficulty-select { font-size: 0.78rem; padding: 0.15rem 0.4rem; }
```

- [ ] **Step 6: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_app.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app.py templates/archive.html static/style.css tests/test_app.py
git commit -m "Show + edit task difficulty on the Archive page"
```

---

## Task 4: Pure task-analytics aggregation helpers (`todo.py`)

**Files:**
- Modify: `todo.py`
- Test: `tests/test_task_analytics.py` (create)

**Interfaces:**
- Produces (all pure; dates are `YYYY-MM-DD` strings; `start`/`end` inclusive bounds or `None`):
  - `completion_throughput(archive, start=None, end=None) -> {date: count}`
  - `completed_late_count(archive, start=None, end=None) -> {"late": int, "on_time": int}`
  - `expiry_counts(expired, start=None, end=None) -> {date: count}`
  - `recurring_adherence(archive, expired, start=None, end=None) -> {"completed": int, "missed": int}`
  - `difficulty_breakdown(archive, start=None, end=None) -> {"easy","medium","hard","unrated": int}`
  - `task_tag_frequency(tasks, start=None, end=None, date_field="completed") -> {tag: count}`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_task_analytics.py
"""Unit tests for the pure task-analytics helpers in todo.py."""
import todo


def _arch(title, completed, due=None, recurrence=None, tags=None, difficulty=None):
    t = {"id": title, "title": title, "completed": completed, "due": due,
         "recurrence": recurrence, "tags": tags or []}
    if difficulty:
        t["difficulty"] = difficulty
    return t


def test_completion_throughput_counts_by_day_in_range():
    arch = [_arch("a", "2026-06-15T09:00:00"),
            _arch("b", "2026-06-15T18:00:00"),
            _arch("c", "2026-06-16T08:00:00")]
    assert todo.completion_throughput(arch) == {"2026-06-15": 2, "2026-06-16": 1}
    assert todo.completion_throughput(arch, start="2026-06-16") == {"2026-06-16": 1}
    assert todo.completion_throughput(arch, end="2026-06-15") == {"2026-06-15": 2}


def test_completed_late_count():
    arch = [_arch("late", "2026-06-16T10:00:00", due="2026-06-15T10:00:00"),
            _arch("ontime", "2026-06-15T08:00:00", due="2026-06-15T10:00:00"),
            _arch("nodue", "2026-06-15T08:00:00")]            # no due -> ignored
    assert todo.completed_late_count(arch) == {"late": 1, "on_time": 1}


def test_expiry_counts():
    exp = [{"expired_at": "2026-06-15T00:00:00"},
           {"expired_at": "2026-06-15T00:00:00"},
           {"expired_at": "2026-06-17T00:00:00"}]
    assert todo.expiry_counts(exp) == {"2026-06-15": 2, "2026-06-17": 1}


def test_recurring_adherence_completed_vs_missed():
    arch = [_arch("r1", "2026-06-15T09:00:00", recurrence="daily"),
            _arch("once", "2026-06-15T09:00:00")]              # non-recurring ignored
    exp = [{"expired_at": "2026-06-14T00:00:00", "recurrence": "daily"},
           {"expired_at": "2026-06-13T00:00:00"}]              # non-recurring ignored
    assert todo.recurring_adherence(arch, exp) == {"completed": 1, "missed": 1}


def test_difficulty_breakdown():
    arch = [_arch("a", "2026-06-15T09:00:00", difficulty="hard"),
            _arch("b", "2026-06-15T09:00:00", difficulty="easy"),
            _arch("c", "2026-06-15T09:00:00")]                 # unrated
    assert todo.difficulty_breakdown(arch) == {
        "easy": 1, "medium": 0, "hard": 1, "unrated": 1}


def test_task_tag_frequency():
    arch = [_arch("a", "2026-06-15T09:00:00", tags=["work", "home"]),
            _arch("b", "2026-06-16T09:00:00", tags=["work"])]
    assert todo.task_tag_frequency(arch) == {"work": 2, "home": 1}
    assert todo.task_tag_frequency(arch, start="2026-06-16") == {"work": 1}
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_task_analytics.py -q`
Expected: FAIL — helpers undefined.

- [ ] **Step 3: Implement in `todo.py`** (append after the existing functions)

```python
# --------------------------------------------------------------------------- #
# Task analytics (pure aggregation; dates are YYYY-MM-DD; bounds inclusive)
# --------------------------------------------------------------------------- #

def _in_range(date10, start, end):
    if not date10:
        return False
    if start and date10 < start:
        return False
    if end and date10 > end:
        return False
    return True


def completion_throughput(archive, start=None, end=None):
    """{date: count} of tasks completed per day within [start, end]."""
    out = {}
    for t in archive:
        c = t.get("completed")
        d = c[:10] if c else None
        if _in_range(d, start, end):
            out[d] = out.get(d, 0) + 1
    return out


def completed_late_count(archive, start=None, end=None):
    """Among completed tasks that had a due date, count late vs on-time."""
    late = on_time = 0
    for t in archive:
        c, due = t.get("completed"), t.get("due")
        if not c or not due:
            continue
        if not _in_range(c[:10], start, end):
            continue
        if c > due:
            late += 1
        else:
            on_time += 1
    return {"late": late, "on_time": on_time}


def expiry_counts(expired, start=None, end=None):
    """{date: count} of tasks that expired (missed) per day."""
    out = {}
    for t in expired:
        e = t.get("expired_at")
        d = e[:10] if e else None
        if _in_range(d, start, end):
            out[d] = out.get(d, 0) + 1
    return out


def recurring_adherence(archive, expired, start=None, end=None):
    """For recurring occurrences only: completed (archived) vs missed (expired)."""
    completed = sum(
        1 for t in archive
        if t.get("recurrence") and _in_range((t.get("completed") or "")[:10], start, end))
    missed = sum(
        1 for t in expired
        if t.get("recurrence") and _in_range((t.get("expired_at") or "")[:10], start, end))
    return {"completed": completed, "missed": missed}


def difficulty_breakdown(archive, start=None, end=None):
    """Counts of easy/medium/hard/unrated among completed tasks in range."""
    out = {"easy": 0, "medium": 0, "hard": 0, "unrated": 0}
    for t in archive:
        c = t.get("completed")
        if not _in_range(c[:10] if c else None, start, end):
            continue
        out[_norm_difficulty(t.get("difficulty")) or "unrated"] += 1
    return out


def task_tag_frequency(tasks, start=None, end=None, date_field="completed"):
    """{tag: count} across `tasks`; if a bound is given, filter by `date_field`."""
    out = {}
    for t in tasks:
        if start or end:
            v = t.get(date_field)
            if not _in_range(v[:10] if v else None, start, end):
                continue
        for tag in t.get("tags") or []:
            out[tag] = out.get(tag, 0) + 1
    return out
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_task_analytics.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add todo.py tests/test_task_analytics.py
git commit -m "Add pure task-analytics aggregation helpers"
```

---

## Task 5: `tasks` payload block + analytics route merge

**Files:**
- Modify: `todo.py` (`task_payload`)
- Modify: `app.py` (`journal_analytics_data`)
- Test: `tests/test_task_analytics.py`, `tests/test_app.py`

**Interfaces:**
- Produces: `todo.task_payload(data) -> {"active":[...], "archive":[...], "expired":[...], "tags": {name: hex}, "date_range": {"min":..,"max":..}}`. Each task record carries `id, title, created, due, recurrence, tags`; archive adds `completed, difficulty`; expired adds `expired_at`.
- The route adds `payload["tasks"] = todo.task_payload(tdata)` and widens `payload["date_range"]` to cover task dates.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_task_analytics.py — append
def test_task_payload_shape():
    data = todo._empty()
    from datetime import datetime
    now = datetime(2026, 6, 15, 9, 0, 0)
    todo.add_task(data, "open", now=now)
    todo.add_task(data, "done", now=now)
    did = data["active"][1]["id"]
    todo.refresh(data, [did], difficulties={did: "hard"}, now=now)
    p = todo.task_payload(data)
    assert {"active", "archive", "expired", "tags", "date_range"} <= set(p)
    assert p["archive"][0]["completed"][:10] == "2026-06-15"
    assert p["archive"][0]["difficulty"] == "hard"
    assert p["date_range"]["min"] is not None
```

```python
# tests/test_app.py — append
def test_analytics_data_includes_tasks_block(client):
    client.post("/add", data={"title": "open task"})
    resp = client.get("/journal/analytics/data")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert "tasks" in payload
    assert "archive" in payload["tasks"] and "active" in payload["tasks"]
```

(The `tests/test_app.py` `client` fixture must point `JOURNAL_FILE` at a temp path too; it already seeds `DATA_FILE`. If `JOURNAL_FILE` isn't set in that fixture, add `flask_app.config["JOURNAL_FILE"] = str(tmp_path / "journal.json")` so the analytics route doesn't touch the real store.)

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_task_analytics.py::test_task_payload_shape tests/test_app.py::test_analytics_data_includes_tasks_block -q`
Expected: FAIL — `task_payload` missing; payload lacks `tasks`.

- [ ] **Step 3: Implement `task_payload` (`todo.py`, append)**

```python
def task_payload(data):
    """Raw task records for the analytics 'Tasks' tab (JS aggregates + filters)."""
    def base(t):
        return {"id": t.get("id"), "title": t.get("title", ""),
                "created": t.get("created"), "due": t.get("due"),
                "recurrence": t.get("recurrence"), "tags": list(t.get("tags") or [])}

    active = [base(t) for t in data.get("active", [])]
    archive = []
    for t in data.get("archive", []):
        rec = base(t)
        rec["completed"] = t.get("completed")
        rec["difficulty"] = _norm_difficulty(t.get("difficulty"))
        archive.append(rec)
    expired = []
    for t in data.get("expired", []):
        rec = base(t)
        rec["expired_at"] = t.get("expired_at")
        expired.append(rec)

    dates = []
    for t in data.get("archive", []):
        if t.get("completed"):
            dates.append(t["completed"][:10])
    for t in data.get("expired", []):
        if t.get("expired_at"):
            dates.append(t["expired_at"][:10])
    for bucket in ("active", "archive", "expired"):
        for t in data.get(bucket, []):
            if t.get("created"):
                dates.append(t["created"][:10])
    dates.sort()
    date_range = {"min": dates[0], "max": dates[-1]} if dates else {"min": None, "max": None}
    return {"active": active, "archive": archive, "expired": expired,
            "tags": dict(data.get("tags", {})), "date_range": date_range}
```

- [ ] **Step 4: Merge into the route (`app.py`)**

Replace the `journal_analytics_data` route body with:

```python
@app.route("/journal/analytics/data")
def journal_analytics_data():
    """JSON feed for the analytics charts (journal + tasks). Fetched on load and
    on window focus; the client filters by date and renders."""
    payload = journal.analytics_payload(journal.load(journal_file()))
    payload["tasks"] = todo.task_payload(todo.load(data_file()))
    # Widen the shared date range so the date filter spans both domains.
    jr, tr = payload["date_range"], payload["tasks"]["date_range"]
    mins = [d for d in (jr.get("min"), tr.get("min")) if d]
    maxs = [d for d in (jr.get("max"), tr.get("max")) if d]
    payload["date_range"] = {"min": min(mins) if mins else None,
                             "max": max(maxs) if maxs else None}
    return jsonify(payload)
```

- [ ] **Step 5: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_task_analytics.py tests/test_app.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add todo.py app.py tests/test_task_analytics.py tests/test_app.py
git commit -m "Merge raw task payload into the analytics data feed"
```

---

## Task 6: "Tasks" tab + core task charts (`analytics.js`)

**Files:**
- Modify: `static/analytics.js`
- Modify: `static/style.css` (only if a new chart class is needed)

This task is visual; verify by eye. It mirrors the existing journal charts — **read the existing `CHARTS.push({... render})` descriptors and the `U.*` utilities in `analytics.js` first** and copy their style.

- [ ] **Step 1: Register the tab and a task date-filter helper**

In the `PANELS` array add an entry (after `coverage`):

```javascript
    { id: "tasks", label: "Tasks", needs: hasTasks },
```

After the `hasNumeric` function add:

```javascript
  function hasTasks() {
    var t = _data.tasks;
    return !!t && (t.active.length || t.archive.length || t.expired.length);
  }

  // Tasks completed within the active date range, by completed-day.
  function taskThroughput() {
    var out = {};
    (_data.tasks ? _data.tasks.archive : []).forEach(function (t) {
      if (!t.completed) return;
      var d = t.completed.slice(0, 10);
      if ((_from && d < _from) || (_to && d > _to)) return;
      out[d] = (out[d] || 0) + 1;
    });
    return out;
  }
```

- [ ] **Step 2: Add the core task charts**

Append these descriptors in the chart-descriptor section (alongside the others). They reuse `U.svg`, `U.drawBar`, `U.drawLine`, `U.text`, `U.statsRow`, `U.describe`, `U.fmt`, `U.empty` exactly as the journal charts do.

```javascript
  // --- Tasks: completion throughput ---
  CHARTS.push({
    id: "task-throughput", panel: "tasks", title: "Tasks completed per day",
    render: function (container, entries, sections, c) {
      var byDay = taskThroughput();
      var days = Object.keys(byDay).sort();
      if (!days.length) { U.empty(container, "No completed tasks in this range."); return; }
      var w = 600, h = 160, pad = 28;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, days.map(function (d) { return byDay[d]; }));
      var bw = (w - pad) / days.length;
      days.forEach(function (d, i) {
        var bh = (h - pad) * (byDay[d] / max);
        U.drawBar(svg, pad + i * bw, h - pad - bh, Math.max(bw - 2, 1), bh, c.accent);
      });
      container.appendChild(svg);
      var vals = days.map(function (d) { return byDay[d]; });
      var stat = U.describe(vals);
      U.statsRow(container, [["total", vals.reduce(function (a, b) { return a + b; }, 0)],
                             ["best day", stat.max], ["mean/day", U.fmt(stat.mean)]]);
    },
  });

  // --- Tasks: overdue (completed late) + expiry ---
  CHARTS.push({
    id: "task-overdue", panel: "tasks", title: "On-time vs late & expired",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [], expired: [] };
      function inR(d) { return d && (!_from || d >= _from) && (!_to || d <= _to); }
      var late = 0, ontime = 0, expired = 0;
      t.archive.forEach(function (x) {
        if (!x.completed || !x.due) return;
        if (!inR(x.completed.slice(0, 10))) return;
        if (x.completed > x.due) late++; else ontime++;
      });
      t.expired.forEach(function (x) {
        if (inR((x.expired_at || "").slice(0, 10))) expired++;
      });
      if (!(late + ontime + expired)) { U.empty(container, "No due/expired tasks in this range."); return; }
      U.statsRow(container, [["on time", ontime], ["late", late], ["expired", expired]]);
      // simple stacked bar
      var w = 600, h = 40, total = late + ontime + expired, x = 0;
      var svg = U.svg(w, h);
      [["on time", ontime, c.accent], ["late", late, c.danger],
       ["expired", expired, c.muted]].forEach(function (seg) {
        var sw = (w) * (seg[1] / total);
        if (sw > 0) { U.drawBar(svg, x, 8, sw, 20, seg[2]); x += sw; }
      });
      container.appendChild(svg);
    },
  });

  // --- Tasks: recurring adherence ---
  CHARTS.push({
    id: "task-adherence", panel: "tasks", title: "Recurring-task adherence",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [], expired: [] };
      function inR(d) { return d && (!_from || d >= _from) && (!_to || d <= _to); }
      var done = t.archive.filter(function (x) {
        return x.recurrence && inR((x.completed || "").slice(0, 10)); }).length;
      var missed = t.expired.filter(function (x) {
        return x.recurrence && inR((x.expired_at || "").slice(0, 10)); }).length;
      var total = done + missed;
      if (!total) { U.empty(container, "No recurring occurrences in this range."); return; }
      var rate = Math.round((done / total) * 100);
      U.statsRow(container, [["completed", done], ["missed", missed], ["hit rate", rate + "%"]]);
      var w = 600, svg = U.svg(w, 40);
      U.drawBar(svg, 0, 8, w * (done / total), 20, c.accent);
      U.drawBar(svg, w * (done / total), 8, w * (missed / total), 20, c.danger);
      container.appendChild(svg);
    },
  });

  // --- Tasks: difficulty breakdown ---
  CHARTS.push({
    id: "task-difficulty", panel: "tasks", title: "Difficulty of completed tasks",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [] };
      function inR(d) { return d && (!_from || d >= _from) && (!_to || d <= _to); }
      var counts = { easy: 0, medium: 0, hard: 0, unrated: 0 };
      t.archive.forEach(function (x) {
        if (!inR((x.completed || "").slice(0, 10))) return;
        counts[(x.difficulty) || "unrated"]++;
      });
      var order = ["easy", "medium", "hard", "unrated"];
      var max = Math.max.apply(null, order.map(function (k) { return counts[k]; }));
      if (!max) { U.empty(container, "No completed tasks in this range."); return; }
      var w = 600, rowH = 22, svg = U.svg(w, order.length * rowH + 4);
      order.forEach(function (k, i) {
        var y = i * rowH + 2;
        U.text(svg, 70 - 6, y + 14, k, c.text, { anchor: "end", size: 10 });
        var bw = (w - 110) * (counts[k] / max);
        U.drawBar(svg, 70, y + 4, bw, 13, k === "hard" ? c.danger : c.accent);
        U.text(svg, 70 + bw + 4, y + 14, counts[k], c.muted, { size: 9 });
      });
      container.appendChild(svg);
    },
  });

  // --- Tasks: task-tag frequency ---
  CHARTS.push({
    id: "task-tag-frequency", panel: "tasks", title: "Task tag frequency",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [], active: [], expired: [], tags: {} };
      function inR(d) { return !d || ((!_from || d >= _from) && (!_to || d <= _to)); }
      var freq = {};
      t.archive.forEach(function (x) {
        if (!inR((x.completed || "").slice(0, 10))) return;
        (x.tags || []).forEach(function (tag) { freq[tag] = (freq[tag] || 0) + 1; });
      });
      var keys = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
      if (!keys.length) { U.empty(container, "No task tags in this range."); return; }
      var w = 600, rowH = 18, pad = 90, svg = U.svg(w, keys.length * rowH + 6);
      var max = Math.max.apply(null, keys.map(function (k) { return freq[k]; }));
      keys.forEach(function (k, i) {
        var y = i * rowH + 2;
        var col = (t.tags && t.tags[k]) || c.accent;
        U.text(svg, pad - 6, y + 12, k, c.text, { anchor: "end", size: 10 });
        var bw = (w - pad - 30) * (freq[k] / max);
        U.drawBar(svg, pad, y + 3, bw, 11, col);
        U.text(svg, pad + bw + 4, y + 12, freq[k], c.muted, { size: 9 });
      });
      container.appendChild(svg);
    },
  });
```

- [ ] **Step 2 (verify):** Run the app, add + complete a few tasks (some recurring, some with due dates and difficulty), open `/journal/analytics`, click the **Tasks** tab.

Run: `.venv/bin/flask --app app run --port 5055`
Expected: the Tasks tab appears with throughput, on-time/late/expired, adherence, difficulty, and task-tag charts; the shared date filter narrows them; empty states show when filtered to nothing.

- [ ] **Step 3: Run the full suite (no regressions)**

Run: `.venv/bin/python -m pytest -q`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add static/analytics.js static/style.css
git commit -m "Add Tasks analytics tab: throughput, overdue/expiry, adherence, difficulty, tags"
```

---

## Task 7: Cross-domain charts (tasks × journal)

**Files:**
- Modify: `static/analytics.js`

Two more descriptors on the `"tasks"` panel. **Mirror the existing numeric scatter chart and the entry-calendar (month-grid) chart in `analytics.js`** — read them first and copy their structure; only the data mapping differs.

- [ ] **Step 1: Tasks-completed vs. a journal numeric (scatter)**

Add a descriptor `id: "task-numeric-scatter", panel: "tasks", title: "Tasks completed vs. journal number"`:
- For each numeric section (`U.numericSections(_data.sections)`), build per-day pairs: x = that day's `taskThroughput()` count (0 if none), y = the journal entry's numeric value for the section on that day (skip days with no recorded value). Restrict to the active date range.
- Render with the same axis + `U.drawDot` approach the existing numeric correlation scatter uses; show one small multiple per numeric section (like `tag-frequency` iterates sections). Reuse `U.describe` to show a correlation/мean stat if the existing scatter does.
- Empty state when a section has fewer than 2 overlapping days.

- [ ] **Step 2: Entry-day vs. task-completion-day calendar overlay**

Add a descriptor `id: "task-entry-calendar", panel: "tasks", title: "Entries & task completions"`:
- Reuse the month-grid calendar builder used by the journal "Entry calendar" chart (same cell layout/sizing).
- For each day cell, mark whether it had a journal entry (set of `entries[].date` in range) and/or a task completion (keys of `taskThroughput()`): e.g. left half / dot in `c.accent` for entries, right half / dot in `c.accent-dim` (or `--accent-dim`) for task completions; both → full. Include a small legend via `U.text` or a caption.
- Empty state when no entries and no completions in range.

- [ ] **Step 3 (verify):** Reload `/journal/analytics` → Tasks tab. With journal numbers + completed tasks present, the scatter shows points and the calendar shows entry vs completion marks; both honor the date filter.

- [ ] **Step 4: Run the full suite**

Run: `.venv/bin/python -m pytest -q`
Expected: PASS (no Python changed, but confirm nothing broke).

- [ ] **Step 5: Commit**

```bash
git add static/analytics.js
git commit -m "Add cross-domain task charts: tasks-vs-numeric scatter + entry/completion calendar"
```

---

## Task 8: Polish pass + full verification

**Files:**
- Modify: `static/style.css`, `templates/active.html`, `templates/archive.html` (only as needed)

- [ ] **Step 1: Eyeball the touched task views** and fix rough edges only:
  - The active-list difficulty picker should sit cleanly on the task row (wrap gracefully on narrow widths; not crowd the edit/delete controls).
  - The reveal should feel intentional (a subtle `transition` on the picker is fine; keep it minimal).
  - The Archive difficulty `<select>` aligns with the row and themes via `custom-select.js`.
  - The Tasks analytics tab charts are readable and match the dark theme.

- [ ] **Step 2: Full suite + manual smoke**

Run: `.venv/bin/python -m pytest -q` → all pass.
Manual (`.venv/bin/flask --app app run --port 5055`):
- Add tasks, check some done → difficulty picker appears; pick ratings on some, leave others blank; Refresh → archived with the chosen ratings.
- Archive page: change/clear a difficulty via the select.
- Analytics → Tasks tab: all six chart groups render and respond to the date filter.

- [ ] **Step 3: Commit any polish**

```bash
git add -A
git commit -m "Polish task difficulty UI and Tasks analytics tab"
```

---

## Self-review notes

- **Spec coverage:** difficulty model + reveal-on-check (T2) + capture on refresh (T1/T2) + Archive edit (T3); pure helpers (T4); raw `tasks` payload + route merge (T5); single "Tasks" tab with throughput, overdue/expiry, recurring adherence, difficulty, task tags (T6) and cross-domain scatter + calendar overlay (T7); polish (T8). Tags tab stays journal-only (untouched).
- **No-deps / theme / PRG / injectable-now / optional-difficulty-no-migration** constraints honored throughout.
- **Naming consistency:** `_norm_difficulty`, `set_difficulty`, `refresh(..., difficulties=...)`, `completion_throughput`, `completed_late_count`, `expiry_counts`, `recurring_adherence`, `difficulty_breakdown`, `task_tag_frequency`, `task_payload`, route `set_task_difficulty`, JS `hasTasks`/`taskThroughput`, panel id `"tasks"` — used identically across tasks.
