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
  var _rendered = {};       // panel id -> true once rendered for current data
  var _lastFetch = 0;

  // Panel definitions. `needs` optionally gates a tab's visibility.
  var PANELS = [
    { id: "overview", label: "Overview" },
    { id: "consistency", label: "Consistency" },
    { id: "tags", label: "Tags" },
    { id: "numeric", label: "Numeric", needs: hasNumeric },
    { id: "coverage", label: "Coverage" },
  ];

  // Filled by the chart sections (Tasks 11-13).
  var CHARTS = [];
  window.__ANALYTICS_CHARTS__ = CHARTS;  // exposed so chart files can push

  function hasNumeric() {
    return _data.sections.some(function (s) { return s.type === "numeric"; });
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
    renderActivePanel();
  });

  // Live refresh: re-fetch when the tab regains focus (debounced in fetchData).
  window.addEventListener("focus", function () { fetchData(false); });

  // Initial load.
  fetchData(true);
})();
