# Tag pages / backlinks — design spec

**Date:** 2026-06-26
**Status:** Approved, ready for implementation plan
**Feature family:** combined journal + to-do, cross-domain analytics

## Summary

Turn tags from passive filters into first-class entities. Clicking a tag anywhere
it is shown opens a **lightweight popup** with a condensed, *unified* overview of
that tag across both the task and journal sides. The popup's **Expand →** button
deep-links to a new **Tag** tab on the analytics page, which shows the full deep
view. The analytics page also gains a top-right **`Journal | Task` lens toggle**
that swaps the deeper tabs between a journal lens and a task lens; the Tag detail
view follows the lens, while the popup stays unified.

This exploits the app's real differentiator — a single combined store of journal +
tasks + per-entry mood — so a tag like `work` can show its task throughput/lead-time
*and* its journal mood trend under one name.

## Background: the two tag namespaces

Tags live in two structurally separate places that may share a name:

- **Task tags** — a flat list with a name→hex color registry at `data["tags"]` in
  `tasks.json`. Tasks live in `active` / `archive` / `expired`; each has a `tags`
  list. Archived tasks carry `completed`; all carry `created` and optional `due`.
- **Journal tags** — scoped *per section*. `entry["tags"]` is `{section_id: [names]}`.
  The section owns the color. Entries carry `date`, `mood` (1–7 or null), `numbers`,
  `body`.

The feature **unifies by name** (one `work` page merges both), but **marks each
occurrence's origin** so the two are never confused.

## User-facing design

### 1. The quick popup (unified, origin-marked)

A floating popover anchored to the clicked tag. Closes on outside-click, a corner
**×**, or Escape. Contents (condensed), rendered from `/tag/<name>/overview`:

- **Header**: tag name + origin marks (see §"Origin marks").
- **Stat strip**: total uses, active / done tasks, # journal entries, avg mood with
  a ▲/▼ uplift (e.g. `▲ +0.6`), task lead-time (e.g. `~2d early`).
- **Tiny mood sparkline** — a self-contained inline SVG (~10 lines; popup.js does
  not depend on analytics.js).
- **Top 3 co-occurring tags** — small chips, origin-marked.
- **~5 most-recent timeline rows** — merged reverse-chronological across both
  domains, each row origin-marked and dated.
- **Footer**: **Expand →** (deep-links to `/journal/analytics#tag=<name>`).

The popup is the **unified cross-domain glance**: it always shows both task and
journal data, regardless of any analytics lens.

### 2. Entry points (where the popup triggers)

Exactly two surfaces in v1:

- **Archive page (`archive.html`)** — task side. Today the first tag shows only as
  the task title's highlight color (its name is not visible) and `tags[1:]` render
  as `.tag-chip` spans. Change: render **every** tag as a named chip beside the
  task title, each a popup trigger. The first-tag title highlight stays as a color
  cue; all tag *names* become explicit, clickable chips.
- **Journal search (`journal_search.html`)** — journal side. The **result tag chips**
  (`.entry-tag-chip`) on each search result become popup triggers. The filter-
  dropdown checkboxes keep their existing filtering behavior, untouched.

Deferred (easy to add later): active task list, analytics chart labels, sections
manage page.

### 3. The deep view: analytics restructure

The analytics page (`/journal/analytics`) gains a top-right segmented toggle:

```
Journal | Task
```

- **Overview** is always shown and sits **outside** the toggle — it is the shared,
  cross-domain home (headline stats for both sides, the cross-domain charts —
  mood-vs-task-completion, tasks-vs-numeric scatter, entry/completion calendar —
  and insights). *Overview content is unchanged in this work; a separate follow-up
  will upgrade it.*
- The toggle swaps the deeper lens tabs:

| Lens | Tabs |
|---|---|
| Shared (always) | **Overview** |
| **Journal** | Mood · Consistency · Tags · Numeric · Coverage · **Tag** |
| **Task** | Throughput · Timeliness · Adherence · Difficulty · Task tags · **Tag** |

The current single, overloaded **"Tasks"** tab is **refactored** into the Task
lens (its charts become the Task-lens sub-tabs). No task chart is lost.

### 4. The Tag detail tab (lens-aware)

A dedicated tab with bespoke interaction, so it gets its own `renderTagDetail()`
rather than going through the homogeneous `CHARTS` loop.

- **Search box** on top: a text input + `<datalist>` of all known tag names
  (task tags + section tags). Selecting/typing a tag fetches and renders it.
- Renders the **half of the payload matching the current lens**:
  - **Journal lens**: header stats (entries, first/last, avg mood, uplift),
    full journal timeline (entry rows link to `/journal/<date>`),
    mood-when-present trend + rolling avg, journal day-of-week bars, journal
    co-occurrence bars.
  - **Task lens**: header stats (active/done/expired, lead-time), task timeline,
    lead-time callout, completion throughput for the tag, task co-occurrence bars.
- On load, analytics.js reads `#tag=<name>` from the URL hash, opens the Tag tab,
  and pre-fills the search. Refetches on tag change and on date-range change.

At the deep level, the **lens toggle itself is the journal/task separation**, so a
single deep view never mixes the two; the unified view lives only in the popup.

### 5. Origin marks

Unified under one name, every occurrence marked by origin:

- **Task** occurrence → a leading **☑** glyph (monospace, theme-consistent).
- **Journal** occurrence → a leading **●** dot in that **section's color**.

In the popup, rows also group under **Tasks** / **Journal · <section>** subheaders,
so mark *and* grouping both differentiate.

## Data layer (pure helpers — TDD, the core of the work)

Per the codebase's zero-cross-import rule between domain modules, each domain
computes its own side and the **route merges**. Each helper takes plain
dicts/lists and an injectable date range, mirroring the existing analytics helpers.
Tag matching is case-insensitive (tags are already normalized lowercase).

### `journal.tag_overview(data, name, start=None, end=None)`

Scans every entry's `{section_id: [names]}`. Returns:

- `sections`: `[{id, name, color}]` — sections where the name appears.
- `entries`, `first`, `last`.
- `avg_mood`, `baseline_mood` (mean mood over all entries in range), `uplift`
  (`avg_mood − baseline_mood`); all mood aggregations ignore null moods.
- `mood_series`: `[{date, mood}]` for tagged entries that have a mood, date-sorted.
- `dow`: 7 counts Mon–Sun (mirrors `dow_averages` shape).
- `cooccurring`: `[{name, section_id, count}]` — other tags on the same entries.
- `timeline`: `[{date, snippet, sections, mood}]` for entries carrying the tag.

### `todo.tag_overview(data, name, start=None, end=None)`

Scans `active` / `archive` / `expired`. Returns:

- `exists` (name is in the `data["tags"]` registry), `color`.
- `active`, `completed`, `expired` counts; `first`, `last`.
- `lead_time_days`: mean of `due − completed` over completed tasks that had a due
  date. **Positive = finished early.** Null when no such tasks.
- `cooccurring`: `[{name, count}]` — other task tags on the same tasks.
- `timeline`: `[{date, title, status, due, completed}]`.

## HTTP layer

```
GET /tag/<name>/overview  →  jsonify({
   "name":    name,
   "task":    todo.tag_overview(todo.load(data_file()), name, start, end),
   "journal": journal.tag_overview(journal.load(journal_file()), name, start, end),
})
```

Thin HTTP layer mirroring `journal_analytics_data`. Reads optional `?from=&to=`
and passes them through. The popup omits the range; the deep Tag tab sends its
current range. Unknown tag → 200 with empty-ish payload (zero counts, empty lists).

## Front-end components

### `static/tag-popup.js` (new, loaded app-wide via `base.html`)

- A single delegated `document` click listener on the popup-trigger attribute.
- **Collision fix**: the journal search filter checkboxes already use `data-tag`
  for filtering. The popup triggers on a **dedicated attribute** —
  `data-tagpop="<name>"` (a `.tag-pop-trigger` class) — so it never hijacks the
  existing filter `data-tag` behavior.
- On click: fetch `/tag/<name>/overview`, render the anchored popover (flips near
  viewport edges), wire ×/outside-click/Escape to close, and wire **Expand →** to
  navigate to `/journal/analytics#tag=<name>`.
- Self-contained mini sparkline; no dependency on analytics.js.

### `static/analytics.js` (modified)

- Add the **`Journal | Task` lens toggle** state; `Overview` always renders;
  lens-specific PANELS are filtered by the active lens.
- **Refactor** the existing single "Tasks" tab charts into Task-lens sub-tabs.
- Add the **Tag** panel with a dedicated `renderTagDetail()` (search + async
  per-tag fetch + lens-aware rendering), reusing the existing `U.*` SVG utilities
  and the mood-over-time pattern. Read `#tag=<name>` from the hash on load.

### Templates / CSS (modified)

- `templates/base.html` — load `tag-popup.js` app-wide; provide a popup
  container/portal element.
- `templates/archive.html` — render all task tags as named `.tag-pop-trigger`
  chips beside the title.
- `static/journal-search.js` — mark result `.entry-tag-chip` chips as
  `.tag-pop-trigger` (`data-tagpop`).
- `static/style.css` — popup styles (`.tag-pop*`), origin marks, the lens toggle,
  and Tag-detail tab styles.
- `CLAUDE.md` — document the new route, helpers, files, lens toggle, and behaviors.

## Testing

Heavy logic lives in Python (tested); JS stays presentational, consistent with the
existing `analytics.js` (no JS test harness in this repo).

- `tests/test_journal.py` → `journal.tag_overview`: sections list, counts,
  avg/baseline/uplift mood, dow, co-occurrence, timeline order, date filtering,
  case-insensitivity, unknown/empty tag.
- `tests/test_todo.py` → `todo.tag_overview`: cross-bucket counts, `lead_time_days`
  sign (early = positive), co-occurrence, timeline, unknown tag.
- `tests/test_app.py` → `GET /tag/<name>/overview`: returns merged JSON with
  `task` + `journal` keys; honors `?from=&to=`; unknown tag → 200 empty-ish.

Use `todo._empty()` / `journal._empty()` to initialize stores; use a fixed `now`
and `tmp_path`, per the project's TDD convention.

## Files touched

New: `static/tag-popup.js`,
`docs/superpowers/specs/2026-06-26-tag-pages-backlinks-design.md`.

Modified: `journal.py`, `todo.py`, `app.py`, `static/analytics.js`,
`templates/base.html`, `templates/archive.html`, `static/journal-search.js`,
`static/style.css`, `CLAUDE.md`, `tests/test_journal.py`, `tests/test_todo.py`,
`tests/test_app.py`.

## Out of scope (explicit)

- **Overview upgrade** — Overview stays as-is in this work; a separate follow-up
  will upgrade it.
- **Additional popup entry points** — active task list, analytics chart labels,
  and the sections manage page are deferred.
- **Cross-domain co-occurrence** (a task tag co-occurring with a journal tag) — out
  of scope; co-occurrence is computed within each domain and origin-marked.
