# Task Notes + Subtasks — Design

**Date:** 2026-06-18
**Status:** Approved (brainstorming complete)
**Scope:** First sub-project of a larger "quality-of-life features" effort.
Sequence agreed: **Notes+Subtasks → Markdown in journal → Mood quick-pick →
Today dashboard → Command palette.** This spec covers Notes+Subtasks only.

## Summary

Add two optional fields to a to-do task: a free-text **description (notes)** and
a flat **subtask checklist**. Both are added/edited **after** a task exists, via
an inline dropdown on the active list that expands when the task **title is
clicked** and retracts when the title is clicked again. When collapsed, a task
that has notes and/or subtasks shows a grey `…` hint after its title (plus a
grey `n/m` subtask progress count when subtasks exist). All edits save in the
background (no page reload); the dropdown stays open while you work.

Markdown is explicitly **out of scope** — task notes are plain text. (Markdown is
a separate, later journal feature.)

## Decisions (locked during brainstorming)

1. **Subtask shape:** flat list of `{text, done}`. No per-subtask due dates, no
   nesting, no manual drag-reorder (insertion order only).
2. **Subtask checkboxes:** a *square* variant of the existing circular task
   checkbox — same colors (white border, `#3a3f4a` center, `#3fae5a` checked),
   just `border-radius: 3px` and slightly smaller.
3. **Where added:** only after a task is created (not on the add-new form).
4. **Interaction:** click the task **title** to expand the details dropdown;
   click the title again to retract.
5. **Collapsed hint:** grey `…` after the title when the task has notes and/or
   subtasks; additionally a grey `n/m` progress count when subtasks exist.
6. **Save model:** live/background save via `fetch` to granular JSON endpoints;
   DOM updates in place; dropdown stays open.
7. **Parent completion:** subtasks are **fully independent** of the parent's
   completion. They never auto-complete or gate the parent.
8. **Recurrence:** when a recurring task respawns, the new occurrence copies the
   description and the subtask **text**, with all `done` reset to `False`.
9. **Subtask management:** add, toggle, edit text inline, delete. No reorder.
10. **Archive:** completed tasks show the same click-to-expand dropdown and
    `…`/count hint, but **read-only** (no add/edit/delete/toggle). The **Edit
    page is unchanged** — notes/subtasks are managed only inline on the active
    list.
11. **Endpoint shape:** Approach 1 — one small pure function + one route per
    action.

## Data model

The task dict gains two optional fields:

- `notes`: plain-text string. Default `""`.
- `subtasks`: list of `{"text": str, "done": bool}`. Default `[]`.

`add_task` initializes both (`notes=""`, `subtasks=[]`) on creation. Existing
tasks in `data/tasks.json` lacking the fields are read forgivingly via
`task.get(...)`, so **no migration is required**. No new top-level key is added
to the store, so `load()`/`_empty()` need no changes; the fields live on
individual task dicts inside the existing `active`/`archive`/`expired` lists.

## Pure logic (`todo.py`)

Five new functions, modeled on the existing `set_difficulty` (plain dicts in/out,
no Flask). They operate on the **active** bucket only (notes/subtasks are edited
only while a task is active; archive is read-only):

- `set_task_notes(data, task_id, text)` — set the task's `notes` to the stripped
  `text` (may be `""`). Unknown id = no-op. Returns `data`.
- `add_subtask(data, task_id, text)` — append `{"text": text.strip(), "done":
  False}`. Raises `ValueError` on empty/whitespace text. Unknown id = no-op.
- `toggle_subtask(data, task_id, index)` — flip `done` at `index`. Out-of-range
  index or unknown id = no-op.
- `edit_subtask(data, task_id, index, text)` — replace the text at `index` with
  the stripped `text`. Raises `ValueError` on empty text. Out-of-range/unknown =
  no-op.
- `delete_subtask(data, task_id, index)` — remove the subtask at `index`.
  Out-of-range/unknown = no-op.

Subtasks are addressed by **list index**. To keep the client and server in sync
after deletes (which shift indices), **every mutating route returns the full
updated `subtasks` array**, and the client re-renders the list from that
response rather than mutating its local copy.

### Recurrence (`refresh`)

When `refresh()` spawns the next occurrence of a recurring task, the new task
must:
- copy `notes` verbatim, and
- copy `subtasks` as a **deep copy** with every `done` set to `False`.

Locate the existing spawn/clone point in `refresh()` and extend it. Use a deep
copy so the new occurrence's subtask dicts are independent objects.

## HTTP layer (`app.py`)

Five granular endpoints. These are AJAX endpoints and return **JSON** (like the
existing `/journal/analytics/data` route), not Post/Redirect/Get. Request bodies
are JSON (`request.get_json()`); responses are `jsonify(...)`.

| Method & path | Body | Success response |
|---|---|---|
| `POST /task/<id>/notes` | `{"text": "..."}` | `{"notes": "..."}` |
| `POST /task/<id>/subtasks` | `{"text": "..."}` | `{"subtasks": [...]}` |
| `POST /task/<id>/subtasks/<int:i>/toggle` | — | `{"subtasks": [...]}` |
| `POST /task/<id>/subtasks/<int:i>` | `{"text": "..."}` | `{"subtasks": [...]}` |
| `POST /task/<id>/subtasks/<int:i>/delete` | — | `{"subtasks": [...]}` |

Behavior:
- Load data, call the pure function, `save()`, return the updated slice as JSON.
- Empty/whitespace text on notes is allowed (clears notes); empty text on
  add/edit subtask → the pure function raises `ValueError` → return `400` with a
  short JSON error.
- Unknown task id → `404`.
- Out-of-range subtask index on toggle/edit/delete → `404`. (The pure functions
  themselves are defensive no-ops on a bad index; the route checks
  `0 <= i < len(subtasks)` and returns `404` before/after calling, so the client
  learns its index was stale rather than silently getting an unchanged list.)

Use `DATA_FILE` config exactly as the existing routes do, so tests can point at a
temp file.

## Active-list UI (`templates/active.html`)

- Make the task **title a clickable toggle**: wrap the existing title markup in a
  `.task-title-toggle` element carrying `data-task-id="{{ task.id }}"`,
  `role="button"`, `tabindex="0"`, `cursor: pointer`. The first-tag highlight
  span stays inside it. Tag chips, recur tag, badge, edit link, delete button are
  unchanged and remain outside the toggle.
- After the title, render the collapsed hint markup (shown only when collapsed
  and the task has details):
  - `<span class="detail-hint">…</span>` when `notes` or `subtasks` exist.
  - `<span class="subtask-progress">{done}/{total}</span>` when subtasks exist.
- Add a full-width `.task-details` dropdown as the **last child of the `<li>`**
  (after the existing `.difficulty-picker`), `hidden` by default, containing:
  - a `<textarea class="task-notes">` pre-filled with `notes`,
  - a `<ul class="subtask-list">` of subtask rows, each:
    `<input type="checkbox" class="subtask-check">` (square) + an editable
    `<input type="text" class="subtask-text">` + a `×` delete button
    (`.subtask-del`),
  - an "add subtask" row: `<input class="subtask-add">` + an add button.
  - Carry `data-task-id` and `data-index` attributes as needed for the JS.

**Form-safety:** the active list is one big `<form action="/refresh">`. The
dropdown inputs have **no `name`** that `/refresh` reads, but to prevent an
accidental Enter from submitting the form (which would archive checked tasks),
the JS calls `preventDefault()` on `keydown` Enter inside `.task-details`
(Enter in the add/edit inputs triggers the relevant save instead).

### Styling (`static/style.css`)

- `.task-details`: full-width (`flex-basis: 100%`), hidden via the `hidden`
  attribute (add `.task-details[hidden] { display: none; }` since a `display`
  rule would otherwise override the attribute — same gotcha already handled for
  `.difficulty-picker`). Indent to align under the title like the difficulty
  picker.
- `.subtask-check`: clone `.task-check` (appearance:none, 16px, white 2px border,
  `#3a3f4a` background, `#3fae5a` when `:checked`, amber hover outline) but with
  `border-radius: 3px` instead of `50%`, and slightly smaller than the 18px
  parent circle.
- `.detail-hint` and `.subtask-progress`: `color: var(--muted)`, small font.
- Notes textarea, subtask text inputs, delete button, add row: style to match the
  dark theme (reuse existing input conventions).

## Archive UI (`templates/archive.html`)

Same click-to-expand dropdown and `…`/count hint, rendered **read-only**:
- notes shown as static text (not a textarea),
- subtask checkboxes present but `disabled`, reflecting saved `done` state,
- no add/edit/delete controls.

Add a marker (e.g. `data-readonly` on the list or omit the editable controls) so
the shared JS attaches only expand/collapse, not save handlers. The Edit page
(`edit.html`) is untouched.

## Client JS (`static/task-details.js`)

New vanilla-JS file (no libraries), loaded via `{% block scripts %}` on the
active and archive pages (with `defer`), consistent with the existing
`custom-select.js` / `journal-search.js` pattern. Responsibilities:

- **Toggle:** click (or Enter/Space) on `.task-title-toggle` expands/collapses the
  sibling `.task-details`; updates the collapsed `…`/`n/m` hint visibility.
- **Notes:** `input` on `.task-notes` → debounced (~400ms) `POST .../notes`.
- **Add subtask:** Enter in `.subtask-add` or click the add button →
  `POST .../subtasks` → re-render the list from the returned `subtasks`; clear the
  input; update the progress count.
- **Toggle subtask:** change on `.subtask-check` → `POST .../toggle` → update
  `done` + progress count.
- **Edit subtask:** blur/Enter on `.subtask-text` (when changed) →
  `POST .../subtasks/<i>` → re-render.
- **Delete subtask:** click `.subtask-del` → `POST .../delete` → re-render +
  update count (and hide the hint if no details remain).
- **Enter guard:** `preventDefault()` on Enter within `.task-details`.
- **Read-only mode (archive):** attach expand/collapse only; skip all save
  handlers.

Use plain `fetch` with `Content-Type: application/json`. On a non-OK response,
leave the DOM unchanged (best-effort; no heavy error UI needed for a local app).

## Testing

Follow the repo TDD convention — write tests first; use a fixed `now` and
`tmp_path`; initialize stores with `todo._empty()`.

**`tests/test_todo.py`:**
- `set_task_notes`: sets/clears notes; unknown id no-op.
- `add_subtask`: appends `{text, done:False}`; `ValueError` on empty; unknown id
  no-op.
- `toggle_subtask`: flips `done`; out-of-range no-op.
- `edit_subtask`: replaces text; `ValueError` on empty; out-of-range no-op.
- `delete_subtask`: removes at index; out-of-range no-op.
- `refresh` recurrence: respawned occurrence copies `notes` and copies
  `subtasks` with all `done` reset to `False`; original archived occurrence keeps
  its checked state.

**`tests/test_app.py`:**
- Each endpoint returns the expected JSON shape and persists to the temp data
  file.
- `400` on empty add/edit subtask text; `404` on unknown id (and on bad index for
  toggle/edit/delete).
- Active page renders the title toggle + collapsed hint when details exist;
  archive page renders the read-only dropdown.

## Out of scope (YAGNI)

Markdown in notes; per-subtask due dates/tags; nested subtasks; drag-reorder;
editing notes/subtasks from the Edit page; notes/subtasks on the add-new form;
subtask-driven auto-completion of the parent.
