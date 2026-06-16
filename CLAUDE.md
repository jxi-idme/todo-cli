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
pytest tests/test_journal.py             # journal logic tests only
pytest tests/test_journal_app.py         # journal route tests only
pytest -k time_remaining                 # single test by name substring
```

macOS shortcut: double-click `TodoPup.command` to launch the app and open the browser (its first run bootstraps the venv).

## Architecture

A server-rendered Flask web app with JSON file storage (no database). The central
design rule is a **strict split between pure logic and the HTTP layer**:

- **`todo.py`** — all task domain logic, zero Flask imports. Every function takes
  and returns plain dicts/lists. Time-sensitive functions accept an injectable
  `now=None` parameter for deterministic testing.
- **`journal.py`** — all journal domain logic, zero Flask imports. Same pattern as
  `todo.py`. Imports only `todo.py`'s pure validators (`_HEX_COLOR_RE`,
  `_TAG_NAME_RE`) so hex/name validation has a single source of truth.
- **`app.py`** — thin HTTP layer only: parse request, call domain module, render
  template, redirect. All state-changing routes use **Post/Redirect/Get** and
  `flash()` for validation errors. Config keys `DATA_FILE` and `JOURNAL_FILE` let
  tests point at temp files.

### Data files

- **`data/tasks.json`** — task store: `active`, `archive`, `expired` (lists of
  tasks), `tags` (name → hex color registry).
- **`data/journal.json`** — journal store: `sections` (list), `entries` (list).

Both use forgiving `load()` (missing keys defaulted, corrupt files backed up to
`.bak`) and atomic `save()` (temp file + `os.replace`). Extend `load()` and
`_empty()` whenever you add a new top-level key or field.

---

## Todo app features

### Task model

`id` (uuid4 hex), `title`, `due` (ISO 8601 or null), `created`, `recurrence`,
`tags` (list of names). Archived tasks add `completed`; expired add `expired_at`.

### Core behaviors

- **Recurring tasks** (`recurrence`: `daily`/`weekly`/`monthly`/`every:N`):
  `refresh()` archives checked tasks (spawning the next occurrence if recurring),
  moves missed recurring occurrences to `expired` and spawns the next future one,
  leaves non-recurring overdue tasks in `active`, then re-sorts.
- **Tags**: titles are highlighted in the first tag's color (translucent,
  text-only via `color-mix`); extra tags render as chips. Colors are user-picked
  hex; tag names are normalized (strip+lowercase) and allowlisted
  (`^[a-z0-9 _-]+$`) — names flow into `style` attributes so keep that
  validation. Filtering (`?tags=a,b`) is multi-select OR semantics on active and
  archive pages; unknown/stale tags are dropped silently.
- **Archive**: completed tasks move here. Accessible via `/archive`.

### Todo templates

`base.html` (layout, nav, shared JS, flash area, global `confirmModal`),
`active.html`, `archive.html`, `edit.html`, `tags.html`, `_macros.html` (shared
`toggle_url` filter-chip macro).

---

## Journal app features

### Entry model

One entry per calendar date (date is the unique key). Fields: `id` (uuid4 hex),
`date` (YYYY-MM-DD), `title`, `body`, `created`, `updated`,
`tags` (`{section_id: [tag names]}`), `numbers` (`{section_id: float}`).

### Section model

Sections are user-configurable categories that appear on every entry form.
Fields: `id` (uuid4 hex), `name`, `type` (`"tag"` or `"numeric"`), `color` (hex),
`tags` (permanent tag list), `archived_tags` (removed-but-recoverable tags),
`unit` (label for numeric sections, e.g. `"hrs"`), `archived` (soft-delete bool).

Six default tag sections are seeded on first run: people, places, food, chores,
health, work.

### Journal routes

| Route | Purpose |
|---|---|
| `GET /journal` | Today's entry form |
| `GET /journal/<date>` | Entry form for a specific date |
| `POST /journal/save` | Create or update an entry |
| `POST /journal/entry/<id>/move` | Move an entry to a different date |
| `POST /journal/entry/<id>/delete` | Delete an entry |
| `GET /journal/search` | Live search tab (text + tags + numeric range) |
| `GET /journal/sections` | Manage sections & tags |
| `POST /journal/sections/add` | Add a new section |
| `POST /journal/sections/<id>/edit` | Rename, recolor, or update unit |
| `POST /journal/sections/<id>/delete` | Soft-archive a section |
| `POST /journal/sections/<id>/restore` | Un-archive a section |
| `POST /journal/sections/<id>/tags` | Add a permanent tag |
| `POST /journal/sections/<id>/tags/<tag>/delete` | Archive a permanent tag |
| `POST /journal/sections/<id>/tags/<tag>/restore` | Restore an archived tag |
| `GET /journal/sections/archive` | View archived sections and tags |

### Key journal behaviors

- **One entry per date**: `upsert_entry` creates or updates; date is the key.
- **Permanent vs temporary tags**: tags added via the entry form can be marked
  permanent (added to the section's master list) or temporary (on the entry only).
  Temporary tags render as dashed chips on the edit form.
- **Archived data preservation**: editing an entry never drops data for sections
  that were archived after the entry was written (merged in `journal_save`).
- **Archived tags**: removing a tag from the master list moves it to
  `archived_tags` (not deleted). Re-adding it via the normal form or the archive
  restore route moves it back. Tags are case-insensitive throughout.
- **Calendar widget**: custom dark calendar (`journal.js`) on the entry form shows
  entry dots, supports date navigation, draft-loss protection, and move-to-date
  mode. No third-party libraries.
- **Live search** (`journal-search.js`): entries embedded as JSON; filters in the
  browser. Text filter: whole-word AND across body+title. Tag filter: OR across
  selected tags. Numeric filter: per-section range sliders (bounds auto-derived
  from recorded values). All three combine with AND.
- **Section management**: add tag or numeric sections, rename, recolor, set unit
  label, soft-delete (archive). Archive link is right-justified on the manage page
  title row — not in the nav.

### Journal templates

`journal_entry.html` (entry form with calendar, tag chips, numeric inputs, action
row), `journal_search.html` (live search), `journal_sections.html` (section
management), `journal_sections_archive.html` (archived sections & tags).

### Static JS / CSS notes

- **`journal.js`**: calendar widget + move-entry + delete-entry + draft
  protection. Uses `window.confirmModal` (defined globally in `base.html`).
- **`journal-search.js`**: client-side search/filter logic.
- **`style.css`**: shared dark amber/monospace theme. CSS variables in `:root`:
  `--panel`, `--text`, `--muted`, `--border`, `--accent` (#e0a955 amber),
  `--danger` (#e0524d red). All `<select>` elements use a custom SVG caret
  (`appearance: none`) matching the dark theme. The permanent/temporary tag kind
  picker is a `.kind-toggle` segmented radio control (not a `<select>`).
- **`confirmModal`** is a global Promise-based dark modal defined in `base.html`'s
  inline script. Any `button[data-confirm="message"]` is auto-wired to it.
  Available as `window.confirmModal(message, confirmLabel)` from any page script.

---

## Testing convention

Tests are written first (TDD). Unit tests use a fixed `now` and pytest's
`tmp_path` for file I/O; route tests use Flask's `test_client()` with a temp
data file. Initialize stores with `todo._empty()` / `journal._empty()` rather
than hand-built dicts. Preserve the injectable `now` pattern in any new
time-sensitive logic.

---

## Roadmap / next steps

The app is a combined **daily journal + to-do** with an analytics-ready data
model (numeric sections stored as floats, entries keyed by stable section ids,
sections soft-deleted for historical continuity).

### Next: Data analytics page

Add a `/journal/analytics` page that visualizes journal data across time. Ideas:

- **Line / bar charts** per numeric section (e.g. sleep hours over 30/90 days)
- **Tag frequency** charts — how often each permanent tag appears across entries
- **Streak / habit tracking** — consecutive days with entries, or with a specific
  tag checked
- **Numeric correlations** — scatter plots between two numeric sections
- **Calendar heatmap** — entry density or a chosen numeric value overlaid on a
  calendar grid
- **Filterable date range** — all charts respond to a shared date-range picker

Implementation notes: data is available from `journal.search_index(data)` and
`journal.numeric_bounds(data)`; extend `journal.py` with aggregation helpers as
needed (pure, testable). Render charts client-side (e.g. Chart.js or a lightweight
SVG approach) from JSON embedded in the page, keeping the pure-logic/HTTP split.
No new dependencies required if using vanilla SVG/Canvas; Chart.js is an
acceptable single addition if richer chart types are needed.
