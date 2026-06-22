# Journal Mood Quick-Pick — Design

**Date:** 2026-06-22
**Status:** Approved (brainstorming complete)
**Scope:** Feature #3 of the quality-of-life sequence
(Notes+Subtasks ✅ → Rich journal entries ✅ → **this** → Today dashboard →
Command palette → Mood analytics chart *(new, deferred)*). Journal-only.

## Summary

Add an optional per-entry **mood**: a 7-point scale chosen by clicking one of
seven Pompompurin GIFs. The picker sits on the **"What happened today"** label
line — label left, the seven GIFs right-justified and evenly spaced in the
remaining space, all normalized to one height. Single-select and optional: click
a GIF to select (the other six dim to ~40%), click the selected one again to
deselect. The chosen mood is stored as an integer **1–7** on the entry. **No
analytics in this feature** — a "Mood analytics chart" is tracked separately.

## Locked decisions (from brainstorming)

1. **Assets:** seven GIFs already in `static/img/`: `1-pompom.gif` …
   `7-pompom.gif`. Displayed in order, **1 on the left, 7 on the right**, evenly
   spaced, all resized to the same height.
2. **Placement:** on the `What happened today` label line, filling the space
   **after** the label, **right-justified**.
3. **Selection:** single-select, **optional**. Click to select; click the
   selected one again to deselect.
4. **Selected-state visual:** the selected GIF stays full opacity; the other six
   **dim to ~40%**. **No ring** or other adornment.
5. **Stored value:** integer **1–7** (the GIF's number), or `null` for no mood.
6. **Analytics:** **not** in this feature. Tracked as a new backlog item ("Mood
   analytics chart"). Mood will also surface in the Today dashboard later.

## Data model

- Entry gains `mood`: integer **1–7**, or `null` (default `null`). No new
  top-level store key.
- Add `mood: null` to the per-entry field defaulting in `load()` (alongside the
  existing `tags`/`numbers` defaulting) so every loaded entry has the key.
  Existing entries without it are thus normalized on load; reads are also
  forgiving (`entry.get("mood")`).

## Pure logic (`journal.py`)

- Add a small `_valid_mood(value)` helper: `True` for an int (or int-like) in
  1..7; used for validation.
- `upsert_entry(data, date, title, body, tags=None, numbers=None, mood=None,
  now=None)` — new `mood` parameter:
  - `None` or empty → store `null`.
  - An integer (or int-coercible) in 1..7 → store as `int`.
  - Anything else (non-int-coercible, or out of 1..7) → raise `ValueError`
    (same failure path as an invalid number).
  - Set `mood` on **both** the create branch and the update-existing branch.
- `mood` is a top-level entry field — independent of the `{section_id: ...}`
  tag/number structures.

## HTTP layer (`app.py`)

In `journal_save`:
- Read `mood_raw = request.form.get("mood", "")`. Parse to `int` if non-empty,
  else `None`. (Let `upsert_entry` do the range validation; a non-numeric value
  should also reach the existing `except ValueError` flash path rather than
  500 — coerce defensively: treat a non-int string as invalid via the same
  ValueError flow.)
- Pass `mood=` to `upsert_entry` alongside the existing `tags`/`numbers`.
- Mood is independent of the archived-section merge logic — just parse and pass.
  The hidden input is pre-populated with the saved mood on load, so a normal
  re-save preserves it; clearing the picker posts `""` → `null`.

## Template (`templates/journal_entry.html`)

Replace the bare label line:

```
<p class="label">What happened today</p>
```

with a mood row (inside `#journal-form`):

```
<div class="mood-row">
  <p class="label">What happened today</p>
  <div class="mood-picker{{ ' has-selection' if entry and entry.mood else '' }}">
    {% for n in range(1, 8) %}
      <button type="button" class="mood-opt{{ ' selected' if entry and entry.mood == n else '' }}"
              data-mood="{{ n }}" aria-label="mood {{ n }}">
        <img src="{{ url_for('static', filename='img/%d-pompom.gif'|format(n)) }}" alt="mood {{ n }}">
      </button>
    {% endfor %}
  </div>
  <input type="hidden" name="mood" class="mood-input" value="{{ entry.mood if entry and entry.mood else '' }}">
</div>
```

- `type="button"` so a GIF click never submits the form.
- Server-side `selected`/`has-selection` classes pre-render the saved state (so
  it's correct before JS runs); JS keeps them in sync on interaction.
- The body field (`.body-field`) stays immediately below, unchanged.

## Client JS (new `static/journal-mood.js`)

Vanilla, no libraries, `defer`-loaded via the entry page's `{% block scripts %}`
(alongside `journal.js` and `journal-richtext.js`). Behavior:
- Cache the `.mood-picker`, its `.mood-opt` buttons, and the `.mood-input`.
- Click a `.mood-opt`:
  - if it's already `.selected` → **deselect**: clear the hidden input, remove
    `.selected`, remove `has-selection` from the picker (all GIFs back to full
    opacity);
  - else → **select**: set hidden input to its `data-mood`, move `.selected` to
    it, add `has-selection` to the picker.
- On load, reconcile from the hidden input's value (defensive; the template
  already pre-renders the classes).
- No ring; the dim effect is pure CSS driven by the `has-selection`/`selected`
  classes.

## Styling (`static/style.css`)

- `.mood-row`: `display: flex; align-items: center; justify-content: space-between;
  gap: 1rem;` — label left, picker right. (The hidden input is non-rendering.)
- `.mood-picker`: `display: flex; align-items: center; justify-content: flex-end;
  gap: ~0.75rem;` — right-justified, evenly spaced (tune the gap so all seven sit
  comfortably in the space after the label without wrapping).
- `.mood-opt`: button reset — `background: none; border: none; padding: 0;
  cursor: pointer; line-height: 0;`.
- `.mood-opt img`: fixed `height: ~32px; width: auto; display: block;` so all
  seven match height regardless of source dimensions.
- Dim rule: `.mood-picker.has-selection .mood-opt:not(.selected) { opacity: 0.4; }`
  with a short `transition: opacity 0.15s ease;` on `.mood-opt`. Selected and
  no-selection states stay full opacity. **No ring/outline/scale.**
- Optional subtle hover (e.g. full opacity on hover) is fine but not required.

## Scope / unchanged

- Mood is stored and shown **only on the entry form** for now.
- **No** analytics, search-result, or dashboard surfacing in this feature — those
  arrive via the new "Mood analytics chart" backlog item and the Today dashboard
  (feature #4).
- Task side untouched; journal-only.

## Testing

Repo TDD convention: tests first; fixed `now`; `tmp_path`; init via
`journal._empty()` / `_seeded()`.

**`tests/test_journal.py`:**
- `upsert_entry` stores a valid `mood` (e.g. 5) on create and on update.
- `mood=None` / omitted → stored as `null`.
- Out-of-range (0, 8) and non-int-coercible values raise `ValueError`.
- `mood` is preserved when updating an entry that already has one (and can be
  changed / cleared).
- `load()` migration: an entry persisted without `mood` gains `mood: null`.

**`tests/test_journal_app.py`:**
- Saving an entry with `mood=4` persists it (visible via the store / re-render).
- Posting `mood=""` stores `null`; posting an invalid mood (e.g. `9` or `abc`)
  hits the graceful flash path, not a 500.
- The entry GET page renders the 7-GIF picker; for a saved mood it pre-applies
  `selected` to the right option and `has-selection` to the picker.

**JS picker behavior** (select/dim/deselect) has no JS harness in the repo →
manual verification (I'll flag it).

## Out of scope (YAGNI)

Mood analytics/charts; mood in search results or the dashboard (future features);
mood labels/tooltips beyond `alt="mood N"`; multi-select; required mood;
animating the selection beyond the opacity fade.
