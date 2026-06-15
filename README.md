# todo·pup

A simple server-rendered to-do web app built with Flask, with a dark-mode
"typewriter" aesthetic. Tasks are stored in a single local JSON file (no
database). Three views:

- **Active** — your current tasks, sorted with overdue items first, then by
  soonest due date, with undated tasks last. Each task shows a time-remaining
  badge (overdue tasks are shown in red). Tick the tasks you've finished and
  hit **Refresh** to move them to the archive.
- **Archive** — completed tasks with the date they were completed.
- **Expired** — missed occurrences of recurring tasks (see below).

## Features

- Add, **edit** (name + date), complete, and delete tasks
- Optional due date with a live "time remaining" badge; overdue shown in red
- **Recurring tasks** — daily, weekly, monthly, or every N days. When a
  recurring task's deadline passes uncompleted, the missed occurrence moves to
  the **Expired** section and the next occurrence is created automatically.
- All data persists locally between launches in `data/tasks.json`

## Tech stack

- Python 3.12+ (developed on 3.13), Flask + Jinja2 templates
- JSON file storage via the standard-library `json` module
- Dates handled with the standard-library `datetime` module

### Date assumption

All dates are treated as **naive local time** (no timezone information is
stored or applied). The reference clock is `datetime.now()`.

## Project layout

```
todo-cli/
├── app.py              # Flask routes (thin HTTP layer)
├── todo.py             # Core logic, no Flask imports (fully unit-tested)
├── data/               # local storage (tasks.json is gitignored, auto-created)
├── templates/          # base / active / archive / edit Jinja templates
├── static/             # style.css + mascot image
├── tests/              # pytest test suite
└── TodoPup.command     # double-click launcher (macOS)
```

## Setup

Any machine with Python 3.12+ — no extra tools needed:

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
flask --app app run --port 5001
```

Then open http://127.0.0.1:5001/ in your browser.

Your tasks are saved to `data/tasks.json`, which is created automatically on
first use and kept out of version control — your task list stays private to
your machine.

### macOS: launch from an icon

Double-click **`TodoPup.command`** in Finder to start the app and open your
browser automatically. Close the Terminal window (or press `Ctrl+C`) to stop.
(First time: right-click → Open → Open to get past the unidentified-developer
warning.)

## Test

```bash
pytest
```
