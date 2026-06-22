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

macOS dock app: click **TodoPup** in the dock (Automator app at `/Applications/TodoPup.app`). The server starts as a background daemon and auto-quits ~30 s after the last browser tab is closed. See `SETUP.md` for first-time installation.

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
  tests point at temp files. Also owns the auto-quit watchdog (see below).
- **`start_server.py`** — double-fork daemon launcher used by `TodoPup.command`
  and the Automator dock app. Starts Flask detached from the calling process so
  macOS Shortcuts/Automator exits immediately rather than waiting for Flask.

### Data files

- **`data/tasks.json`** — task store: `active`, `archive`, `expired` (lists of
  tasks), `tags` (name → hex color registry).
- **`data/journal.json`** — journal store: `sections` (list), `entries` (list).

Both use forgiving `load()` (missing keys defaulted, corrupt files backed up to
`.bak`) and atomic `save()` (temp file + `os.replace`). Extend `load()` and
`_empty()` whenever you add a new top-level key or field.

- **`data/server.log`** — Flask stdout/stderr when launched via the dock app.

---

## Todo app features

### Task model

`id` (uuid4 hex), `title`, `due` (ISO 8601 or null), `created`, `recurrence`,
`tags` (list of names), `notes` (plain-text description, default `""`),
`subtasks` (list of `{text, done}`), `difficulty` (`easy`/`medium`/`hard`, or
unset). Archived tasks add `completed`; expired add `expired_at`.

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
- **Difficulty**: optional `easy`/`medium`/`hard` rating (`set_difficulty`). A
  reveal-on-check picker appears under a task when it's checked done on the
  active list (square circular-style radios, click again to deselect); editable
  afterward on the Archive page.
- **Notes + subtasks**: each task has an optional plain-text `notes` description
  and a flat `subtasks` checklist. Both are edited inline via a dropdown that
  expands when the task **title** is clicked; a collapsed task with either shows
  a grey "…" hint plus an `n/m` progress count. Edits save in the background via
  small JSON endpoints (`POST /task/<id>/notes`, `/task/<id>/subtasks`,
  `…/<i>/toggle`, `…/<i>`, `…/<i>/delete`) and re-render in place
  (`static/task-details.js`). Pure helpers: `set_task_notes`, `add_subtask`,
  `toggle_subtask`, `edit_subtask`, `delete_subtask`. Subtasks are independent of
  parent completion; a recurring task's next occurrence copies notes + subtask
  text with all checks reset. Read-only on the Archive page.

### Todo templates

`base.html` (layout, nav, shared JS, flash area, global `confirmModal`),
`active.html`, `archive.html`, `edit.html`, `tags.html`, `_macros.html` (shared
`toggle_url` filter-chip macro).

---

## Journal app features

### Entry model

One entry per calendar date (date is the unique key). Fields: `id` (uuid4 hex),
`date` (YYYY-MM-DD), `title`, `body`, `created`, `updated`,
`tags` (`{section_id: [tag names]}`), `numbers` (`{section_id: float}`),
`mood` (integer 1–7, or null).

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
- **Rich entry body** (`journal-richtext.js`): the body is a `<textarea>` while
  focused and renders formatted text in place on **blur** (click-to-edit). Discord-
  style inline markup: `**bold**`, `*italic*`, `__underline__`, `~~strike~~`
  (nesting of different markers; HTML-escaped first). No third-party libraries.
- **Inline @mention tagging**: an `@name` in the body that matches an existing tag
  (permanent, archived, or a temporary tag used before) is highlighted in that
  tag's section color and added to the day's tags on save (additive, non-
  destructive union with the chips). Underscores match multi-word tags
  (`@alex_dad` → `alex dad`); the rendered highlight drops the `@`. Lookup index
  via `tag_section_index`; parsing via `extract_mentions`; mentions reflect live
  in the chip area on blur (ticking existing chips / injecting temporary ones).
- **Mood** (`journal-mood.js`): an optional **1–7** mood per entry, picked from
  seven Pompompurin GIFs (`static/img/N-pompom.gif`) on the "What happened today"
  line, right-justified. Single-select, click again to deselect; the chosen GIF
  stays full opacity, the others dim. Stored as `mood` on the entry.

### Journal templates

`journal_entry.html` (entry form with calendar, tag chips, numeric inputs, action
row), `journal_search.html` (live search), `journal_sections.html` (section
management), `journal_sections_archive.html` (archived sections & tags).

### Static JS / CSS notes

- **`journal.js`**: calendar widget + move-entry + delete-entry + draft
  protection. Uses `window.confirmModal` (defined globally in `base.html`).
- **`journal-search.js`**: client-side search/filter logic. Search-result tags
  are color-coded by their section (`tag_chips` in `search_index`).
- **`journal-richtext.js`**: click-to-edit body rendering (inline formatting +
  color-coded `@mentions`) and live mention→chip reflection.
- **`journal-mood.js`**: the 7-GIF mood picker (select/deselect, dims the rest).
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

## Auto-quit (dock app mode)

When Flask is started with `AUTO_QUIT=1` (set by `start_server.py`), a
background watchdog thread in `app.py` monitors browser activity:

- `GET /heartbeat` — no-op 204 route; resets the idle timer and arms the watchdog
- Every open browser tab pings `/heartbeat` every 10 s (inline `setInterval` in
  `base.html`)
- If no ping arrives for 30 s after the first one, `os.kill(os.getpid(), SIGTERM)`
  shuts the server down cleanly

The watchdog only activates after the first heartbeat, so the server never
auto-quits before any browser tab has loaded. Tests don't set `AUTO_QUIT=1` so
they are unaffected.

### Related files

- `start_server.py` — double-fork daemon; sets `AUTO_QUIT=1` before `execv`
- `TodoPup.command` — calls `start_server.py`, polls until ready, opens browser
- `docs/automator/document.wflow` — Automator app embedded script (same logic)
- `docs/automator/install.sh` — installs `/Applications/TodoPup.app` from repo
- `SETUP.md` — full setup instructions for a new machine

---

## Roadmap / next steps

The app is a combined **daily journal + to-do** with an analytics-ready data
model (numeric sections stored as floats, entries keyed by stable section ids,
sections soft-deleted for historical continuity).

### Data analytics page — DONE (journal data)

The `/journal/analytics` page is **implemented and shipped** for journal data.
Most analytics functionality is complete; only minor UI polish remains.

What exists today:

- **Routes**: `GET /journal/analytics` (page shell) and
  `GET /journal/analytics/data` (`jsonify(journal.analytics_payload(data))`).
- **Pure aggregation helpers** in `journal.py` (all testable, injectable date
  bounds): `analytics_payload`, `describe`, `tag_frequency`, `tag_cooccurrence`,
  `tag_trend`, `tag_streak`, `entry_streak`, `numeric_series`, `dow_averages`,
  `word_counts`, `entry_gaps`, `creation_hours`, `date_density`,
  `section_coverage`, plus `_filter_entries_by_date`.
- **`static/analytics.js`** — vanilla SVG charts via a `CHARTS` registry
  (add a chart = append one descriptor). Five tabs: Overview, Consistency
  (entry calendar, words/entry, gaps, time-of-day), Tags (frequency, trend,
  per-tag heatmap, co-occurrence), Numeric (line + rolling avg, day-of-week,
  correlation scatter), Coverage. Shared date-range filter; refetches on load
  and on window focus (10s debounce). Colors read from CSS vars + section hex.
- **`templates/journal_analytics.html`** + analytics styles in `style.css`
  (`.analytics-*`, `.chart-svg`/`.chart-svg-fixed`). Tests in
  `tests/test_journal_analytics.py` and route tests in `test_journal_app.py`.

**Remaining: minor UI changes** — small layout/styling polish only.

### Task data in analytics — DONE

The `/journal/analytics` page now has a **Tasks** tab combining to-do data with
journal data: completion throughput over time, overdue/expiry trends, recurring-
task adherence, difficulty breakdown, and task tags — plus cross-domain charts
(tasks-vs-numeric scatter, entry/completion calendar). Pure task-side aggregation
helpers live in `todo.py` (e.g. `completion_throughput`, `difficulty_breakdown`);
the analytics route merges a task payload into the data feed. Built on the same
`CHARTS` registry + SVG utilities in `analytics.js`; no new dependencies.

### Shipped quality-of-life features

Each was spec'd first under `docs/superpowers/specs/` (brainstorm → spec →
subagent implementation, TDD). See the feature sections above for detail:

- **Task notes + subtasks** (inline dropdown on the active list).
- **Rich journal entries** — Discord-style inline formatting + `@mention` tagging.
- **Mood quick-pick** — optional 1–7 per-entry mood via 7 Pompompurin GIFs.

### Future features

Planned additions, in priority order (specs to be written first, as above):

- **Today dashboard** — a combined landing view: tasks due today (with subtask
  progress), today's journal entry + mood, and streak/stat tidbits. Cross-domain;
  reuses `entry_streak`, `today_iso`, and due-date filtering. Likely a new
  `/today` route linked from both navs (purely additive).
- **Command palette (⌘K)** — app-wide fuzzy jump to any page/action, quick-add a
  task, jump to a date.
- **Mood analytics chart** — surface the per-entry mood (1–7) on the analytics
  page via the `CHARTS` registry (mood over time / day-of-week average).
