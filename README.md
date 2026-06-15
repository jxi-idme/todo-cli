# To-Do

A simple server-rendered to-do web app built with Flask. Tasks are stored in
a single JSON file (no database). It has two views:

- **Active** — your current tasks, sorted with overdue items first, then by
  soonest due date, with undated tasks last. Each task shows a time-remaining
  badge (overdue tasks are shown in red). Tick the tasks you've finished and
  hit **Refresh** to move them to the archive.
- **Archive** — completed tasks with the date they were completed.

## Tech stack

- Python 3.13, Flask + Jinja2 templates
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
├── data/tasks.json     # created at runtime; gitignored
├── templates/          # base / active / archive Jinja templates
├── static/style.css
└── tests/              # pytest test suite
```

## Setup

```bash
uv venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
flask --app app run
```

Then open http://127.0.0.1:5000/ in your browser.

## Test

```bash
pytest
```
