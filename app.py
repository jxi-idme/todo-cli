"""Flask web layer for the to-do app.

This is intentionally thin: routes parse the request, call into todo.py for
all the real work, save, and redirect. State-changing routes follow the
Post/Redirect/Get pattern so a browser refresh never re-submits a form.
"""

import os

from flask import Flask, redirect, render_template, request, url_for

import todo

app = Flask(__name__)

# Default data file lives in data/tasks.json, but tests override this via
# app.config["DATA_FILE"] so they can use a temp file.
app.config["DATA_FILE"] = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "tasks.json"
)


def data_file():
    return app.config["DATA_FILE"]


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


# Make the display helpers available directly inside templates.
app.jinja_env.globals["time_remaining"] = todo.time_remaining
app.jinja_env.globals["is_overdue"] = todo.is_overdue


@app.route("/")
def index():
    data = todo.load(data_file())
    tasks = todo.sort_active(data["active"])
    return render_template(
        "active.html", tasks=tasks, expired=data.get("expired", [])
    )


@app.route("/add", methods=["POST"])
def add():
    title = request.form.get("title", "")
    due = request.form.get("due") or None
    recurrence = _recurrence_from_form(request.form)
    data = todo.load(data_file())
    try:
        todo.add_task(data, title, due=due, recurrence=recurrence)
        todo.save(data_file(), data)
    except ValueError:
        # Empty title, malformed due date, or bad recurrence -> silently
        # ignore and just redirect back without adding anything.
        pass
    return redirect(url_for("index"))


@app.route("/edit/<task_id>", methods=["GET"])
def edit(task_id):
    data = todo.load(data_file())
    task = next((t for t in data["active"] if t["id"] == task_id), None)
    if task is None:
        return redirect(url_for("index"))
    return render_template("edit.html", task=task)


@app.route("/edit/<task_id>", methods=["POST"])
def edit_post(task_id):
    title = request.form.get("title", "")
    due = request.form.get("due") or None
    recurrence = _recurrence_from_form(request.form)
    data = todo.load(data_file())
    try:
        todo.edit_task(data, task_id, title, due=due, recurrence=recurrence)
        todo.save(data_file(), data)
    except ValueError:
        # Validation error -> redirect back without saving.
        pass
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
    return render_template("archive.html", tasks=data["archive"])


if __name__ == "__main__":
    app.run(debug=True)
