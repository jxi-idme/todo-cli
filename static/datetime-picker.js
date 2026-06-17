/* Custom themed datetime picker — replaces the native <input type=datetime-local>
 * popup (calendar + clock, un-stylable) with a dark calendar popover plus themed
 * time inputs, consistent with the rest of the app.
 *
 * Progressive enhancement: the real datetime-local input stays in the form
 * (hidden but still named, value kept as "YYYY-MM-DDTHH:MM") so submission is
 * unchanged. Auto-enhances every datetime-local input on DOMContentLoaded.
 */
(function () {
  "use strict";

  var MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  var WK = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  var _open = null;
  function closeOpen() {
    if (_open) { _open.pop.remove(); _open = null; }
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(y, m, d) { return y + "-" + pad(m + 1) + "-" + pad(d); }

  // Parse "YYYY-MM-DDTHH:MM" -> {date:"YYYY-MM-DD", h, min} or null.
  function parseVal(v) {
    var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(v || "");
    if (!m) return null;
    return { date: m[1], h: parseInt(m[2], 10), min: parseInt(m[3], 10) };
  }

  function labelFor(v) {
    var p = parseVal(v);
    return p ? p.date + " " + pad(p.h) + ":" + pad(p.min) : "no due date";
  }

  function enhance(input) {
    if (input.dataset.enhanced) return;
    input.dataset.enhanced = "1";

    var wrap = document.createElement("div");
    wrap.className = "dt-field";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add("cs-native");

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cs-trigger dt-trigger";
    trigger.setAttribute("aria-haspopup", "dialog");
    var valueSpan = document.createElement("span");
    valueSpan.className = "cs-value";
    valueSpan.textContent = labelFor(input.value);
    var caret = document.createElement("span");
    caret.className = "cal-caret";
    caret.textContent = "▾";
    trigger.appendChild(valueSpan);
    trigger.appendChild(caret);
    wrap.appendChild(trigger);

    function commit(dateStr, h, min) {
      input.value = dateStr ? dateStr + "T" + pad(h) + ":" + pad(min) : "";
      valueSpan.textContent = labelFor(input.value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function openPopover() {
      var cur = parseVal(input.value);
      var selDate = cur ? cur.date : null;
      var h = cur ? cur.h : 9, min = cur ? cur.min : 0;
      var base = selDate ? new Date(selDate + "T00:00:00") : new Date();
      var viewY = base.getFullYear(), viewM = base.getMonth();

      var pop = document.createElement("div");
      pop.className = "cal-popover dt-popover";
      pop.addEventListener("click", function (e) { e.stopPropagation(); });

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
        title.textContent = MONTHS[viewM] + " " + viewY;
        var next = document.createElement("button");
        next.type = "button"; next.className = "cal-nav"; next.textContent = "›";
        next.addEventListener("click", function () {
          viewM++; if (viewM > 11) { viewM = 0; viewY++; } render();
        });
        head.appendChild(prev); head.appendChild(title); head.appendChild(next);
        pop.appendChild(head);

        var grid = document.createElement("div");
        grid.className = "cal-grid";
        WK.forEach(function (d) {
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
        var todayIso = iso(now.getFullYear(), now.getMonth(), now.getDate());
        var dim = new Date(viewY, viewM + 1, 0).getDate();
        for (var day = 1; day <= dim; day++) {
          (function (day) {
            var dIso = iso(viewY, viewM, day);
            var cell = document.createElement("div");
            cell.className = "cal-day";
            if (dIso === todayIso) cell.classList.add("is-today");
            if (dIso === selDate) cell.classList.add("is-selected");
            var num = document.createElement("span");
            num.className = "cal-day-num"; num.textContent = String(day);
            cell.appendChild(num);
            cell.addEventListener("click", function () {
              selDate = dIso;
              commit(selDate, readH(), readMin());
              render();
            });
            grid.appendChild(cell);
          }(day));
        }
        pop.appendChild(grid);

        // Time row: HH : MM (24h) with themed steppers, plus a clear button.
        var timeRow = document.createElement("div");
        timeRow.className = "dt-time-row";

        function onTime() {
          h = readH(); min = readMin();
          if (selDate) commit(selDate, h, min);
        }

        // A number field with custom ▲/▼ steppers (native spinners are hidden
        // via CSS). Values wrap around their max for quick HH/MM entry.
        function timeField(initial, max) {
          var fwrap = document.createElement("div");
          fwrap.className = "dt-time-wrap";
          var input = document.createElement("input");
          input.type = "number"; input.min = 0; input.max = max;
          input.className = "dt-time"; input.value = pad(initial);
          var steps = document.createElement("div");
          steps.className = "dt-step";
          var up = document.createElement("button");
          up.type = "button"; up.className = "dt-step-btn dt-up";
          up.setAttribute("aria-label", "increment");
          var down = document.createElement("button");
          down.type = "button"; down.className = "dt-step-btn dt-down";
          down.setAttribute("aria-label", "decrement");
          function set(n) {
            if (n < 0) n = max;
            if (n > max) n = 0;
            input.value = pad(n);
            onTime();
          }
          up.addEventListener("click", function (e) {
            e.stopPropagation(); set((parseInt(input.value, 10) || 0) + 1);
          });
          down.addEventListener("click", function (e) {
            e.stopPropagation(); set((parseInt(input.value, 10) || 0) - 1);
          });
          steps.appendChild(up); steps.appendChild(down);
          fwrap.appendChild(input); fwrap.appendChild(steps);
          return { el: fwrap, input: input };
        }

        var hField = timeField(h, 23), mField = timeField(min, 59);
        var hInput = hField.input, mInput = mField.input;

        function readH() {
          var n = parseInt(hInput.value, 10);
          return isNaN(n) ? 0 : Math.max(0, Math.min(23, n));
        }
        function readMin() {
          var n = parseInt(mInput.value, 10);
          return isNaN(n) ? 0 : Math.max(0, Math.min(59, n));
        }
        hInput.addEventListener("change", onTime);
        mInput.addEventListener("change", onTime);
        // expose for the day-cell handlers above
        render.readH = readH; render.readMin = readMin;

        var colon = document.createElement("span");
        colon.className = "dt-colon"; colon.textContent = ":";
        timeRow.appendChild(hField.el);
        timeRow.appendChild(colon);
        timeRow.appendChild(mField.el);

        var clear = document.createElement("button");
        clear.type = "button"; clear.className = "dt-clear"; clear.textContent = "clear";
        clear.addEventListener("click", function () {
          selDate = null; commit("", 0, 0); closeOpen();
        });
        timeRow.appendChild(clear);
        pop.appendChild(timeRow);
      }

      // readH/readMin need to exist before the first render's day handlers fire;
      // they are only called on click, which happens after render completes.
      function readH() { return render.readH ? render.readH() : h; }
      function readMin() { return render.readMin ? render.readMin() : min; }

      render();
      wrap.appendChild(pop);
      _open = { pop: pop, owner: trigger };
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      var wasOpen = _open && _open.owner === trigger;
      closeOpen();
      if (!wasOpen) openPopover();
    });
  }

  document.addEventListener("click", closeOpen);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeOpen();
  });
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll('input[type="datetime-local"]').forEach(enhance);
  });
}());
