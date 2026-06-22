# Rich Journal Entries — Inline Formatting + `@mention` Tagging — Design

**Date:** 2026-06-22
**Status:** Approved (brainstorming complete)
**Scope:** Feature #2 of the quality-of-life sequence
(Notes+Subtasks ✅ → **this** → Mood quick-pick → Today dashboard → Command
palette). Journal-only; task notes stay plain text.

## Summary

Two journal-entry capabilities sharing one rendering layer:

1. **Inline text formatting** — Discord-style markup in the entry body:
   `**bold**`, `*italic*`, `__underline__`, `~~strikethrough~~`. The body field
   shows raw markup while focused (a `<textarea>`) and **renders the formatted
   result in place on blur** (click-to-edit); clicking the rendered text returns
   to the textarea.
2. **Inline `@mention` tagging** — typing `@alex` in the body, when "alex" is an
   already-existing tag, (a) highlights the `@alex` text in that tag's section
   color and (b) additively adds the alex tag to the day's entry on save.

No new dependencies. No data-model migration.

## Locked decisions (from brainstorming)

1. **Editing model:** click-to-edit. Body is a `<textarea>` while focused;
   on **blur** it renders formatted+colored text in place; clicking the rendered
   text refocuses the textarea. Rendering is **client-side** (single renderer,
   used for both initial page load and blur).
2. **`@mention` resolution:** a mention highlights/adds **only if it matches an
   already-existing tag**. A never-before-seen name stays plain text (you create
   it once via the section chip UI, then mentions of it work).
3. **What counts as "existing":** permanent tags (`section.tags`), archived tags
   (`section.archived_tags`), **and temporary tags harvested from existing
   entries**. A matched tag is filed under its section **preserving kind** — a
   non-permanent match is added as a *temporary* tag on the entry; mentions never
   auto-promote a tag to permanent.
4. **Formatting tokens (clean set):** `**bold**`, `*italic*` (`*` only — no lone
   `_text_`), `__underline__`, `~~strikethrough~~`. **Nesting of different
   markers** is supported (e.g. `**~~bold strike~~**`); malformed overlaps
   (`**bold _italic** text_`) render literally.
5. **Merge semantics:** union, **non-destructive**. Final entry tags = chip
   selections ∪ body mentions. Removing `@alex` from the prose does not remove
   alex if its chip is still selected, and vice-versa. Mentions are purely
   additive.

## Data model — unchanged

- Entry `body` stays a plain-text string holding the **raw** markup and
  `@mentions` verbatim. Formatting is render-time only.
- Entry `tags` stays `{section_id: [names]}`. Mentions are persisted by unioning
  matched tags into this dict on save.
- No new fields, no new top-level store key → `load()` / `_empty()` unchanged,
  no migration.

## Tag storage facts (context for `@mention` lookup)

- A tag on an entry is a name string under a section id in `entry.tags`.
- **Permanent** = name is in `section.tags` (`is_registered_tag`). **Temporary**
  = on an entry but not in `section.tags` (renders as a dashed chip). Both are
  persisted on the entry; "temporary" is derived, not a separate store.
- Sections also keep `archived_tags` (removed-but-recoverable permanent tags).
- There is **no standalone temporary-tag registry** — temporary tags live only on
  the entries that use them, which is why the lookup below must scan entries.

## Pure logic (`journal.py`) — three new helpers

All pure (plain dicts in/out), no Flask, unit-testable.

### `tag_section_index(data)` → `{normalized_name: section_id}`
Builds the `@mention` lookup. Construction + precedence:
1. Seed with **permanent + archived** tags from every section (these are the
   authoritative "homes"; a registered name's section always wins).
2. Overlay **temporary** tags harvested from `data["entries"]` — for any name not
   already registered, map it to the section it was used under. Iterate entries
   in **ascending date order** so that, for a purely-temporary name used under
   more than one section, the **most-recent** entry's section wins.

Names are compared/stored normalized (`_normalize_name`: strip + lowercase).

### `extract_mentions(body, index)` → `{section_id: [names]}`
- Scan `body` for mention tokens: an `@` at a **word boundary** (start of string
  or preceded by a non-word char — so `a@b.com` does **not** match) followed by
  one or more `[A-Za-z0-9_-]`.
- Normalize each token (`_normalize_name`). Keep only tokens present in `index`;
  drop unknown ones.
- Group kept names by their `index` section id; dedupe within a section,
  preserving first-seen order.
- Limitation (accepted): mention tokens exclude spaces, so multi-word tags are
  not mentionable.

### `merge_entry_tags(base, mentions)` → `{section_id: [names]}`
- Return the **union** of two `{section_id: [names]}` dicts: for each section id,
  concatenate names and dedupe preserving order. Non-destructive — never removes.
- Does not mutate inputs.

## HTTP layer (`app.py`)

### `journal_save` change
After collecting chip/number fields into `base_tags` (existing logic) and before
`upsert_entry`:
```
idx        = journal.tag_section_index(data)
mentions   = journal.extract_mentions(body, idx)
base_tags  = journal.merge_entry_tags(base_tags, mentions)
```
Then `upsert_entry(..., tags=base_tags, ...)` as today. `upsert_entry` already
normalizes/validates names and drops unknown section ids, so merged mentions ride
the existing validation path. Union semantics make this non-destructive across
edits (chips already reflect previously-saved tags; mentions only add).

### Tag-color data for the renderer
Pass a `name → {section_id, color}` map (derived from `tag_section_index` plus
each section's `color` via `section_color`) to `journal_entry.html`, embedded as a
`<script type="application/json" id="mention-index">` block — same pattern as the
search page's embedded JSON. Used client-side to color recognized mentions.

## Templates (`journal_entry.html`)

Replace the bare `<textarea name="body">` with a body-field wrapper:
- the `<textarea name="body" class="body-input">` (raw editing; still posts
  `body` verbatim), and
- a sibling `<div class="body-rendered" hidden>` for the formatted view.
- the embedded `#mention-index` JSON.

On load, JS renders the saved body into `.body-rendered` and shows it (textarea
hidden) when there is content; an empty body starts in the textarea.

## Client JS (new `static/journal-richtext.js`)

Vanilla JS, no libraries, loaded with `defer` via the entry page's
`{% block scripts %}` (alongside `journal.js`). Responsibilities:

**Renderer `render(raw, index)` → safe HTML:**
1. **HTML-escape** the raw text first (so body text can never inject markup).
2. Apply the four markers to the escaped text, supporting nesting of *different*
   markers; malformed overlaps are left literal. Longest-token-first matching so
   `__` (underline) isn't mis-read as two italics and `**` isn't two emphasis.
3. Wrap recognized `@mentions` (tokens whose normalized name is a key in `index`)
   in `<span class="mention-highlight" style="--tag-bg: {color}">@name</span>`,
   reusing the existing translucent `color-mix` highlight convention. The `@` is
   kept in the displayed text. Unknown mentions render as plain literal text.
4. Insert into `.body-rendered` (build via escaped string assigned to
   `innerHTML`, where every dynamic value has been escaped in step 1 / is a
   controlled color).

**Interaction:**
- focus on the field → show `.body-input`, hide `.body-rendered`;
- **blur → `render()` and show `.body-rendered`, hide `.body-input`**;
- click `.body-rendered` → focus `.body-input` (back to raw);
- initial load → render if body non-empty, else show textarea.

The renderer is the single source of truth (no duplicate Python renderer).
Mention *detection* here mirrors the rule in `extract_mentions`; persistence still
happens server-side on save.

## Styling (`static/style.css`)

- `.body-rendered`: match the textarea's font, size, line-height, padding, and
  min-height so the focus/blur swap doesn't shift layout. `cursor: text`.
- `.body-rendered[hidden] { display: none; }` (the `hidden` attribute needs an
  explicit rule when a `display` rule is present — same gotcha already handled
  for `.difficulty-picker` / `.task-details`).
- Formatting elements: `b`/`strong` bold, `i`/`em` italic, `u` underline,
  `s`/`del` line-through — scoped under `.body-rendered`.
- `.mention-highlight`: translucent section-color tint
  (`background: color-mix(in srgb, var(--tag-bg) 35%, transparent)`), normal text
  color, small padding/rounding — consistent with `.title-highlight`.

## Scope notes / unchanged

- **Search page untouched:** it shows titles, not bodies; mentioned tags flow
  through the existing tag filter automatically. Raw markup in the body does not
  break the existing whole-word body text search.
- **Task notes stay plain text** (this feature is journal-only).
- No separate read-only entry page — the click-to-edit field on the entry page is
  the only rendered surface, per the editing model.

## Testing

Repo TDD convention: tests first; fixed `now`; `tmp_path`; init with
`journal._empty()`.

**`tests/test_journal.py`:**
- `tag_section_index`: includes permanent + archived + temporary-on-entry tags;
  registered home wins over scattered temp use; most-recent entry wins for a
  purely-temporary name used under two sections; names normalized.
- `extract_mentions`: matches `@name` at word boundary; does **not** match inside
  `a@b.com`; normalizes case; drops unknown names; groups by section; dedupes.
- `merge_entry_tags`: union across sections; dedupe preserving order; inputs not
  mutated; non-destructive.

**`tests/test_journal_app.py`:**
- Saving an entry whose body mentions an existing tag adds that tag under the
  correct section, **unioned** with chip selections (and non-destructive on a
  re-save where the mention is removed but the chip stays).
- An unknown `@name` in the body adds no tag.
- A temporary tag used on a prior entry is mentionable on a new entry and is added
  as temporary (not promoted to `section.tags`).
- The entry page response embeds the `#mention-index` JSON.

**JS renderer:** no JS unit harness exists in the repo → manual verification
(formatting renders on blur; mentions colored by section; click-to-edit returns
to raw; HTML in body is escaped, not injected).

## Out of scope (YAGNI)

`_text_` italic; markdown beyond the four markers (headings, lists, links, code,
quotes); live WYSIWYG / highlight-overlay editing; auto-creating brand-new tags
from unknown mentions; mention support for multi-word tags; rendering bodies on
the search page; rich text in task notes.
