# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Setup (any machine with Python 3.12+; no extra tools needed)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Run the app (http://127.0.0.1:5001/)
flask --app app run --port 5001

# Tests
pytest                                   # full suite
pytest tests/test_todo.py                # core-logic tests only
pytest tests/test_app.py                 # Flask route tests only
pytest -k time_remaining                 # single test by name substring
```

macOS shortcut: double-click `TodoPup.command` to launch the app and open the browser (its first run bootstraps the venv).

## Architecture

A server-rendered Flask to-do web app with JSON file storage (no database). The
central design rule is a **strict split between pure logic and the HTTP layer**:

- **`todo.py`** — all domain logic, with **zero Flask imports**. Every function
  takes and returns plain dicts/lists, so it's fully unit-testable without a
  server. Time-sensitive functions (`time_remaining`, `is_overdue`,
  `sort_active`, `refresh`, `add_task`, `next_occurrence`) accept an injectable
  `now=None` parameter — this is what makes the tests deterministic. Preserve
  this pattern when adding logic.
- **`app.py`** — thin HTTP layer only: parse the request, call `todo.py`, render
  a template, redirect. All state-changing routes use **Post/Redirect/Get** and
  `flash()` validation errors. The data-file path is `app.config["DATA_FILE"]`
  so tests can point it at a temp file.

### Data model (single JSON file)

One file with top-level keys: `active`, `archive`, `expired` (lists of tasks)
and `tags` (a registry mapping tag name → hex color). A task moving between
states means moving between lists — not a status flag. A task: `id` (uuid4 hex),
`title`, `due` (ISO 8601 or null), `created`, `recurrence`, `tags` (list of
names). Archived tasks add `completed`; expired add `expired_at`.

`load()` is intentionally forgiving and **must stay backward-compatible**: it
defaults missing top-level keys (e.g. a file predating `expired` or `tags`) and
migrates per-task fields, only treating a file as corrupt (backed up to `.bak`)
if it's not a dict or lacks `active`/`archive`. `save()` writes atomically
(temp file + `os.replace`). When you add a new top-level key or task field,
extend the `load()` migration and `_empty()` accordingly.

### Key behaviors

- **Recurring tasks** (`recurrence`: `daily`/`weekly`/`monthly`/`every:N`):
  `refresh()` archives checked tasks (spawning the next occurrence if recurring),
  moves *missed* recurring occurrences to `expired` and spawns the next future
  one, leaves non-recurring overdue tasks in `active`, then re-sorts.
- **Tags**: titles are highlighted in the first tag's color (translucent,
  text-only via `color-mix`); extra tags render as chips. Colors are
  user-picked and validated as hex; tag names are normalized (strip+lowercase)
  and allowlisted (`^[a-z0-9 _-]+$`) — keep that validation, since names flow
  into `style` attributes. Filtering (`?tags=a,b`) is multi-select with OR
  semantics on both the active and archive pages; unknown/stale tags are dropped.
- **Templates**: `base.html` (layout, nav, shared JS, flash area), `active.html`,
  `archive.html`, `edit.html`, `tags.html`, and `_macros.html` (the shared
  `toggle_url` filter-chip macro). `todo.py` helpers `tag_color` and
  `text_color_for` are exposed as Jinja globals.

### Testing convention

Tests are written first. Unit tests use a fixed `now` and pytest's `tmp_path`
for file I/O; route tests use Flask's `test_client()` with a temp `DATA_FILE`.
Initialize test stores with `todo._empty()` rather than a hand-built dict.

## Roadmap / vision

This project is evolving from a pure to-do app toward a combined **daily journal
+ to-do web app**. Expect upcoming features around journaling (e.g. dated
entries, notes, reflections, mood/habit tracking) alongside the existing task
management. When designing new features, favor changes that fit this direction:
keep the pure-logic/HTTP split, extend the JSON model with backward-compatible
`load()` migrations, and build test-first.
