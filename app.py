"""Flask web layer for the to-do app.

This is intentionally thin: routes parse the request, call into todo.py for
all the real work, save, and redirect. State-changing routes follow the
Post/Redirect/Get pattern so a browser refresh never re-submits a form.
"""

import os

from flask import Flask, flash, redirect, render_template, request, url_for

import journal
import todo

app = Flask(__name__)

# Needed so flask.flash() can sign the session cookie that carries flashed
# messages. A constant is fine for this small local single-user app; a real
# deployment would load a random secret from config/an environment variable
# (e.g. os.environ["SECRET_KEY"]) and never hard-code it.
app.secret_key = "local-dev-todo-pup-not-secret"

# Default data file lives in data/tasks.json, but tests override this via
# app.config["DATA_FILE"] so they can use a temp file.
app.config["DATA_FILE"] = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "tasks.json"
)


def data_file():
    return app.config["DATA_FILE"]


# Journal store lives alongside tasks; tests override via JOURNAL_FILE.
app.config["JOURNAL_FILE"] = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "journal.json"
)


def journal_file():
    return app.config["JOURNAL_FILE"]


def _recurrence_from_form(form):
    """Turn the recurrence dropdown (+ custom N) into a stored value.

    The form sends `recurrence` as one of "", "daily", "weekly", "monthly",
    or "custom". For "custom" we read the `custom_n` number and build
    "every:N". Anything empty/None means non-recurring.
    """
    choice = form.get("recurrence") or ""
    if choice == "custom":
        n = (form.get("custom_n") or "").strip()
        return f"every:{n}" if n else "every:"   # invalid -> let core reject
    return choice or None


def _selected_tags(arg):
    """Parse a comma-separated tags query string into a clean list of names.

    Used for the `?tags=` filter; blanks are dropped and order preserved.
    """
    return [t.strip().lower() for t in (arg or "").split(",") if t.strip()]


def _tags_with_new(form, data):
    """Collect the task's tags from the add/edit form and register any new tag.

    Reads the `tags` checkboxes (existing tags) plus an optional `new_tag`
    name + `new_tag_color`. If a new tag name is given, its color is
    registered via set_tag_color (which validates and may raise ValueError),
    and the name is appended to the list. Returns the combined tag-name list.
    """
    tags = list(form.getlist("tags"))
    new_name = (form.get("new_tag") or "").strip()
    if new_name:
        # Validate + register the color first; this raises on a bad color or
        # name so the whole add/edit is rejected (consistent with title/due
        # handling). set_tag_color normalizes (strip+lower) the key it stores,
        # so append the SAME normalized form here -- otherwise the task could
        # carry "Urgent" while the registry key is "urgent".
        color = (form.get("new_tag_color") or "").strip()
        todo.set_tag_color(data, new_name, color)
        tags.append(new_name.lower())
    return tags


# Make the display helpers available directly inside templates.
app.jinja_env.globals["time_remaining"] = todo.time_remaining
app.jinja_env.globals["is_overdue"] = todo.is_overdue
app.jinja_env.globals["tag_color"] = todo.tag_color
app.jinja_env.globals["text_color_for"] = todo.text_color_for
app.jinja_env.globals["section_color"] = journal.section_color
app.jinja_env.globals["is_registered_tag"] = journal.is_registered_tag


@app.context_processor
def inject_section_context():
    endpoint = request.endpoint or ""
    return {"in_journal": endpoint.startswith("journal")}


@app.route("/")
def index():
    data = todo.load(data_file())
    # Optional ?tags=a,b filter (OR/union semantics via filter_by_tags).
    selected = _selected_tags(request.args.get("tags"))
    # Drop any selected tag that isn't a known registry tag. A stale/unknown
    # tag in the URL (e.g. ?tags=deleted) should behave like "no filter for
    # that tag" rather than silently filtering everything out to an empty list.
    known = data.get("tags", {})
    selected = [name for name in selected if name in known]
    tasks = todo.sort_active(data["active"])
    tasks = todo.filter_by_tags(tasks, selected)
    # Expired stays unfiltered -- it's a small "missed" log, simpler to leave
    # it always visible regardless of the active filter.
    return render_template(
        "active.html",
        tasks=tasks,
        expired=data.get("expired", []),
        all_tags=data.get("tags", {}),
        selected_tags=selected,
        data=data,
    )


@app.route("/add", methods=["POST"])
def add():
    title = request.form.get("title", "")
    due = request.form.get("due") or None
    recurrence = _recurrence_from_form(request.form)
    data = todo.load(data_file())
    try:
        # Register any new tag color first; a bad color raises and aborts.
        tags = _tags_with_new(request.form, data)
        todo.add_task(data, title, due=due, recurrence=recurrence, tags=tags)
        todo.save(data_file(), data)
    except ValueError:
        # Empty title, malformed due date, bad recurrence, or bad tag
        # name/color -> nothing is saved; tell the user why via a flash.
        flash("Could not add task: check the title, due date, and tags.")
    return redirect(url_for("index"))


@app.route("/edit/<task_id>", methods=["GET"])
def edit(task_id):
    data = todo.load(data_file())
    task = next((t for t in data["active"] if t["id"] == task_id), None)
    if task is None:
        return redirect(url_for("index"))
    return render_template(
        "edit.html", task=task, all_tags=data.get("tags", {}), data=data
    )


@app.route("/edit/<task_id>", methods=["POST"])
def edit_post(task_id):
    title = request.form.get("title", "")
    due = request.form.get("due") or None
    recurrence = _recurrence_from_form(request.form)
    data = todo.load(data_file())
    try:
        tags = _tags_with_new(request.form, data)
        todo.edit_task(data, task_id, title, due=due,
                       recurrence=recurrence, tags=tags)
        todo.save(data_file(), data)
    except ValueError:
        # Validation error (incl. bad tag name/color) -> nothing saved.
        flash("Could not save changes: check the title, due date, and tags.")
    return redirect(url_for("index"))


@app.route("/refresh", methods=["POST"])
def refresh():
    completed_ids = request.form.getlist("completed")
    data = todo.load(data_file())
    todo.refresh(data, completed_ids)
    todo.save(data_file(), data)
    return redirect(url_for("index"))


@app.route("/delete/<task_id>", methods=["POST"])
def delete(task_id):
    data = todo.load(data_file())
    todo.delete_task(data, task_id)
    todo.save(data_file(), data)
    # Send the user back where they came from (Active or Archive).
    return redirect(request.referrer or url_for("index"))


@app.route("/archive")
def archive():
    data = todo.load(data_file())
    # Optional ?tags=a,b filter, parsed + normalized exactly like the index
    # route. Unknown/stale tags are dropped so they behave like "no filter".
    selected = _selected_tags(request.args.get("tags"))
    known = data.get("tags", {})
    selected = [name for name in selected if name in known]
    tasks = todo.filter_by_tags(data["archive"], selected)
    return render_template(
        "archive.html",
        tasks=tasks,
        all_tags=data.get("tags", {}),
        selected_tags=selected,
        data=data,
    )


@app.route("/tags", methods=["GET"])
def tags():
    data = todo.load(data_file())
    return render_template("tags.html", all_tags=data.get("tags", {}))


@app.route("/tags", methods=["POST"])
def tags_post():
    name = request.form.get("name", "")
    color = (request.form.get("color") or "").strip()
    data = todo.load(data_file())
    # This page only EDITS colors of tags that already exist. Tags are created
    # via the add/edit task forms, never here -- so refuse a name that isn't
    # already a registry key (prevents spurious entries from a crafted POST).
    normalized = (name or "").strip().lower()
    if normalized not in data.get("tags", {}):
        flash("Unknown tag -- colors can only be changed for existing tags.")
        return redirect(url_for("tags"))
    try:
        todo.set_tag_color(data, name, color)
        todo.save(data_file(), data)
    except ValueError:
        # Invalid color/name -> redirect back without changing anything.
        flash("Could not update tag color: please pick a valid color.")
    return redirect(url_for("tags"))


@app.route("/tags/<name>/delete", methods=["POST"])
def tag_delete(name):
    data = todo.load(data_file())
    todo.delete_tag(data, name)
    todo.save(data_file(), data)
    flash("Tag deleted.")
    return redirect(url_for("tags"))


@app.route("/journal")
def journal_today():
    data = journal.load(journal_file())
    today = journal.today_iso()
    entry = journal.get_entry_by_date(data, today)
    return render_template(
        "journal_entry.html", data=data, entry=entry, date=today,
        sections=journal.active_sections(data),
    )


@app.route("/journal/entries")
def journal_list():
    data = journal.load(journal_file())
    return render_template("journal_list.html", data=data,
                           entries=journal.entries_sorted(data))


@app.route("/journal/sections")
def journal_sections():
    data = journal.load(journal_file())
    return render_template("journal_sections.html", data=data,
                           sections=journal.active_sections(data))


if __name__ == "__main__":
    app.run(debug=True)
