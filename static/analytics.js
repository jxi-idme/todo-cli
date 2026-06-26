/* Analytics dashboard. Fetches /journal/analytics/data, filters by date in
 * memory, and renders charts via the CHARTS registry. To add a chart, push a
 * descriptor onto CHARTS (see analytics.js chart sections). No chart hardcodes
 * a section/tag name or a theme color — colors come from CSS variables and the
 * fetched section list, so new sections/tags appear automatically. */
(function () {
  "use strict";

  var root = document.getElementById("analytics-root");
  if (!root) return;

  // ----- state -----
  var ENDPOINT = root.dataset.endpoint;
  var _data = { sections: [], entries: [], date_range: { min: null, max: null } };
  var _from = null, _to = null;
  var _activeTab = "overview";
  var _lens = "journal";    // "journal" | "task" — swaps the deeper tab set
  var _lastFetch = 0;
  var _tagQuery = "";       // current tag in the Tag detail tab
  var _tagCache = {};       // {name: payload} cache for /tag/<name>/overview

  // Panel definitions. `needs` optionally gates a tab's visibility.
  // `lens` scopes a tab to one lens; tabs with no lens are shared (Overview),
  // and a tab can list multiple lenses (the Tag detail tab lives in both).
  var PANELS = [
    { id: "overview", label: "Overview" },
    // Journal lens
    { id: "mood", label: "Mood", lens: ["journal"], needs: hasMood },
    { id: "consistency", label: "Consistency", lens: ["journal"] },
    { id: "tags", label: "Tags", lens: ["journal"] },
    { id: "numeric", label: "Numeric", lens: ["journal"], needs: hasNumeric },
    { id: "coverage", label: "Coverage", lens: ["journal"] },
    // Task lens (the old single "Tasks" tab, refactored into sub-tabs)
    { id: "throughput", label: "Throughput", lens: ["task"], needs: hasTasks },
    { id: "timeliness", label: "Timeliness", lens: ["task"], needs: hasTasks },
    { id: "adherence", label: "Adherence", lens: ["task"], needs: hasTasks },
    { id: "difficulty", label: "Difficulty", lens: ["task"], needs: hasTasks },
    { id: "tasktags", label: "Task tags", lens: ["task"], needs: hasTasks },
    // Shared deep tag detail (lens-aware rendering)
    { id: "tag", label: "Tag", lens: ["journal", "task"] },
  ];

  // Filled by the chart sections (Tasks 11-13).
  var CHARTS = [];
  window.__ANALYTICS_CHARTS__ = CHARTS;  // exposed so chart files can push

  function hasNumeric() {
    return _data.sections.some(function (s) { return s.type === "numeric"; });
  }

  function hasTasks() {
    var t = _data.tasks;
    return !!t && (t.active.length || t.archive.length || t.expired.length);
  }

  function hasMood() {
    return _data.entries.some(function (e) { return e.mood != null; });
  }

  // Tasks completed within the active date range, by completed-day.
  function taskThroughput() {
    var out = {};
    (_data.tasks ? _data.tasks.archive : []).forEach(function (t) {
      if (!t.completed) return;
      var d = t.completed.slice(0, 10);
      if ((_from && d < _from) || (_to && d > _to)) return;
      out[d] = (out[d] || 0) + 1;
    });
    return out;
  }

  // ----- color resolution (live, from CSS vars) -----
  function colors() {
    var cs = getComputedStyle(document.documentElement);
    function v(name) { return cs.getPropertyValue(name).trim(); }
    return {
      bg: v("--bg"), panel: v("--panel"), text: v("--text"),
      muted: v("--muted"), border: v("--border"),
      accent: v("--accent"), accentDim: v("--accent-dim"), danger: v("--danger"),
    };
  }

  // ----- SVG / stats utilities (U) -----
  var SVGNS = "http://www.w3.org/2000/svg";

  var U = {
    svgEl: function (tag, attrs) {
      var el = document.createElementNS(SVGNS, tag);
      for (var k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
      return el;
    },

    svg: function (width, height) {
      var s = U.svgEl("svg", {
        viewBox: "0 0 " + width + " " + height,
        class: "chart-svg",
        preserveAspectRatio: "xMidYMid meet",
      });
      s.dataset.w = width; s.dataset.h = height;
      return s;
    },

    // Like svg(), but renders at its natural pixel size (small) and only
    // shrinks if it would overflow the panel. Use for grid/heatmap charts so
    // a few columns stay small instead of being stretched to full width.
    svgFixed: function (width, height) {
      var s = U.svgEl("svg", {
        viewBox: "0 0 " + width + " " + height,
        width: width, height: height,
        class: "chart-svg-fixed",
        preserveAspectRatio: "xMinYMin meet",
      });
      s.dataset.w = width; s.dataset.h = height;
      return s;
    },

    text: function (svg, x, y, str, fill, opts) {
      opts = opts || {};
      var t = U.svgEl("text", {
        x: x, y: y, fill: fill,
        "font-family": "inherit",
        "font-size": opts.size || 10,
        "text-anchor": opts.anchor || "start",
      });
      t.textContent = str;
      svg.appendChild(t);
      return t;
    },

    drawGrid: function (svg, x, y, w, h, rows, c) {
      for (var i = 0; i <= rows; i++) {
        var yy = y + (h * i) / rows;
        svg.appendChild(U.svgEl("line", {
          x1: x, y1: yy, x2: x + w, y2: yy,
          stroke: c.border, "stroke-width": 1,
        }));
      }
    },

    drawAxis: function (svg, x, y, w, h, labels, c) {
      // X-axis baseline + evenly spaced tick labels below it.
      svg.appendChild(U.svgEl("line", {
        x1: x, y1: y + h, x2: x + w, y2: y + h,
        stroke: c.muted, "stroke-width": 1,
      }));
      var n = labels.length;
      for (var i = 0; i < n; i++) {
        var cx = n === 1 ? x + w / 2 : x + (w * i) / (n - 1);
        U.text(svg, cx, y + h + 12, labels[i], c.muted,
               { anchor: "middle", size: 9 });
      }
    },

    drawBar: function (svg, x, y, w, h, color) {
      svg.appendChild(U.svgEl("rect", {
        x: x, y: y, width: Math.max(w, 0), height: Math.max(h, 0),
        fill: color, rx: 2,
      }));
    },

    drawLine: function (svg, points, color, width) {
      if (points.length < 2) return;
      var d = points.map(function (p, i) {
        return (i ? "L" : "M") + p.x + " " + p.y;
      }).join(" ");
      svg.appendChild(U.svgEl("path", {
        d: d, fill: "none", stroke: color, "stroke-width": width || 1.5,
      }));
    },

    drawDot: function (svg, cx, cy, r, color) {
      svg.appendChild(U.svgEl("circle", { cx: cx, cy: cy, r: r, fill: color }));
    },

    // mean/median/mode/stdev/min/max/count; matches journal.describe (sample stdev).
    describe: function (values) {
      var vals = values.filter(function (v) { return v != null; }).map(Number);
      var n = vals.length;
      if (!n) return { mean: null, median: null, mode: null,
                       stdev: null, min: null, max: null, count: 0 };
      var sorted = vals.slice().sort(function (a, b) { return a - b; });
      var mean = vals.reduce(function (a, b) { return a + b; }, 0) / n;
      var median = n % 2 ? sorted[(n - 1) / 2]
                         : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      var counts = new Map();
      vals.forEach(function (v) { counts.set(v, (counts.get(v) || 0) + 1); });
      var top = 0;
      counts.forEach(function (c) { if (c > top) top = c; });
      var mode = null;
      if (top > 1) {
        var modes = [];
        counts.forEach(function (c, v) { if (c === top) modes.push(v); });
        mode = Math.min.apply(null, modes);
      }
      var stdev = n >= 2 ? Math.sqrt(vals.reduce(function (a, b) {
        return a + (b - mean) * (b - mean);
      }, 0) / (n - 1)) : null;
      return { mean: mean, median: median, mode: mode, stdev: stdev,
               min: sorted[0], max: sorted[n - 1], count: n };
    },

    // pairs: [["label", "value"], ...]; null/undefined values are skipped.
    statsRow: function (container, pairs) {
      var row = document.createElement("div");
      row.className = "stats-row";
      pairs.forEach(function (p) {
        if (p[1] == null || p[1] === "") return;
        var stat = document.createElement("span");
        stat.className = "stat";
        var l = document.createElement("span");
        l.className = "stat-label"; l.textContent = p[0] + ":";
        var v = document.createElement("span");
        v.className = "stat-value"; v.textContent = p[1];
        stat.appendChild(l); stat.appendChild(v);
        row.appendChild(stat);
      });
      if (row.children.length) container.appendChild(row);
    },

    empty: function (container, msg) {
      var p = document.createElement("p");
      p.className = "analytics-empty";
      p.textContent = msg;
      container.appendChild(p);
    },

    colorMix: function (hex, pct) {
      return "color-mix(in srgb, " + hex + " " + pct + "%, transparent)";
    },

    tagSections: function (sections) {
      return sections.filter(function (s) { return s.type === "tag"; });
    },

    numericSections: function (sections) {
      return sections.filter(function (s) { return s.type === "numeric"; });
    },

    fmt: function (n) {  // tidy number for stat display
      if (n == null) return null;
      return Math.round(n * 100) / 100 + "";
    },
  };

  window.__ANALYTICS_U__ = U;  // exposed for chart files

  // ===================== Overview & Consistency charts ===================== //

  // Shared JS reimplementations of the streak/gap logic (mirror journal.py).
  function uniqueDates(entries) {
    var set = {};
    entries.forEach(function (e) { if (e.date) set[e.date] = true; });
    return Object.keys(set).sort();
  }
  function dayDiff(a, b) {  // whole days between two YYYY-MM-DD strings
    return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  }
  function streaks(dates) {
    if (!dates.length) return { current: 0, longest: 0, runs: [] };
    var runs = [], run = 1;
    for (var i = 1; i < dates.length; i++) {
      if (dayDiff(dates[i - 1], dates[i]) === 1) run++;
      else { runs.push(run); run = 1; }
    }
    runs.push(run);
    return { current: runs[runs.length - 1], longest: Math.max.apply(null, runs), runs: runs };
  }

  // ----- Overview building blocks -----

  // A prominent stat card: big value + label, optional sub-line.
  function statCard(grid, value, label, sub) {
    var card = document.createElement("div");
    card.className = "stat-card";
    var v = document.createElement("div");
    v.className = "stat-card-value";
    v.textContent = (value == null || value === "") ? "—" : value;
    var l = document.createElement("div");
    l.className = "stat-card-label";
    l.textContent = label;
    card.appendChild(v); card.appendChild(l);
    if (sub != null && sub !== "") {
      var s = document.createElement("div");
      s.className = "stat-card-sub";
      s.textContent = sub;
      card.appendChild(s);
    }
    grid.appendChild(card);
    return card;
  }

  // A tiny inline sparkline (mood 1..7) appended into a stat card.
  function moodSparkline(card, series) {
    if (series.length < 2) return;
    var w = 120, h = 28;
    var svg = U.svgEl("svg", {
      viewBox: "0 0 " + w + " " + h, width: w, height: h, class: "stat-spark",
    });
    var min = 1, max = 7, span = max - min;
    var pts = series.map(function (s, i) {
      return {
        x: (w * i) / (series.length - 1),
        y: 3 + (h - 6) * (1 - (s.mood - min) / span),
      };
    });
    var c = colors();
    U.drawLine(svg, pts, c.accent, 1.5);
    U.drawDot(svg, pts[pts.length - 1].x, pts[pts.length - 1].y, 2, c.accent);
    card.appendChild(svg);
  }

  // Completed tasks in range (whole-store, by completed-day), for Overview.
  function tasksCompletedInRange() {
    var byDay = taskThroughput();
    return Object.keys(byDay).reduce(function (a, d) { return a + byDay[d]; }, 0);
  }

  // Auto-generated plain-language insights. Each returns a string or null.
  function buildInsights(entries) {
    var out = [];
    var moods = moodSeries(entries);

    // Weekend vs weekday mood.
    if (moods.length >= 4) {
      var wk = [], we = [];
      moods.forEach(function (m) {
        var dow = new Date(m.date + "T00:00:00").getDay();  // 0=Sun..6=Sat
        (dow === 0 || dow === 6 ? we : wk).push(m.mood);
      });
      if (wk.length && we.length) {
        var mk = wk.reduce(function (a, b) { return a + b; }, 0) / wk.length;
        var me = we.reduce(function (a, b) { return a + b; }, 0) / we.length;
        var diff = me - mk;
        if (Math.abs(diff) >= 0.4) {
          out.push("Your mood averages " + U.fmt(Math.abs(diff)) +
                   (diff > 0 ? " higher on weekends." : " higher on weekdays."));
        }
      }
    }

    // Best mood stretch (longest run of consecutive good days, mood >= 5).
    if (moods.length) {
      var bestLen = 0, bestEnd = null, run = 0, prev = null;
      moods.forEach(function (m) {
        var good = m.mood >= 5;
        if (good && prev && dayDiff(prev, m.date) === 1) run++;
        else run = good ? 1 : 0;
        prev = m.date;
        if (run > bestLen) { bestLen = run; bestEnd = m.date; }
      });
      if (bestLen >= 3) {
        out.push("Best stretch: " + bestLen + " good days ending " + bestEnd + ".");
      }
    }

    // Streak milestone.
    var dates = uniqueDates(entries);
    var st = streaks(dates);
    if (st.current >= 3 && st.current === st.longest) {
      out.push("You've journaled " + st.current +
               " days straight — your longest yet.");
    }

    // Strongest mood<->numeric correlation across numeric sections.
    var best = null;
    U.numericSections(_data.sections).forEach(function (s) {
      var pairs = entries.filter(function (e) {
        return moodOf(e) != null && (e.numbers || {})[s.id] != null;
      });
      if (pairs.length < 3) return;
      var r = pearson(pairs.map(function (e) { return Number(e.numbers[s.id]); }),
                      pairs.map(function (e) { return moodOf(e); }));
      if (r != null && (!best || Math.abs(r) > Math.abs(best.r))) {
        best = { name: s.name, r: r };
      }
    });
    if (best && Math.abs(best.r) >= 0.3) {
      out.push("More " + best.name + " tracks with " +
               (best.r > 0 ? "better" : "worse") + " mood (r=" +
               (best.r > 0 ? "+" : "") + U.fmt(best.r) + ").");
    }

    return out.slice(0, 4);
  }

  CHARTS.push({
    id: "overview-summary",
    panel: "overview",
    title: "Overview",
    render: function (container, entries, sections, c) {
      if (!entries.length) { U.empty(container, "No entries in this range."); return; }
      var dates = uniqueDates(entries);
      var st = streaks(dates);
      var moods = moodSeries(entries);
      var md = U.describe(moods.map(function (m) { return m.mood; }));

      // ----- prominent stat cards -----
      var grid = document.createElement("div");
      grid.className = "stat-cards";
      statCard(grid, entries.length, "entries this period",
               "last: " + dates[dates.length - 1]);
      statCard(grid, st.current + "d", "current streak",
               "longest " + st.longest + "d");
      var moodCard = statCard(grid, md.count ? U.fmt(md.mean) : null,
                              "avg mood",
                              md.count ? md.count + " day" + (md.count === 1 ? "" : "s") : "no mood yet");
      if (md.count) moodSparkline(moodCard, moods);
      if (hasTasks()) {
        statCard(grid, tasksCompletedInRange(), "tasks completed", null);
      }
      // Current numeric highlights: latest value per numeric section.
      U.numericSections(sections).forEach(function (s) {
        var series = numericSeries(entries, s.id);
        if (!series.length) return;
        var last = series[series.length - 1];
        statCard(grid, U.fmt(last.value) + (s.unit ? " " + s.unit : ""),
                 s.name, "latest " + last.date);
      });
      container.appendChild(grid);

      // ----- auto-insights -----
      var insights = buildInsights(entries);
      if (insights.length) {
        var box = document.createElement("div");
        box.className = "insights";
        var h = document.createElement("div");
        h.className = "insights-title";
        h.textContent = "Insights";
        box.appendChild(h);
        var ul = document.createElement("ul");
        ul.className = "insights-list";
        insights.forEach(function (text) {
          var li = document.createElement("li");
          li.textContent = text;
          ul.appendChild(li);
        });
        box.appendChild(ul);
        container.appendChild(box);
      }

      // ----- compact secondary stats (kept from the original summary) -----
      var words = entries.map(function (e) {
        return (e.body || "").split(/\s+/).filter(Boolean).length;
      });
      var coveredCounts = entries.map(function (e) {
        var n = 0;
        sections.forEach(function (s) {
          var t = (e.tags || {})[s.id];
          if ((t && t.length) || (e.numbers || {})[s.id] != null) n++;
        });
        return n;
      });
      U.statsRow(container, [
        ["avg words/entry", U.fmt(U.describe(words).mean)],
        ["avg sections filled", U.fmt(U.describe(coveredCounts).mean)],
      ]);
    },
  });

  // Month-grid calendar matching the journal entry form's custom calendar.
  // Reuses the .cal-* classes from style.css so the look is identical; days
  // with an entry get an amber dot under the number, today gets the amber ring.
  var CAL_MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  var CAL_DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  function calIso(y, m, d) {
    return y + "-" + String(m + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }

  function buildMonthGrid(year, month, present, todayIso, marked) {
    var wrap = document.createElement("div");
    wrap.className = "cal-month";

    var title = document.createElement("div");
    title.className = "cal-month-title";
    title.textContent = CAL_MONTHS[month] + " " + year;
    wrap.appendChild(title);

    var grid = document.createElement("div");
    grid.className = "cal-grid";
    CAL_DAYS.forEach(function (d) {
      var wh = document.createElement("div");
      wh.className = "cal-weekday";
      wh.textContent = d;
      grid.appendChild(wh);
    });

    var firstDow = new Date(year, month, 1).getDay();
    for (var b = 0; b < firstDow; b++) {
      var blank = document.createElement("div");
      blank.className = "cal-day cal-day-blank";
      grid.appendChild(blank);
    }

    var daysInMonth = new Date(year, month + 1, 0).getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      var iso = calIso(year, month, day);
      var cell = document.createElement("div");
      cell.className = "cal-day";
      if (iso === todayIso) cell.classList.add("is-today");
      var num = document.createElement("span");
      num.className = "cal-day-num";
      num.textContent = String(day);
      cell.appendChild(num);
      // Optional second marked-set (e.g. task completions) sits beside the
      // entry dot in --accent-dim. When `marked` is given, both dots live in a
      // flex row so they render side by side; existing callers pass no
      // `marked` arg and keep the original single stacked dot.
      if (marked) {
        var dots = document.createElement("span");
        dots.className = "cal-dots-row";
        if (present[iso]) {
          var ed = document.createElement("span");
          ed.className = "cal-dot";
          dots.appendChild(ed);
        }
        if (marked[iso]) {
          var td = document.createElement("span");
          td.className = "cal-dot cal-dot-alt";
          dots.appendChild(td);
        }
        if (dots.children.length) cell.appendChild(dots);
      } else if (present[iso]) {
        var dot = document.createElement("span");
        dot.className = "cal-dot";
        cell.appendChild(dot);
      }
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  CHARTS.push({
    id: "calendar-heatmap",
    panel: "consistency",
    title: "Entry calendar",
    render: function (container, entries, sections, c) {
      var dates = uniqueDates(entries);
      if (!dates.length) { U.empty(container, "No entries in this range."); return; }
      var present = {};
      dates.forEach(function (d) { present[d] = true; });
      var now = new Date();
      var todayIso = calIso(now.getFullYear(), now.getMonth(), now.getDate());

      // One month grid per calendar month spanned by the filtered range.
      var first = new Date(dates[0] + "T00:00:00");
      var last = new Date(dates[dates.length - 1] + "T00:00:00");
      var wrap = document.createElement("div");
      wrap.className = "analytics-cal";
      var y = first.getFullYear(), m = first.getMonth();
      while (y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth())) {
        wrap.appendChild(buildMonthGrid(y, m, present, todayIso));
        m++;
        if (m > 11) { m = 0; y++; }
      }
      container.appendChild(wrap);
      U.statsRow(container, [["days with an entry", dates.length]]);
    },
  });

  CHARTS.push({
    id: "word-count",
    panel: "consistency",
    title: "Words per entry over time",
    render: function (container, entries, sections, c) {
      var series = entries.map(function (e) {
        return { date: e.date, count: (e.body || "").split(/\s+/).filter(Boolean).length };
      }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) { U.empty(container, "No entries in this range."); return; }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, series.map(function (s) { return s.count; })) || 1;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      var pts = series.map(function (s, i) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - s.count / max);
        return { x: x, y: y };
      });
      U.drawLine(svg, pts, c.accent, 1.5);
      pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      container.appendChild(svg);
      var wd = U.describe(series.map(function (s) { return s.count; }));
      U.statsRow(container, [["mean", U.fmt(wd.mean)], ["median", U.fmt(wd.median)]]);
    },
  });

  CHARTS.push({
    id: "entry-gaps",
    panel: "consistency",
    title: "Gaps between entries",
    render: function (container, entries, sections, c) {
      var dates = uniqueDates(entries);
      var gaps = [];
      for (var i = 1; i < dates.length; i++) gaps.push(dayDiff(dates[i - 1], dates[i]));
      if (!gaps.length) { U.empty(container, "Need at least two entries to show gaps."); return; }
      // Histogram by gap size.
      var hist = {};
      gaps.forEach(function (g) { hist[g] = (hist[g] || 0) + 1; });
      var keys = Object.keys(hist).map(Number).sort(function (a, b) { return a - b; });
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, keys.map(function (k) { return hist[k]; }));
      var bw = (w - pad - 10) / keys.length;
      keys.forEach(function (k, i) {
        var bh = (h - pad - 10) * (hist[k] / max);
        U.drawBar(svg, pad + i * bw + 2, 10 + (h - pad - 10) - bh, bw - 4, bh, c.accent);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 keys.map(function (k) { return k + "d"; }), c);
      container.appendChild(svg);
      var gd = U.describe(gaps);
      U.statsRow(container, [["mean gap", U.fmt(gd.mean) + "d"],
                             ["median gap", U.fmt(gd.median) + "d"]]);
    },
  });

  CHARTS.push({
    id: "time-of-day",
    panel: "consistency",
    title: "When entries are written",
    render: function (container, entries, sections, c) {
      var hours = {};
      for (var i = 0; i < 24; i++) hours[i] = 0;
      var any = false;
      entries.forEach(function (e) {
        if (!e.created) return;
        var hr = new Date(e.created).getHours();
        if (!isNaN(hr)) { hours[hr]++; any = true; }
      });
      if (!any) { U.empty(container, "No creation timestamps in this range."); return; }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, Object.keys(hours).map(function (k) { return hours[k]; })) || 1;
      var bw = (w - pad - 10) / 24;
      for (var hgt = 0; hgt < 24; hgt++) {
        var bh = (h - pad - 10) * (hours[hgt] / max);
        U.drawBar(svg, pad + hgt * bw + 1, 10 + (h - pad - 10) - bh, bw - 2, bh, c.accent);
      }
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, ["0", "6", "12", "18", "23"], c);
      container.appendChild(svg);
      // Mode hour as "usually journals at Xam/pm".
      var counts = Object.keys(hours).map(function (k) { return [Number(k), hours[k]]; });
      counts.sort(function (a, b) { return b[1] - a[1]; });
      var topHr = counts[0][1] > 0 ? counts[0][0] : null;
      var label = topHr == null ? null
        : (topHr % 12 === 0 ? 12 : topHr % 12) + (topHr < 12 ? "am" : "pm");
      U.statsRow(container, [["usually writes around", label]]);
    },
  });

  // ===================== Tag charts (one block per tag section) ============ //

  function tagsForSectionEntry(e, sid) {
    return ((e.tags || {})[sid]) || [];
  }
  function sectionTagFreq(entries, sid) {
    var freq = {};
    entries.forEach(function (e) {
      tagsForSectionEntry(e, sid).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; });
    });
    return freq;
  }

  CHARTS.push({
    id: "tag-frequency",
    panel: "tags",
    title: "Tag frequency",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      if (!tagSecs.length) { U.empty(container, "No tag sections."); return; }
      var rendered = false;
      tagSecs.forEach(function (s) {
        var freq = sectionTagFreq(entries, s.id);
        var keys = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
        if (!keys.length) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name;
        block.appendChild(h4);
        var rowH = 18, w = 600, pad = 90;
        var svg = U.svg(w, keys.length * rowH + 6);
        var max = Math.max.apply(null, keys.map(function (k) { return freq[k]; }));
        keys.forEach(function (k, i) {
          var y = i * rowH + 2;
          U.text(svg, pad - 6, y + 12, k, c.text, { anchor: "end", size: 10 });
          var bw = (w - pad - 30) * (freq[k] / max);
          U.drawBar(svg, pad, y + 3, bw, 11, s.color);
          U.text(svg, pad + bw + 4, y + 12, freq[k], c.muted, { size: 9 });
        });
        block.appendChild(svg);
        // mode (most-used tag) + mean uses/tag.
        var d = U.describe(keys.map(function (k) { return freq[k]; }));
        U.statsRow(block, [["most-used", keys[0]],
                           ["mean uses/tag", U.fmt(d.mean)]]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No tags recorded in this range.");
    },
  });

  CHARTS.push({
    id: "tag-trend",
    panel: "tags",
    title: "Top-tag trend (per ISO week)",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      var rendered = false;
      tagSecs.forEach(function (s) {
        var freq = sectionTagFreq(entries, s.id);
        var keys = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
        if (!keys.length) return;
        var tag = keys[0];  // chart the section's most-used tag
        // Weekly counts.
        var weeks = {};
        entries.forEach(function (e) {
          if (tagsForSectionEntry(e, s.id).indexOf(tag) === -1) return;
          var d = new Date(e.date + "T00:00:00");
          var wk = isoWeekKey(d);
          weeks[wk] = (weeks[wk] || 0) + 1;
        });
        var wk = Object.keys(weeks).sort();
        if (wk.length < 2) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + " — “" + tag + "”";
        block.appendChild(h4);
        var w = 600, h = 160, pad = 30;
        var svg = U.svg(w, h);
        var max = Math.max.apply(null, wk.map(function (k) { return weeks[k]; }));
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 3, c);
        var pts = wk.map(function (k, i) {
          var x = pad + ((w - pad - 10) * i) / (wk.length - 1);
          var y = 10 + (h - pad - 10) * (1 - weeks[k] / max);
          return { x: x, y: y };
        });
        U.drawLine(svg, pts, s.color, 1.5);
        pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, s.color); });
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                   [wk[0], wk[wk.length - 1]], c);
        block.appendChild(svg);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "Not enough data for a weekly trend yet.");
    },
  });

  function isoWeekKey(date) {
    // ISO-8601 week number, matching Python's isocalendar().
    var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    var dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    var firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    var week = 1 + Math.round(
      ((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + "-W" + (week < 10 ? "0" + week : week);
  }

  CHARTS.push({
    id: "tag-heatmap",
    panel: "tags",
    title: "Per-tag activity",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      var dates = uniqueDates(entries);
      if (!dates.length) { U.empty(container, "No entries in this range."); return; }
      var rendered = false;
      tagSecs.forEach(function (s) {
        var freq = sectionTagFreq(entries, s.id);
        var tags = Object.keys(freq).sort();
        if (!tags.length) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name;
        block.appendChild(h4);
        // rows = tags, cols = dates; cell filled (section color) if tag present that day.
        var byDate = {};
        entries.forEach(function (e) { byDate[e.date] = tagsForSectionEntry(e, s.id); });
        var cell = 14, gap = 3, labelW = 90;
        var w = labelW + dates.length * (cell + gap);
        var h = tags.length * (cell + gap);
        var svg = U.svgFixed(w, h);
        tags.forEach(function (t, r) {
          U.text(svg, labelW - 6, r * (cell + gap) + cell - 2, t, c.text,
                 { anchor: "end", size: 10 });
          dates.forEach(function (d, col) {
            var on = (byDate[d] || []).indexOf(t) !== -1;
            svg.appendChild(U.svgEl("rect", {
              x: labelW + col * (cell + gap), y: r * (cell + gap),
              width: cell, height: cell, rx: 2, class: "heat-cell",
              fill: on ? s.color : U.colorMix(c.muted, 16),
            }));
          });
        });
        block.appendChild(svg);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No tags recorded in this range.");
    },
  });

  CHARTS.push({
    id: "tag-cooccurrence",
    panel: "tags",
    title: "Tag co-occurrence",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      var rendered = false;
      tagSecs.forEach(function (s) {
        // Build co-occurrence within this section.
        var co = {};
        var tagSet = {};
        entries.forEach(function (e) {
          var tags = Array.from(new Set(tagsForSectionEntry(e, s.id))).sort();
          tags.forEach(function (a) {
            tagSet[a] = true;
            tags.forEach(function (b) {
              if (a === b) return;
              co[a] = co[a] || {};
              co[a][b] = (co[a][b] || 0) + 1;
            });
          });
        });
        var tags = Object.keys(tagSet).sort();
        if (tags.length < 2) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name;
        block.appendChild(h4);
        var table = document.createElement("table");
        table.className = "matrix-table";
        var thead = document.createElement("tr");
        thead.appendChild(document.createElement("th"));
        tags.forEach(function (t) {
          var th = document.createElement("th"); th.textContent = t; thead.appendChild(th);
        });
        table.appendChild(thead);
        tags.forEach(function (a) {
          var tr = document.createElement("tr");
          var rh = document.createElement("th"); rh.textContent = a; tr.appendChild(rh);
          tags.forEach(function (b) {
            var td = document.createElement("td");
            if (a === b) { td.textContent = "·"; td.style.color = c.muted; }
            else {
              var n = (co[a] && co[a][b]) || 0;
              td.textContent = n || "";
              if (n) td.style.background = U.colorMix(s.color, Math.min(80, 20 + n * 20));
            }
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        block.appendChild(table);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "Need a section with 2+ co-occurring tags.");
    },
  });

  // ===================== Numeric & Coverage charts ========================= //

  function numericSeries(entries, sid) {
    return entries
      .filter(function (e) { return (e.numbers || {})[sid] != null; })
      .map(function (e) { return { date: e.date, value: Number(e.numbers[sid]) }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }
  function rollingAvg(values, win) {
    return values.map(function (_, i) {
      var s = Math.max(0, i - win + 1);
      var slice = values.slice(s, i + 1);
      return slice.reduce(function (a, b) { return a + b; }, 0) / slice.length;
    });
  }

  CHARTS.push({
    id: "numeric-line",
    panel: "numeric",
    title: "Numeric values over time",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var rendered = false;
      nums.forEach(function (s) {
        var series = numericSeries(entries, s.id);
        if (!series.length) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 180, pad = 34;
        var svg = U.svg(w, h);
        var vals = series.map(function (p) { return p.value; });
        var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
        var span = max - min || 1;
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
        function ptAt(i, v) {
          var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                      : pad + ((w - pad - 10) * i) / (series.length - 1);
          var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
          return { x: x, y: y };
        }
        var pts = series.map(function (p, i) { return ptAt(i, p.value); });
        // 7-point rolling average overlay (muted).
        var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
        U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);
        U.drawLine(svg, pts, s.color, 1.5);
        pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, s.color); });
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                   [series[0].date, series[series.length - 1].date], c);
        U.text(svg, 0, 14, U.fmt(max), c.muted, { size: 9 });
        U.text(svg, 0, h - pad + 2, U.fmt(min), c.muted, { size: 9 });
        block.appendChild(svg);
        var d = U.describe(vals);
        U.statsRow(block, [
          ["mean", U.fmt(d.mean)], ["median", U.fmt(d.median)],
          ["mode", U.fmt(d.mode)], ["std dev", U.fmt(d.stdev)],
          ["min", U.fmt(d.min)], ["max", U.fmt(d.max)],
        ]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No numeric values in this range.");
    },
  });

  CHARTS.push({
    id: "numeric-dow",
    panel: "numeric",
    title: "Average by day of week",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      var names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      var rendered = false;
      nums.forEach(function (s) {
        var buckets = [[], [], [], [], [], [], []];
        entries.forEach(function (e) {
          var v = (e.numbers || {})[s.id];
          if (v == null) return;
          var dow = (new Date(e.date + "T00:00:00").getDay() + 6) % 7;
          buckets[dow].push(Number(v));
        });
        var avgs = buckets.map(function (b) {
          return b.length ? b.reduce(function (a, x) { return a + x; }, 0) / b.length : null;
        });
        if (avgs.every(function (a) { return a == null; })) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 180, pad = 30;
        var svg = U.svg(w, h);
        var present = avgs.filter(function (a) { return a != null; });
        var max = Math.max.apply(null, present), min = Math.min.apply(null, present.concat(0));
        var bw = (w - pad - 10) / 7;
        avgs.forEach(function (a, i) {
          if (a == null) return;
          var bh = (h - pad - 10) * ((a - Math.min(0, min)) / ((max - Math.min(0, min)) || 1));
          U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, s.color);
        });
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, names, c);
        block.appendChild(svg);
        // highest / lowest day.
        var ranked = names
          .map(function (n, i) { return [n, avgs[i]]; })
          .filter(function (p) { return p[1] != null; })
          .sort(function (a, b) { return b[1] - a[1]; });
        U.statsRow(block, [
          ["highest", ranked[0][0] + " (" + U.fmt(ranked[0][1]) + ")"],
          ["lowest", ranked[ranked.length - 1][0] + " (" + U.fmt(ranked[ranked.length - 1][1]) + ")"],
        ]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No numeric values in this range.");
    },
  });

  CHARTS.push({
    id: "numeric-scatter",
    panel: "numeric",
    title: "Correlation between two numeric sections",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (nums.length < 2) { U.empty(container, "Need two numeric sections to correlate."); return; }
      var sx = nums[0], sy = nums[1];
      var pairs = entries.filter(function (e) {
        return (e.numbers || {})[sx.id] != null && (e.numbers || {})[sy.id] != null;
      }).map(function (e) {
        return { x: Number(e.numbers[sx.id]), y: Number(e.numbers[sy.id]) };
      });
      if (!pairs.length) { U.empty(container, "No days with both values recorded."); return; }
      var w = 600, h = 240, pad = 36;
      var svg = U.svg(w, h);
      var xs = pairs.map(function (p) { return p.x; }), ys = pairs.map(function (p) { return p.y; });
      var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
      var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
      var xSpan = xMax - xMin || 1, ySpan = yMax - yMin || 1;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      pairs.forEach(function (p) {
        var x = (xMax - xMin) === 0
          ? pad + (w - pad - 10) / 2
          : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
        var y = (yMax - yMin) === 0
          ? 10 + (h - pad - 10) / 2
          : 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
        U.drawDot(svg, x, y, 3, U.colorMix(sx.color, 80));
      });
      U.text(svg, w / 2, h - 2, sx.name + " (x)  vs  " + sy.name + " (y)", c.muted,
             { anchor: "middle", size: 9 });
      container.appendChild(svg);
      U.statsRow(container, [["points", pairs.length]]);
    },
  });

  CHARTS.push({
    id: "section-coverage",
    panel: "coverage",
    title: "Section coverage per entry",
    render: function (container, entries, sections, c) {
      if (!entries.length) { U.empty(container, "No entries in this range."); return; }
      var sorted = entries.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      var cell = 14, gap = 3, labelW = 90;
      var w = labelW + sorted.length * (cell + gap);
      var h = sections.length * (cell + gap);
      var svg = U.svgFixed(w, h);
      var coveredCounts = [];
      sections.forEach(function (s, r) {
        U.text(svg, labelW - 6, r * (cell + gap) + cell - 2, s.name, c.text,
               { anchor: "end", size: 10 });
        sorted.forEach(function (e, col) {
          var t = (e.tags || {})[s.id];
          var on = (t && t.length) || (e.numbers || {})[s.id] != null;
          svg.appendChild(U.svgEl("rect", {
            x: labelW + col * (cell + gap), y: r * (cell + gap),
            width: cell, height: cell, rx: 2, class: "heat-cell",
            fill: on ? s.color : U.colorMix(c.muted, 16),
          }));
        });
      });
      sorted.forEach(function (e) {
        var n = 0;
        sections.forEach(function (s) {
          var t = (e.tags || {})[s.id];
          if ((t && t.length) || (e.numbers || {})[s.id] != null) n++;
        });
        coveredCounts.push(n);
      });
      container.appendChild(svg);
      var pct = sections.length
        ? U.describe(coveredCounts.map(function (n) { return (n / sections.length) * 100; })).mean
        : null;
      U.statsRow(container, [["mean sections filled", pct != null ? U.fmt(pct) + "%" : null]]);
    },
  });

  // ===================== Tasks charts ===================================== //

  // --- Tasks: completion throughput ---
  CHARTS.push({
    id: "task-throughput", panel: "throughput", title: "Tasks completed per day",
    render: function (container, entries, sections, c) {
      var byDay = taskThroughput();
      var days = Object.keys(byDay).sort();
      if (!days.length) { U.empty(container, "No completed tasks in this range."); return; }
      var w = 600, h = 160, pad = 28;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, days.map(function (d) { return byDay[d]; }));
      var bw = (w - pad) / days.length;
      days.forEach(function (d, i) {
        var bh = (h - pad) * (byDay[d] / max);
        U.drawBar(svg, pad + i * bw, h - pad - bh, Math.max(bw - 2, 1), bh, c.accent);
      });
      container.appendChild(svg);
      var vals = days.map(function (d) { return byDay[d]; });
      var stat = U.describe(vals);
      U.statsRow(container, [["total", vals.reduce(function (a, b) { return a + b; }, 0)],
                             ["best day", stat.max], ["mean/day", U.fmt(stat.mean)]]);
    },
  });

  // --- Tasks: overdue (completed late) + expiry ---
  CHARTS.push({
    id: "task-overdue", panel: "timeliness", title: "On-time vs late & expired",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [], expired: [] };
      function inR(d) { return d && (!_from || d >= _from) && (!_to || d <= _to); }
      var late = 0, ontime = 0, expired = 0;
      t.archive.forEach(function (x) {
        if (!x.completed || !x.due) return;
        if (!inR(x.completed.slice(0, 10))) return;
        if (x.completed > x.due) late++; else ontime++;
      });
      t.expired.forEach(function (x) {
        if (inR((x.expired_at || "").slice(0, 10))) expired++;
      });
      if (!(late + ontime + expired)) { U.empty(container, "No due/expired tasks in this range."); return; }
      U.statsRow(container, [["on time", ontime], ["late", late], ["expired", expired]]);
      // simple stacked bar
      var w = 600, h = 40, total = late + ontime + expired, x = 0;
      var svg = U.svg(w, h);
      [["on time", ontime, c.accent], ["late", late, c.danger],
       ["expired", expired, c.muted]].forEach(function (seg) {
        var sw = (w) * (seg[1] / total);
        if (sw > 0) { U.drawBar(svg, x, 8, sw, 20, seg[2]); x += sw; }
      });
      container.appendChild(svg);
    },
  });

  // --- Tasks: recurring adherence ---
  CHARTS.push({
    id: "task-adherence", panel: "adherence", title: "Recurring-task adherence",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [], expired: [] };
      function inR(d) { return d && (!_from || d >= _from) && (!_to || d <= _to); }
      var done = t.archive.filter(function (x) {
        return x.recurrence && inR((x.completed || "").slice(0, 10)); }).length;
      var missed = t.expired.filter(function (x) {
        return x.recurrence && inR((x.expired_at || "").slice(0, 10)); }).length;
      var total = done + missed;
      if (!total) { U.empty(container, "No recurring occurrences in this range."); return; }
      var rate = Math.round((done / total) * 100);
      U.statsRow(container, [["completed", done], ["missed", missed], ["hit rate", rate + "%"]]);
      var w = 600, svg = U.svg(w, 40);
      U.drawBar(svg, 0, 8, w * (done / total), 20, c.accent);
      U.drawBar(svg, w * (done / total), 8, w * (missed / total), 20, c.danger);
      container.appendChild(svg);
    },
  });

  // --- Tasks: difficulty breakdown ---
  CHARTS.push({
    id: "task-difficulty", panel: "difficulty", title: "Difficulty of completed tasks",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [] };
      function inR(d) { return d && (!_from || d >= _from) && (!_to || d <= _to); }
      var counts = { easy: 0, medium: 0, hard: 0, unrated: 0 };
      t.archive.forEach(function (x) {
        if (!inR((x.completed || "").slice(0, 10))) return;
        counts[(x.difficulty) || "unrated"]++;
      });
      var order = ["easy", "medium", "hard", "unrated"];
      var max = Math.max.apply(null, order.map(function (k) { return counts[k]; }));
      if (!max) { U.empty(container, "No completed tasks in this range."); return; }
      var w = 600, rowH = 22, svg = U.svg(w, order.length * rowH + 4);
      order.forEach(function (k, i) {
        var y = i * rowH + 2;
        U.text(svg, 70 - 6, y + 14, k, c.text, { anchor: "end", size: 10 });
        var bw = (w - 110) * (counts[k] / max);
        U.drawBar(svg, 70, y + 4, bw, 13, k === "hard" ? c.danger : c.accent);
        U.text(svg, 70 + bw + 4, y + 14, counts[k], c.muted, { size: 9 });
      });
      container.appendChild(svg);
    },
  });

  // --- Tasks: task-tag frequency ---
  CHARTS.push({
    id: "task-tag-frequency", panel: "tasktags", title: "Task tag frequency",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [], active: [], expired: [], tags: {} };
      function inR(d) { return !d || ((!_from || d >= _from) && (!_to || d <= _to)); }
      var freq = {};
      t.archive.forEach(function (x) {
        if (!inR((x.completed || "").slice(0, 10))) return;
        (x.tags || []).forEach(function (tag) { freq[tag] = (freq[tag] || 0) + 1; });
      });
      var keys = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
      if (!keys.length) { U.empty(container, "No task tags in this range."); return; }
      var w = 600, rowH = 18, pad = 90, svg = U.svg(w, keys.length * rowH + 6);
      var max = Math.max.apply(null, keys.map(function (k) { return freq[k]; }));
      keys.forEach(function (k, i) {
        var y = i * rowH + 2;
        var col = (t.tags && t.tags[k]) || c.accent;
        U.text(svg, pad - 6, y + 12, k, c.text, { anchor: "end", size: 10 });
        var bw = (w - pad - 30) * (freq[k] / max);
        U.drawBar(svg, pad, y + 3, bw, 11, col);
        U.text(svg, pad + bw + 4, y + 12, freq[k], c.muted, { size: 9 });
      });
      container.appendChild(svg);
    },
  });

  // --- Tasks: tasks completed vs. a journal numeric (scatter) ---
  // Mirrors the `numeric-scatter` chart (min/max axis + U.drawDot), but with
  // one small-multiple per numeric section (like `numeric-line`/`tag-frequency`
  // iterate). x = that day's completed-task count; y = the journal numeric.
  CHARTS.push({
    id: "task-numeric-scatter", panel: "timeliness",
    title: "Tasks completed vs. journal number",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var byDay = taskThroughput();  // {date: count}, already date-filtered
      var rendered = false;
      nums.forEach(function (s) {
        // Per-day pairs: y from the day's journal value, x from completions.
        var pairs = entries.filter(function (e) {
          return (e.numbers || {})[s.id] != null;
        }).map(function (e) {
          return { x: byDay[e.date] || 0, y: Number(e.numbers[s.id]) };
        });
        if (pairs.length < 2) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 240, pad = 36;
        var svg = U.svg(w, h);
        var xs = pairs.map(function (p) { return p.x; });
        var ys = pairs.map(function (p) { return p.y; });
        var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
        var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
        var xSpan = xMax - xMin || 1, ySpan = yMax - yMin || 1;
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
        pairs.forEach(function (p) {
          var x = (xMax - xMin) === 0
            ? pad + (w - pad - 10) / 2
            : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
          var y = (yMax - yMin) === 0
            ? 10 + (h - pad - 10) / 2
            : 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
          U.drawDot(svg, x, y, 3, U.colorMix(s.color, 80));
        });
        U.text(svg, w / 2, h - 2, "tasks completed (x)  vs  " + s.name + " (y)",
               c.muted, { anchor: "middle", size: 9 });
        block.appendChild(svg);
        U.statsRow(block, [["points", pairs.length]]);
        container.appendChild(block);
      });
      if (!rendered) {
        U.empty(container, "Need 2+ days with both a journal number and a known task-completion count.");
      }
    },
  });

  // --- Tasks: entry-day vs. task-completion-day calendar overlay ---
  // Mirrors `calendar-heatmap` + buildMonthGrid; entry days get the standard
  // amber dot (present), task-completion days get an offset --accent-dim dot.
  CHARTS.push({
    id: "task-entry-calendar", panel: "throughput", title: "Entries & task completions",
    render: function (container, entries, sections, c) {
      var present = {};
      uniqueDates(entries).forEach(function (d) { present[d] = true; });
      var done = taskThroughput();  // {date: count}, already date-filtered
      var entryDates = Object.keys(present);
      var doneDates = Object.keys(done);
      if (!entryDates.length && !doneDates.length) {
        U.empty(container, "No entries or task completions in this range.");
        return;
      }
      var now = new Date();
      var todayIso = calIso(now.getFullYear(), now.getMonth(), now.getDate());

      // Span every calendar month between the earliest and latest marked day.
      var all = entryDates.concat(doneDates).sort();
      var first = new Date(all[0] + "T00:00:00");
      var last = new Date(all[all.length - 1] + "T00:00:00");
      var wrap = document.createElement("div");
      wrap.className = "analytics-cal";
      var y = first.getFullYear(), m = first.getMonth();
      while (y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth())) {
        wrap.appendChild(buildMonthGrid(y, m, present, todayIso, done));
        m++;
        if (m > 11) { m = 0; y++; }
      }
      container.appendChild(wrap);
      // Legend: which dot means what.
      var legend = U.svg(600, 22);
      U.drawDot(legend, 8, 11, 4, c.accent);
      U.text(legend, 18, 14, "journal entry", c.muted, { size: 9 });
      U.drawDot(legend, 120, 11, 4, c.accentDim);
      U.text(legend, 130, 14, "task completed", c.muted, { size: 9 });
      container.appendChild(legend);
      U.statsRow(container, [["entry days", entryDates.length],
                             ["completion days", doneDates.length]]);
    },
  });

  // ===================== Mood charts ====================================== //
  // Mood is an int 1..7 or null; every mood reader skips nulls. JS mirrors the
  // pure helpers in journal.py (mood_series / mood_dow_averages /
  // mood_distribution / mood_by_date / mood_numeric_pairs).

  var DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function moodOf(e) {
    var m = e.mood;
    return (m == null) ? null : Number(m);
  }
  function moodSeries(entries) {
    return entries
      .filter(function (e) { return moodOf(e) != null; })
      .map(function (e) { return { date: e.date, mood: moodOf(e) }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }
  function moodByDate(entries) {
    var out = {};
    entries.forEach(function (e) { var m = moodOf(e); if (m != null) out[e.date] = m; });
    return out;
  }

  CHARTS.push({
    id: "mood-over-time", panel: "mood", title: "Mood over time",
    render: function (container, entries, sections, c) {
      var series = moodSeries(entries);
      if (!series.length) { U.empty(container, "No mood recorded in this range."); return; }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      // Fixed 1..7 scale so the chart reads as an absolute mood, not relative.
      var min = 1, max = 7, span = max - min;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
      function ptAt(i, v) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
        return { x: x, y: y };
      }
      var vals = series.map(function (s) { return s.mood; });
      var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
      var pts = series.map(function (s, i) { return ptAt(i, s.mood); });
      U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);   // 7-day rolling avg
      U.drawLine(svg, pts, c.accent, 1.5);
      pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      U.text(svg, 0, 14, "7", c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
      container.appendChild(svg);
      var d = U.describe(vals);
      U.statsRow(container, [
        ["mean", U.fmt(d.mean)], ["median", U.fmt(d.median)],
        ["min", U.fmt(d.min)], ["max", U.fmt(d.max)],
        ["std dev", U.fmt(d.stdev)], ["days", d.count],
      ]);
    },
  });

  CHARTS.push({
    id: "mood-dow", panel: "mood", title: "Average mood by day of week",
    render: function (container, entries, sections, c) {
      var buckets = [[], [], [], [], [], [], []];
      entries.forEach(function (e) {
        var m = moodOf(e);
        if (m == null) return;
        var dow = (new Date(e.date + "T00:00:00").getDay() + 6) % 7;
        buckets[dow].push(m);
      });
      var avgs = buckets.map(function (b) {
        return b.length ? b.reduce(function (a, x) { return a + x; }, 0) / b.length : null;
      });
      if (avgs.every(function (a) { return a == null; })) {
        U.empty(container, "No mood recorded in this range."); return;
      }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      // Bars scaled on the fixed 1..7 mood scale.
      var min = 1, max = 7;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
      var bw = (w - pad - 10) / 7;
      avgs.forEach(function (a, i) {
        if (a == null) return;
        var bh = (h - pad - 10) * ((a - min) / (max - min));
        U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, c.accent);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, DOW_NAMES, c);
      container.appendChild(svg);
      var ranked = DOW_NAMES
        .map(function (n, i) { return [n, avgs[i]]; })
        .filter(function (p) { return p[1] != null; })
        .sort(function (a, b) { return b[1] - a[1]; });
      U.statsRow(container, [
        ["best", ranked[0][0] + " (" + U.fmt(ranked[0][1]) + ")"],
        ["worst", ranked[ranked.length - 1][0] + " (" + U.fmt(ranked[ranked.length - 1][1]) + ")"],
      ]);
    },
  });

  CHARTS.push({
    id: "mood-distribution", panel: "mood", title: "Mood distribution",
    render: function (container, entries, sections, c) {
      var dist = {};
      for (var n = 1; n <= 7; n++) dist[n] = 0;
      var any = false;
      entries.forEach(function (e) {
        var m = moodOf(e);
        if (m != null && m >= 1 && m <= 7) { dist[m]++; any = true; }
      });
      if (!any) { U.empty(container, "No mood recorded in this range."); return; }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var keys = [1, 2, 3, 4, 5, 6, 7];
      var max = Math.max.apply(null, keys.map(function (k) { return dist[k]; })) || 1;
      var bw = (w - pad - 10) / keys.length;
      keys.forEach(function (k, i) {
        var bh = (h - pad - 10) * (dist[k] / max);
        U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, c.accent);
        U.text(svg, pad + i * bw + bw / 2, 10 + (h - pad - 10) - bh - 3,
               dist[k] || "", c.muted, { anchor: "middle", size: 9 });
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 keys.map(String), c);
      container.appendChild(svg);
      // Describe the underlying values (one per recorded mood) for mode etc.
      var vals = [];
      keys.forEach(function (k) { for (var j = 0; j < dist[k]; j++) vals.push(k); });
      var d = U.describe(vals);
      U.statsRow(container, [["most common", U.fmt(d.mode)],
                             ["mean", U.fmt(d.mean)]]);
    },
  });

  CHARTS.push({
    id: "mood-numeric-scatter", panel: "mood",
    title: "Mood vs. journal number",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections to correlate."); return; }
      var rendered = false;
      nums.forEach(function (s) {
        // Per-day pairs: x = the numeric value, y = mood (fixed 1..7 axis).
        var pairs = entries.filter(function (e) {
          return moodOf(e) != null && (e.numbers || {})[s.id] != null;
        }).map(function (e) {
          return { x: Number(e.numbers[s.id]), y: moodOf(e) };
        });
        if (pairs.length < 2) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 240, pad = 36;
        var svg = U.svg(w, h);
        var xs = pairs.map(function (p) { return p.x; });
        var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
        var xSpan = xMax - xMin || 1;
        var yMin = 1, yMax = 7, ySpan = yMax - yMin;
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
        pairs.forEach(function (p) {
          var x = (xMax - xMin) === 0
            ? pad + (w - pad - 10) / 2
            : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
          var y = 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
          U.drawDot(svg, x, y, 3, U.colorMix(s.color, 80));
        });
        U.text(svg, 0, 14, "7", c.muted, { size: 9 });
        U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
        U.text(svg, w / 2, h - 2, s.name + " (x)  vs  mood (y)", c.muted,
               { anchor: "middle", size: 9 });
        block.appendChild(svg);
        var r = pearson(pairs.map(function (p) { return p.x; }),
                        pairs.map(function (p) { return p.y; }));
        U.statsRow(block, [["points", pairs.length],
                           ["correlation r", r == null ? null : U.fmt(r)]]);
        container.appendChild(block);
      });
      if (!rendered) {
        U.empty(container, "Need 2+ days with both a mood and a journal number.");
      }
    },
  });

  // Pearson correlation coefficient, or null if undefined (n<2 or zero variance).
  function pearson(xs, ys) {
    var n = xs.length;
    if (n < 2) return null;
    var mx = xs.reduce(function (a, b) { return a + b; }, 0) / n;
    var my = ys.reduce(function (a, b) { return a + b; }, 0) / n;
    var sxy = 0, sxx = 0, syy = 0;
    for (var i = 0; i < n; i++) {
      var dx = xs[i] - mx, dy = ys[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx === 0 || syy === 0) return null;
    return sxy / Math.sqrt(sxx * syy);
  }

  // ===================== Tag detail tab (lens-aware) ====================== //
  // A dedicated, bespoke renderer (not part of the CHARTS loop): a search box +
  // datalist of all known tag names, an async per-tag fetch of
  // /tag/<name>/overview, and lens-aware rendering (journal half vs task half).

  var TAG_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function tagShortDate(d) {
    if (!d) return "";
    var p = String(d).split("-");
    return p.length < 3 ? d : TAG_MON[parseInt(p[1], 10) - 1] + " " + p[2];
  }

  // Every known tag name: journal section tags + task tag registry.
  function allTagNames() {
    var set = {};
    (_data.sections || []).forEach(function (s) {
      (s.tags || []).forEach(function (t) { set[t] = true; });
    });
    var tt = _data.tasks && _data.tasks.tags;
    if (tt) Object.keys(tt).forEach(function (t) { set[t] = true; });
    return Object.keys(set).sort();
  }

  function originTaskMark() {
    var s = document.createElement("span");
    s.className = "origin-task";
    s.textContent = "☑";   // ☑
    return s;
  }
  function originDot(color) {
    var s = document.createElement("span");
    s.className = "origin-dot";
    if (color) s.style.setProperty("--dot", color);
    return s;
  }
  function sectionColorOf(sid) {
    var s = (_data.sections || []).filter(function (x) { return x.id === sid; })[0];
    return s ? s.color : null;
  }
  function sectionNameOf(sid) {
    var s = (_data.sections || []).filter(function (x) { return x.id === sid; })[0];
    return s ? s.name : "section";
  }

  // A panel container helper.
  function tagPanel(host, title) {
    var panel = document.createElement("div");
    panel.className = "analytics-panel";
    if (title) {
      var h3 = document.createElement("h3");
      h3.textContent = title;
      panel.appendChild(h3);
    }
    host.appendChild(panel);
    return panel;
  }

  // Mood-over-time chart for the tag (mirrors the mood-over-time chart pattern).
  function tagMoodChart(panel, series, c) {
    if (!series || series.length < 2) {
      U.empty(panel, "Not enough mood data for this tag.");
      return;
    }
    var w = 600, h = 180, pad = 30;
    var svg = U.svg(w, h);
    var min = 1, max = 7, span = max - min;
    U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
    function ptAt(i, v) {
      var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                  : pad + ((w - pad - 10) * i) / (series.length - 1);
      var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
      return { x: x, y: y };
    }
    var vals = series.map(function (s) { return s.mood; });
    var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
    var pts = series.map(function (s, i) { return ptAt(i, s.mood); });
    U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);
    U.drawLine(svg, pts, c.accent, 1.5);
    pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
    U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
               [series[0].date, series[series.length - 1].date], c);
    U.text(svg, 0, 14, "7", c.muted, { size: 9 });
    U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
    panel.appendChild(svg);
  }

  // Journal day-of-week bars from a 7-count array (Mon..Sun).
  function tagDowChart(panel, dow, color, c) {
    var names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    var max = Math.max.apply(null, dow) || 1;
    if (!dow.some(function (n) { return n > 0; })) {
      U.empty(panel, "No entries for this tag in range."); return;
    }
    var w = 600, h = 170, pad = 30;
    var svg = U.svg(w, h);
    var bw = (w - pad - 10) / 7;
    dow.forEach(function (n, i) {
      var bh = (h - pad - 10) * (n / max);
      U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh,
                color || c.accent);
      if (n) U.text(svg, pad + i * bw + bw / 2, 10 + (h - pad - 10) - bh - 3,
                    String(n), c.muted, { anchor: "middle", size: 9 });
    });
    U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, names, c);
    panel.appendChild(svg);
  }

  // Horizontal co-occurrence bar list. `rows` = [{name, count, color}].
  function tagCoocList(panel, rows, c, taskOrigin) {
    if (!rows.length) { U.empty(panel, "No co-occurring tags."); return; }
    var max = rows[0].count || 1;
    var list = document.createElement("div");
    list.className = "cooc-list";
    rows.slice(0, 10).forEach(function (r) {
      var row = document.createElement("div");
      row.className = "cooc-row";
      var nm = document.createElement("span");
      nm.className = "cooc-name";
      nm.appendChild(taskOrigin ? originTaskMark() : originDot(r.color));
      nm.appendChild(document.createTextNode(" " + r.name));
      var track = document.createElement("span");
      track.className = "cooc-track";
      var fill = document.createElement("span");
      fill.className = "cooc-fill";
      fill.style.width = Math.round((r.count / max) * 100) + "%";
      track.appendChild(fill);
      var cnt = document.createElement("span");
      cnt.className = "cooc-count";
      cnt.textContent = r.count;
      row.appendChild(nm); row.appendChild(track); row.appendChild(cnt);
      list.appendChild(row);
    });
    panel.appendChild(list);
  }

  function renderTagJournal(host, journal, c) {
    // Header stats.
    var head = tagPanel(host, null);
    var hr = document.createElement("div");
    hr.className = "deep-head";
    var nm = document.createElement("span");
    nm.className = "deep-tagname"; nm.textContent = _tagQuery;
    hr.appendChild(nm);
    (journal.sections || []).forEach(function (s) {
      var mark = document.createElement("span");
      mark.className = "pop-origin-mark";
      mark.appendChild(originDot(s.color));
      mark.appendChild(document.createTextNode(" journal · " + s.name));
      hr.appendChild(mark);
    });
    head.appendChild(hr);
    var grid = document.createElement("div");
    grid.className = "stat-cards";
    statCard(grid, journal.entries, "entries",
             (journal.first && journal.last)
               ? journal.first + " → " + journal.last : null);
    statCard(grid, journal.avg_mood != null ? U.fmt(journal.avg_mood) : null,
             "avg mood",
             journal.uplift != null
               ? (journal.uplift > 0 ? "▲ +" : "▼ ") + U.fmt(journal.uplift) + " vs overall"
               : null);
    head.appendChild(grid);

    // Timeline (entry rows link to /journal/<date>).
    var tl = tagPanel(host, "Journal timeline");
    if ((journal.timeline || []).length) {
      var ul = document.createElement("ul");
      ul.className = "timeline";
      journal.timeline.forEach(function (r) {
        var li = document.createElement("li");
        li.className = "tl-row";
        var mark = document.createElement("span");
        mark.className = "tl-mark";
        mark.appendChild(originDot(sectionColorOf((r.sections || [])[0])));
        li.appendChild(mark);
        var a = document.createElement("a");
        a.className = "tl-date"; a.href = "/journal/" + r.date;
        a.textContent = tagShortDate(r.date);
        li.appendChild(a);
        var tx = document.createElement("span");
        tx.className = "tl-text";
        tx.textContent = r.snippet || "(entry)";
        li.appendChild(tx);
        ul.appendChild(li);
      });
      tl.appendChild(ul);
    } else {
      U.empty(tl, "No journal entries carry this tag in range.");
    }

    // Mood when present.
    tagMoodChart(tagPanel(host, "Mood when present"), journal.mood_series, c);
    // Journal day-of-week.
    tagDowChart(tagPanel(host, "Journal day-of-week"), journal.dow || [0,0,0,0,0,0,0],
                (journal.sections || [])[0] ? journal.sections[0].color : null, c);
    // Co-occurrence.
    var coocRows = (journal.cooccurring || []).map(function (x) {
      return { name: x.name, count: x.count, color: sectionColorOf(x.section_id) };
    });
    tagCoocList(tagPanel(host, "Co-occurring journal tags"), coocRows, c, false);
  }

  function renderTagTask(host, task, c) {
    // Header stats.
    var head = tagPanel(host, null);
    var hr = document.createElement("div");
    hr.className = "deep-head";
    var nm = document.createElement("span");
    nm.className = "deep-tagname"; nm.textContent = _tagQuery;
    hr.appendChild(nm);
    var mark = document.createElement("span");
    mark.className = "pop-origin-mark";
    mark.appendChild(originTaskMark());
    mark.appendChild(document.createTextNode(" task tag"));
    hr.appendChild(mark);
    head.appendChild(hr);
    var grid = document.createElement("div");
    grid.className = "stat-cards";
    statCard(grid, task.active, "active tasks", task.completed + " done");
    statCard(grid, task.completed, "completed",
             task.expired ? task.expired + " expired" : null);
    var lead = task.lead_time_days;
    statCard(grid, lead == null ? null : "~" + Math.abs(Math.round(lead * 10) / 10) + "d",
             "lead time",
             lead == null ? null : (lead > 0 ? "finished early" : "finished late"));
    head.appendChild(grid);

    // Lead-time callout.
    var lt = tagPanel(host, "Task lead-time");
    if (lead != null) {
      var box = document.createElement("div");
      box.className = "callout";
      var big = document.createElement("div");
      big.className = "callout-big";
      big.textContent = lead > 0
        ? "Usually finished ~" + Math.abs(Math.round(lead * 10) / 10) + " days early"
        : (lead < 0
          ? "Usually finished ~" + Math.abs(Math.round(lead * 10) / 10) + " days late"
          : "Usually finished on time");
      box.appendChild(big);
      lt.appendChild(box);
    } else {
      U.empty(lt, "No completed tasks with a due date for this tag.");
    }

    // Task timeline.
    var tl = tagPanel(host, "Task timeline");
    if ((task.timeline || []).length) {
      var ul = document.createElement("ul");
      ul.className = "timeline";
      task.timeline.forEach(function (r) {
        var li = document.createElement("li");
        li.className = "tl-row";
        var mk = document.createElement("span");
        mk.className = "tl-mark";
        mk.appendChild(originTaskMark());
        li.appendChild(mk);
        var dt = document.createElement("span");
        dt.className = "tl-date"; dt.textContent = tagShortDate(r.date);
        li.appendChild(dt);
        var tx = document.createElement("span");
        tx.className = "tl-text";
        tx.textContent = r.title + " · " + r.status;
        li.appendChild(tx);
        ul.appendChild(li);
      });
      tl.appendChild(ul);
    } else {
      U.empty(tl, "No tasks carry this tag in range.");
    }

    // Completion throughput for the tag (per-day bars from the timeline).
    var thr = tagPanel(host, "Completion throughput");
    var byDay = {};
    (task.timeline || []).forEach(function (r) {
      if (r.status === "completed" && r.completed) {
        var d = r.completed.slice(0, 10);
        byDay[d] = (byDay[d] || 0) + 1;
      }
    });
    var days = Object.keys(byDay).sort();
    if (days.length) {
      var w = 600, h = 160, pad = 28, svg = U.svg(w, h);
      var max = Math.max.apply(null, days.map(function (d) { return byDay[d]; }));
      var bw = (w - pad) / days.length;
      days.forEach(function (d, i) {
        var bh = (h - pad) * (byDay[d] / max);
        U.drawBar(svg, pad + i * bw, h - pad - bh, Math.max(bw - 2, 1), bh, c.accent);
      });
      thr.appendChild(svg);
      U.statsRow(thr, [["completions", days.reduce(function (a, d) { return a + byDay[d]; }, 0)]]);
    } else {
      U.empty(thr, "No completed tasks for this tag in range.");
    }

    // Task co-occurrence.
    var coocRows = (task.cooccurring || []).map(function (x) {
      return { name: x.name, count: x.count };
    });
    tagCoocList(tagPanel(host, "Co-occurring task tags"), coocRows, c, true);
  }

  function renderTagDetail(host, c) {
    // Search box + datalist.
    var searchPanel = tagPanel(host, null);
    var row = document.createElement("div");
    row.className = "tag-search-row";
    var label = document.createElement("label");
    label.textContent = "tag"; label.setAttribute("for", "tag-search-input");
    var input = document.createElement("input");
    input.className = "tag-search"; input.id = "tag-search-input";
    input.type = "text"; input.placeholder = "search a tag…";
    input.setAttribute("list", "tag-search-list");
    input.value = _tagQuery;
    var list = document.createElement("datalist");
    list.id = "tag-search-list";
    allTagNames().forEach(function (n) {
      var opt = document.createElement("option");
      opt.value = n; list.appendChild(opt);
    });
    row.appendChild(label); row.appendChild(input); row.appendChild(list);
    searchPanel.appendChild(row);

    var resultsHost = document.createElement("div");
    resultsHost.className = "tag-detail-results";
    host.appendChild(resultsHost);

    function run(name) {
      _tagQuery = (name || "").trim().toLowerCase();
      resultsHost.innerHTML = "";
      if (!_tagQuery) {
        U.empty(resultsHost, "Type or pick a tag above to see its detail.");
        return;
      }
      U.empty(resultsHost, "Loading…");
      fetchTagOverview(_tagQuery).then(function (payload) {
        if (_tagQuery !== ((name || "").trim().toLowerCase())) return;  // stale
        resultsHost.innerHTML = "";
        var cc = colors();
        if (_lens === "task") renderTagTask(resultsHost, payload.task || {}, cc);
        else renderTagJournal(resultsHost, payload.journal || {}, cc);
      }).catch(function () {
        resultsHost.innerHTML = "";
        U.empty(resultsHost, "Could not load this tag.");
      });
    }

    var _debounce = null;
    input.addEventListener("input", function () {
      clearTimeout(_debounce);
      var v = input.value;
      _debounce = setTimeout(function () { run(v); }, 250);
    });
    input.addEventListener("change", function () { run(input.value); });

    if (_tagQuery) run(_tagQuery);
    else U.empty(resultsHost, "Type or pick a tag above to see its detail.");
  }

  // Fetch /tag/<name>/overview honoring the current date range; cached per
  // (name, range) so re-renders don't refetch needlessly.
  function fetchTagOverview(name) {
    var qs = [];
    if (_from) qs.push("from=" + encodeURIComponent(_from));
    if (_to) qs.push("to=" + encodeURIComponent(_to));
    var key = name + "|" + qs.join("&");
    if (_tagCache[key]) return Promise.resolve(_tagCache[key]);
    var url = "/tag/" + encodeURIComponent(name) + "/overview" +
              (qs.length ? "?" + qs.join("&") : "");
    return fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (payload) { _tagCache[key] = payload; return payload; });
  }

  // ----- date filtering -----
  function filterEntries() {
    return _data.entries.filter(function (e) {
      return (!_from || e.date >= _from) && (!_to || e.date <= _to);
    });
  }

  // ----- lens + tabs -----
  // A tab is visible when: it has no lens (shared, e.g. Overview), OR its lens
  // list includes the active lens. `needs` further gates on available data.
  function tabVisible(p) {
    if (p.lens && p.lens.indexOf(_lens) === -1) return false;
    if (p.needs && !p.needs()) return false;
    return true;
  }

  // The Journal/Task lens toggle. Overview always renders outside it, so the
  // toggle only swaps the deeper tab set. Switching lens keeps the active tab
  // if it is still valid under the new lens, else falls back to Overview.
  function buildLensToggle() {
    var host = root.querySelector(".analytics-lens");
    if (!host) return;
    host.innerHTML = "";
    [["journal", "Journal"], ["task", "Task"]].forEach(function (pair) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "analytics-lens-btn" + (pair[0] === _lens ? " active" : "");
      btn.textContent = pair[1];
      btn.dataset.lens = pair[0];
      btn.addEventListener("click", function () { switchLens(pair[0]); });
      host.appendChild(btn);
    });
  }

  function switchLens(lens) {
    if (lens === _lens) return;
    _lens = lens;
    // Keep the active tab if it survives the lens switch; else go to Overview.
    var stay = PANELS.some(function (p) {
      return p.id === _activeTab && tabVisible(p);
    });
    if (!stay) _activeTab = "overview";
    buildLensToggle();
    buildTabs();
    renderActivePanel();
  }

  function buildTabs() {
    var bar = root.querySelector(".analytics-tabs");
    bar.innerHTML = "";
    PANELS.forEach(function (p) {
      if (!tabVisible(p)) return;
      var btn = document.createElement("button");
      btn.className = "analytics-tab" + (p.id === _activeTab ? " active" : "");
      btn.textContent = p.label;
      btn.dataset.panel = p.id;
      btn.addEventListener("click", function () { switchTab(p.id); });
      bar.appendChild(btn);
    });
    // If the active tab got hidden (e.g. numeric data removed), fall back.
    if (!PANELS.some(function (p) { return p.id === _activeTab && tabVisible(p); })) {
      _activeTab = "overview";
    }
  }

  function switchTab(id) {
    _activeTab = id;
    root.querySelectorAll(".analytics-tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.panel === id);
    });
    renderActivePanel();
  }

  // ----- rendering -----
  function renderActivePanel() {
    var host = root.querySelector(".analytics-panels");
    host.innerHTML = "";
    var entries = filterEntries();
    var c = colors();

    // The Tag detail tab has bespoke interaction, so it bypasses the CHARTS loop.
    if (_activeTab === "tag") {
      renderTagDetail(host, c);
      return;
    }

    var charts = CHARTS.filter(function (ch) { return ch.panel === _activeTab; });

    if (!charts.length) {
      U.empty(host, "No charts for this section yet.");
      return;
    }
    charts.forEach(function (ch) {
      var panel = document.createElement("div");
      panel.className = "analytics-panel";
      panel.id = "chart-" + ch.id;
      var h3 = document.createElement("h3");
      h3.textContent = ch.title;
      panel.appendChild(h3);
      try {
        ch.render(panel, entries, _data.sections, c);
      } catch (err) {
        U.empty(panel, "Could not render this chart.");
        if (window.console) console.error(ch.id, err);
      }
      host.appendChild(panel);
    });
  }

  // Read #tag=<name> from the URL hash: open the Tag tab pre-searched.
  function readTagHash() {
    var m = /(?:^|[#&])tag=([^&]+)/.exec(window.location.hash || "");
    if (m) {
      _tagQuery = decodeURIComponent(m[1]).trim().toLowerCase();
      _activeTab = "tag";
    }
  }

  // ----- data load -----
  var _firstLoad = true;
  function applyData(payload) {
    _data = payload || _data;
    var loading = document.getElementById("analytics-loading");
    if (loading) loading.remove();
    // Initialize date inputs to full range on first load only.
    var fromEl = document.getElementById("date-from");
    var toEl = document.getElementById("date-to");
    if (_from === null && _to === null) {
      _from = _data.date_range.min;
      _to = _data.date_range.max;
      fromEl.value = _from || "";
      toEl.value = _to || "";
    }
    if (_firstLoad) { readTagHash(); _firstLoad = false; }
    syncDateLabels();
    buildLensToggle();
    buildTabs();
    renderActivePanel();
  }

  function fetchData(force) {
    var now = Date.now();
    if (!force && now - _lastFetch < 10000) return;
    _lastFetch = now;
    fetch(ENDPOINT, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(applyData)
      .catch(function (err) {
        if (window.console) console.error("analytics fetch failed", err);
      });
  }

  // ----- wiring -----
  document.getElementById("date-from").addEventListener("change", function (e) {
    _from = e.target.value || null;
    _tagCache = {};   // range changed -> the Tag tab must refetch
    renderActivePanel();
  });
  document.getElementById("date-to").addEventListener("change", function (e) {
    _to = e.target.value || null;
    _tagCache = {};
    renderActivePanel();
  });
  document.getElementById("date-reset").addEventListener("click", function () {
    _from = _data.date_range.min;
    _to = _data.date_range.max;
    _tagCache = {};
    document.getElementById("date-from").value = _from || "";
    document.getElementById("date-to").value = _to || "";
    syncDateLabels();
    renderActivePanel();
  });

  // ----- custom date pickers (themed calendar popover, reuses .cal-* CSS) -----
  function syncDateLabels() {
    document.querySelectorAll("[data-datepicker]").forEach(function (btn) {
      var input = document.getElementById(btn.dataset.datepicker);
      var span = btn.querySelector(".cs-value");
      if (input && span) span.textContent = input.value || "—";
    });
  }

  var _openCal = null;
  function closeCal() { if (_openCal) { _openCal.remove(); _openCal = null; } }

  function openCalFor(trigger, input) {
    var pop = document.createElement("div");
    pop.className = "cal-popover";
    pop._owner = trigger;
    pop.addEventListener("click", function (e) { e.stopPropagation(); });

    var base = input.value ? new Date(input.value + "T00:00:00") : new Date();
    var viewY = base.getFullYear(), viewM = base.getMonth();

    function render() {
      pop.innerHTML = "";
      var head = document.createElement("div");
      head.className = "cal-head";
      var prev = document.createElement("button");
      prev.type = "button"; prev.className = "cal-nav"; prev.textContent = "‹";
      prev.addEventListener("click", function () {
        viewM--; if (viewM < 0) { viewM = 11; viewY--; } render();
      });
      var title = document.createElement("span");
      title.className = "cal-month-title";
      title.textContent = CAL_MONTHS[viewM] + " " + viewY;
      var next = document.createElement("button");
      next.type = "button"; next.className = "cal-nav"; next.textContent = "›";
      next.addEventListener("click", function () {
        viewM++; if (viewM > 11) { viewM = 0; viewY++; } render();
      });
      head.appendChild(prev); head.appendChild(title); head.appendChild(next);
      pop.appendChild(head);

      var grid = document.createElement("div");
      grid.className = "cal-grid";
      CAL_DAYS.forEach(function (d) {
        var wh = document.createElement("div");
        wh.className = "cal-weekday"; wh.textContent = d;
        grid.appendChild(wh);
      });
      var firstDow = new Date(viewY, viewM, 1).getDay();
      for (var b = 0; b < firstDow; b++) {
        var bl = document.createElement("div");
        bl.className = "cal-day cal-day-blank";
        grid.appendChild(bl);
      }
      var now = new Date();
      var todayIso = calIso(now.getFullYear(), now.getMonth(), now.getDate());
      var dim = new Date(viewY, viewM + 1, 0).getDate();
      for (var day = 1; day <= dim; day++) {
        (function (day) {
          var iso = calIso(viewY, viewM, day);
          var cell = document.createElement("div");
          cell.className = "cal-day";
          if (iso === todayIso) cell.classList.add("is-today");
          if (iso === input.value) cell.classList.add("is-selected");
          var num = document.createElement("span");
          num.className = "cal-day-num"; num.textContent = String(day);
          cell.appendChild(num);
          cell.addEventListener("click", function () {
            input.value = iso;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            syncDateLabels();
            closeCal();
          });
          grid.appendChild(cell);
        }(day));
      }
      pop.appendChild(grid);
    }

    render();
    trigger.parentNode.appendChild(pop);
    _openCal = pop;
  }

  document.querySelectorAll("[data-datepicker]").forEach(function (trigger) {
    var input = document.getElementById(trigger.dataset.datepicker);
    if (!input) return;
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      var wasOpen = _openCal && _openCal._owner === trigger;
      closeCal();
      if (!wasOpen) openCalFor(trigger, input);
    });
  });
  document.addEventListener("click", closeCal);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeCal(); });
  syncDateLabels();

  // Live refresh: re-fetch when the tab regains focus (debounced in fetchData).
  window.addEventListener("focus", function () { fetchData(false); });

  // Initial load.
  fetchData(true);
})();
