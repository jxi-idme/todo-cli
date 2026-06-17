# Analytics Page Design
**Date:** 2026-06-16  
**Status:** Approved

## Overview

Add a `/journal/analytics` page that visualizes journal data across time. The page is a tab-based single-page view with a shared date range filter. All charts are rendered client-side as vanilla SVG/Canvas from a JSON API endpoint. Charts refresh on every page load and on window focus, so data is always current.

---

## Goals

- Visualize tag frequency, streaks, numeric trends, co-occurrence, and journal consistency
- All charts adapt dynamically to the current sections and tags — nothing is hardcoded by name or count
- Easy to add new charts in future sessions without touching existing code
- Matches the existing dark amber/monospace theme via CSS custom properties

---

## Architecture

Follows the existing pure-logic/HTTP split:

- `journal.py` — new pure aggregation helpers, no Flask imports, all testable
- `app.py` — two new thin routes (render template + JSON endpoint)
- `templates/journal_analytics.html` — tab bar, date filter, panel containers
- `static/analytics.js` — fetch, filtering, chart registry, SVG rendering utilities

---

## Routing

### `GET /journal/analytics`
Renders `journal_analytics.html`. Passes no data — the JS fetches it.  
Adds "Analytics" link to the journal nav in all four existing journal templates: `journal_entry.html`, `journal_search.html`, `journal_sections.html`, `journal_sections_archive.html`.

### `GET /journal/analytics/data`
Returns `jsonify(journal.analytics_payload(data))`. Response shape:

```json
{
  "sections": [
    {
      "id": "abc123",
      "name": "health",
      "type": "tag",
      "color": "#76a5af",
      "tags": ["walked", "ran"],
      "unit": null
    }
  ],
  "entries": [
    {
      "date": "2026-06-15",
      "tags": {"abc123": ["walked"]},
      "numbers": {"def456": 7.5},
      "body": "full body text here",
      "created": "2026-06-15T22:14:00.000000"
    }
  ],
  "date_range": {"min": "2026-06-05", "max": "2026-06-16"}
}
```

Archived sections are excluded from `sections` but their historical data remains in `entries` (entries carry section ids, not names, so no dangling references). `date_range` gives the JS full bounds for the date picker without scanning entries again.

---

## Python Aggregation Helpers (`journal.py`)

All helpers are pure functions. `entries` is a list of entry dicts (already loaded). `start`/`end` are YYYY-MM-DD strings or `None` for no bound. All date filtering is inclusive on both ends.

| Helper | Signature | Returns |
|---|---|---|
| `analytics_payload` | `(data)` | Full API response dict |
| `tag_frequency` | `(entries, section_id, start, end)` | `{tag: count}` |
| `entry_streak` | `(entries)` | `{"current": N, "longest": N, "last_date": "..."}` |
| `tag_streak` | `(entries, section_id, tag)` | `{"current": N, "longest": N}` |
| `numeric_series` | `(entries, section_id, start, end)` | `[{"date": "...", "value": N}, ...]` sorted ascending |
| `date_density` | `(entries, start, end)` | `{"YYYY-MM-DD": 1}` (presence per day) |
| `tag_cooccurrence` | `(entries, section_id, start, end)` | `{tag: {other_tag: count}}` |
| `tag_trend` | `(entries, section_id, tag, start, end)` | `[{"week": "YYYY-Www", "count": N}, ...]` |
| `section_coverage` | `(entries, active_section_ids, start, end)` | `[{"date": "...", "covered": [section_id, ...]}]` |
| `dow_averages` | `(entries, section_id, start, end)` | `{"Mon": avg, "Tue": avg, ...}` |
| `word_counts` | `(entries, start, end)` | `[{"date": "...", "count": N}, ...]` |
| `entry_gaps` | `(entries, start, end)` | `[{"gap_days": N, "after_date": "..."}, ...]` |
| `creation_hours` | `(entries, start, end)` | `{0: count, 1: count, ..., 23: count}` |

`analytics_payload` assembles sections, stripped entries (body text included for JS word count), and `date_range`. It does not call the other helpers — those are called client-side by JS on the fetched data, keeping the server response flat and the aggregation logic testable independently.

---

## Client-Side JS (`analytics.js`)

### Data lifecycle

1. On page load: fetch `/journal/analytics/data`, store as `_data`
2. On window focus: re-fetch if `Date.now() - _lastFetch > 10_000` ms; re-apply current date filter; re-render active tab
3. Date filter change: re-filter `_data.entries` in memory, re-render active tab (no new fetch)

### Chart registry

All charts are declared as entries in a `CHARTS` array. The render loop iterates this array — adding a new chart means appending one descriptor, nothing else changes:

```js
const CHARTS = [
  {
    id: "entry-streak",      // unique id, used as DOM container id
    panel: "overview",       // which tab this chart belongs to
    title: "Entry streak",
    render: (container, entries, sections, colors) => { ... }
  },
  // add new chart here
];
```

### Render arguments (same for every chart)

| Arg | Type | Description |
|---|---|---|
| `container` | `HTMLElement` | The `<div>` to render into (cleared on each render) |
| `entries` | `Array` | Date-filtered entries from `_data.entries` |
| `sections` | `Array` | All sections from `_data.sections` (unfiltered — used for labels/colors) |
| `colors` | `Object` | Live CSS custom properties: `bg`, `text`, `muted`, `border`, `accent`, `danger` |

`colors` is resolved from `getComputedStyle(document.documentElement)` once per render cycle, so charts never hardcode hex values and automatically respect any future theme change.

Section colors come from `sections[i].color` directly — each section's own hex is used for its charts, matching how they appear in the entry form.

### SVG utility functions (defined once, used by all charts)

- `svgEl(tag, attrs)` — creates an SVG element with attributes
- `drawGrid(svg, x, y, w, h, cols, rows, colors)` — background gridlines
- `drawAxis(svg, x, y, w, h, labels, orient, colors)` — X or Y axis with tick labels
- `drawBar(svg, x, y, w, h, value, maxValue, color)` — single bar rect
- `drawLine(svg, points, color, strokeWidth)` — polyline from `[{x,y}, ...]`
- `drawDot(svg, cx, cy, r, color)` — scatter point
- `tooltip(container, svg, text, x, y)` — hover label (absolute-positioned `<div>`)

### Tabs

Five tabs rendered from a static list (with "Numeric" tab conditionally shown only if `sections` contains at least one `type: "numeric"` entry):

- **Overview** — streak stats, summary counters
- **Consistency** — calendar heatmap, word count line, gap histogram, time-of-day bars
- **Tags** — one sub-panel per tag section (frequency bars, trend line, per-tag heatmap, co-occurrence matrix); panels generated from `sections` array
- **Numeric** — one sub-panel per numeric section (line + rolling avg, day-of-week bars, correlation scatter); hidden tab if no numeric sections
- **Coverage** — section coverage grid across all entries

Active tab stored in `_activeTab`. Switching tab re-renders that tab's charts (lazy: charts only render when their tab is visited for the first time, then re-render on data refresh or filter change).

### Date filter

Two `<input type="date">` fields (from/to) initialized to `date_range.min` and `date_range.max` from the API response. A "reset" button restores those defaults. Changes trigger immediate re-filter and re-render of the active tab. Filter state (`_from`, `_to`) persists across tab switches and data re-fetches.

---

## Styling

- Charts inherit the page's monospace font and color scheme via CSS variables — no new CSS variables needed
- Tab bar uses the same pattern as the existing section chip toggle (`.kind-toggle`) for visual consistency
- Active tab highlighted with `--accent`; inactive tabs use `--muted`
- Chart panels are `.analytics-panel` divs (new class, defined in `style.css`) with a `<h3>` title per chart — styled like a bordered dark card matching the existing form/section card pattern
- SVG `<text>` nodes use `font-family: inherit` and `fill` set from the `colors` object
- Empty state (no entries in range, no numeric data): each chart container shows a `--muted` text message rather than a blank box

---

## Testing (`tests/test_journal_analytics.py`)

One test per helper, using `journal._empty()` and hand-built entry fixtures with fixed dates. Covers:
- Empty input returns sensible defaults (no crash, no KeyError)
- Correct counts with a small fixed dataset
- Date range filtering (entries outside range excluded)
- Edge cases: single entry, all entries on the same day, gap of exactly 1 day

Route tests in `tests/test_journal_app.py` (extend existing file):
- `GET /journal/analytics` returns 200
- `GET /journal/analytics/data` returns valid JSON with `sections`, `entries`, `date_range` keys

---

## What does NOT change

- `todo.py`, `style.css`, `journal-search.js`, `journal.js` — untouched
- No new Python dependencies
- No new CSS variables
- Existing journal routes and templates unchanged except nav link addition
