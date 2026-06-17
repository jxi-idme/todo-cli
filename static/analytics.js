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
  var _lastFetch = 0;

  // Panel definitions. `needs` optionally gates a tab's visibility.
  var PANELS = [
    { id: "overview", label: "Overview" },
    { id: "consistency", label: "Consistency" },
    { id: "tags", label: "Tags" },
    { id: "numeric", label: "Numeric", needs: hasNumeric },
    { id: "coverage", label: "Coverage" },
    { id: "tasks", label: "Tasks", needs: hasTasks },
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
      accent: v("--accent"), danger: v("--danger"),
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

  CHARTS.push({
    id: "overview-summary",
    panel: "overview",
    title: "Overview",
    render: function (container, entries, sections, c) {
      if (!entries.length) { U.empty(container, "No entries in this range."); return; }
      var dates = uniqueDates(entries);
      var st = streaks(dates);
      var words = entries.map(function (e) { return (e.body || "").split(/\s+/).filter(Boolean).length; });
      var wd = U.describe(words);
      var coveredCounts = entries.map(function (e) {
        var n = 0;
        sections.forEach(function (s) {
          var t = (e.tags || {})[s.id];
          if ((t && t.length) || (e.numbers || {})[s.id] != null) n++;
        });
        return n;
      });
      var avgCov = U.describe(coveredCounts).mean;
      U.statsRow(container, [
        ["entries", entries.length],
        ["current streak", st.current + "d"],
        ["longest streak", st.longest + "d"],
        ["last entry", dates[dates.length - 1]],
        ["avg words/entry", U.fmt(wd.mean)],
        ["avg sections filled", U.fmt(avgCov)],
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
    id: "task-throughput", panel: "tasks", title: "Tasks completed per day",
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
    id: "task-overdue", panel: "tasks", title: "On-time vs late & expired",
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
    id: "task-adherence", panel: "tasks", title: "Recurring-task adherence",
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
    id: "task-difficulty", panel: "tasks", title: "Difficulty of completed tasks",
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
    id: "task-tag-frequency", panel: "tasks", title: "Task tag frequency",
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
    id: "task-numeric-scatter", panel: "tasks",
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
    id: "task-entry-calendar", panel: "tasks", title: "Entries & task completions",
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
      U.drawDot(legend, 120, 11, 4, U.colorMix(c.accent, 45));
      U.text(legend, 130, 14, "task completed", c.muted, { size: 9 });
      container.appendChild(legend);
      U.statsRow(container, [["entry days", entryDates.length],
                             ["completion days", doneDates.length]]);
    },
  });

  // ----- date filtering -----
  function filterEntries() {
    return _data.entries.filter(function (e) {
      return (!_from || e.date >= _from) && (!_to || e.date <= _to);
    });
  }

  // ----- tabs -----
  function buildTabs() {
    var bar = root.querySelector(".analytics-tabs");
    bar.innerHTML = "";
    PANELS.forEach(function (p) {
      if (p.needs && !p.needs()) return;
      var btn = document.createElement("button");
      btn.className = "analytics-tab" + (p.id === _activeTab ? " active" : "");
      btn.textContent = p.label;
      btn.dataset.panel = p.id;
      btn.addEventListener("click", function () { switchTab(p.id); });
      bar.appendChild(btn);
    });
    // If the active tab got hidden (e.g. numeric data removed), fall back.
    if (!PANELS.some(function (p) {
      return p.id === _activeTab && (!p.needs || p.needs());
    })) {
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

  // ----- data load -----
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
    syncDateLabels();
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
    renderActivePanel();
  });
  document.getElementById("date-to").addEventListener("change", function (e) {
    _to = e.target.value || null;
    renderActivePanel();
  });
  document.getElementById("date-reset").addEventListener("click", function () {
    _from = _data.date_range.min;
    _to = _data.date_range.max;
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
