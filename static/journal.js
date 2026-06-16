/* journal.js — custom dark calendar widget for the journal entry form.
   Vanilla JS only, no third-party libraries. */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Helpers                                                              */
  /* ------------------------------------------------------------------ */

  var DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  var MONTHS_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  /** Format a YYYY-MM-DD string as e.g. "Sat, Jun 20 2026". */
  function prettyDate(iso) {
    var parts = iso.split('-');
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    var dow = new Date(y, m, d).getDay();
    return DAYS[dow] + ', ' + MONTHS_SHORT[m] + ' ' + d + ' ' + y;
  }

  /** Pad a number to 2 digits. */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** Build a YYYY-MM-DD string from year, month (0-based), day. */
  function toISO(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }

  /** Today as YYYY-MM-DD (local time). */
  function todayISO() {
    var t = new Date();
    return toISO(t.getFullYear(), t.getMonth(), t.getDate());
  }

  /* ------------------------------------------------------------------ */
  /* State                                                                */
  /* ------------------------------------------------------------------ */

  var entryDatesEl = document.getElementById('entry-dates-data');
  if (!entryDatesEl) return;  // not on a journal entry page, bail out
  var entryDatesSet = new Set(JSON.parse(entryDatesEl.textContent || '[]'));

  var calField = document.querySelector('.cal-field');
  if (!calField) return;

  var currentDate = calField.getAttribute('data-current-date');
  var isSaved     = calField.getAttribute('data-is-saved') === 'true';

  var trigger      = calField.querySelector('.cal-trigger');
  var triggerLabel = calField.querySelector('.cal-trigger-label');
  var hiddenInput  = calField.querySelector('.cal-input');

  var moveBtn   = document.querySelector('.move-btn');
  var moveInput = document.querySelector('.move-input');
  var moveForm  = document.getElementById('move-form');

  /* Dirty tracking -- set true when the user edits any journal field. */
  var dirty = false;

  var trackSelectors = [
    'input[name="title"]',
    'textarea[name="body"]',
    'input[name^="tag:"]',
    'input[name^="num:"]',
    'input[name^="newtag-name:"]',
    'select[name^="newtag-kind:"]'
  ];
  trackSelectors.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) {
      el.addEventListener('input',  function () { dirty = true; });
      el.addEventListener('change', function () { dirty = true; });
    });
  });

  /* ------------------------------------------------------------------ */
  /* Calendar popover                                                     */
  /* ------------------------------------------------------------------ */

  var popover = null;     // the currently open popover element
  var moveMode = false;   // true when opened by the Move button
  var viewYear, viewMonth;  // month currently shown in the popover

  /** Open the calendar popover. Pass `inMoveMode=true` for the move flow. */
  function openPopover(inMoveMode) {
    if (popover) closePopover();
    moveMode = !!inMoveMode;

    var selDate = hiddenInput.value || currentDate;
    var parts   = selDate.split('-');
    viewYear  = parseInt(parts[0], 10);
    viewMonth = parseInt(parts[1], 10) - 1;

    popover = document.createElement('div');
    popover.className = 'cal-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'true');

    renderPopover();
    calField.appendChild(popover);

    // Close on outside click
    setTimeout(function () {
      document.addEventListener('click', outsideClick);
      document.addEventListener('keydown', escKey);
    }, 0);
  }

  function closePopover() {
    if (popover) {
      popover.parentNode && popover.parentNode.removeChild(popover);
      popover = null;
    }
    document.removeEventListener('click', outsideClick);
    document.removeEventListener('keydown', escKey);
  }

  function outsideClick(e) {
    if (popover && !calField.contains(e.target) &&
        (!moveBtn || !moveBtn.contains(e.target))) {
      closePopover();
    }
  }

  function escKey(e) {
    if (e.key === 'Escape') closePopover();
  }

  /** Re-render the popover contents for the current viewYear/viewMonth. */
  function renderPopover() {
    if (!popover) return;
    popover.innerHTML = '';

    var today    = todayISO();
    var selDate  = hiddenInput.value || currentDate;

    // Header
    var head = document.createElement('div');
    head.className = 'cal-head';

    var prev = document.createElement('button');
    prev.type = 'button';
    prev.textContent = '‹';
    prev.className = 'cal-nav';
    prev.addEventListener('click', function (e) {
      e.stopPropagation();
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      renderPopover();
    });

    var title = document.createElement('span');
    title.className = 'cal-month-title';
    title.textContent = MONTHS[viewMonth] + ' ' + viewYear;

    var next = document.createElement('button');
    next.type = 'button';
    next.textContent = '›';
    next.className = 'cal-nav';
    next.addEventListener('click', function (e) {
      e.stopPropagation();
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      renderPopover();
    });

    head.appendChild(prev);
    head.appendChild(title);
    head.appendChild(next);
    popover.appendChild(head);

    // Grid
    var grid = document.createElement('div');
    grid.className = 'cal-grid';

    // Weekday headers
    DAYS.forEach(function (d) {
      var wh = document.createElement('div');
      wh.className = 'cal-weekday';
      wh.textContent = d.slice(0, 2);
      grid.appendChild(wh);
    });

    // Leading blank cells
    var firstDow = new Date(viewYear, viewMonth, 1).getDay();
    for (var b = 0; b < firstDow; b++) {
      var blank = document.createElement('div');
      blank.className = 'cal-day cal-day-blank';
      grid.appendChild(blank);
    }

    // Day cells
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      var iso = toISO(viewYear, viewMonth, day);
      var cell = document.createElement('div');
      cell.className = 'cal-day';

      var num = document.createElement('span');
      num.className = 'cal-day-num';
      num.textContent = String(day);
      cell.appendChild(num);

      if (iso === today) cell.classList.add('is-today');
      // Selection highlight is only meaningful when navigating, not when
      // choosing a move target -- otherwise the current (occupied) date would
      // collide with the disabled style in move mode.
      if (iso === selDate && !moveMode) cell.classList.add('is-selected');

      if (entryDatesSet.has(iso)) {
        if (moveMode) {
          // In move mode, occupied days are disabled
          cell.classList.add('is-disabled');
        } else {
          var dot = document.createElement('span');
          dot.className = 'cal-dot';
          cell.appendChild(dot);
        }
      }

      if (!cell.classList.contains('is-disabled')) {
        (function (dateStr) {
          cell.addEventListener('click', function (e) {
            e.stopPropagation();
            handleDayClick(dateStr);
          });
        })(iso);
      }

      grid.appendChild(cell);
    }

    popover.appendChild(grid);
  }

  /* ------------------------------------------------------------------ */
  /* Day click logic                                                      */
  /* ------------------------------------------------------------------ */

  function handleDayClick(dateStr) {
    if (moveMode) {
      // Move mode: submit the move form
      moveInput.value = dateStr;
      closePopover();
      moveForm.submit();
      return;
    }

    if (isSaved) {
      // Saved entry: navigate to that day, with dirty-check
      if (dirty) {
        confirmModal('You have unsaved changes that will be lost. Continue?')
          .then(function (confirmed) {
            if (confirmed) {
              closePopover();
              window.location = '/journal/' + dateStr;
            }
          });
      } else {
        closePopover();
        window.location = '/journal/' + dateStr;
      }
    } else {
      // New (unsaved) entry
      if (entryDatesSet.has(dateStr)) {
        confirmModal(
          'Opening ' + prettyDate(dateStr) + ' will discard your current entry. Continue?'
        ).then(function (confirmed) {
          if (confirmed) {
            closePopover();
            window.location = '/journal/' + dateStr;
          }
        });
      } else {
        // Empty day: just update the date field in place, no navigation
        hiddenInput.value = dateStr;
        triggerLabel.textContent = dateStr;
        currentDate = dateStr;    // update so selected highlight is right
        closePopover();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Dark confirm modal                                                   */
  /* ------------------------------------------------------------------ */

  var modalOverlay = null;

  function buildModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.hidden = true;

    var box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    var msg = document.createElement('p');
    msg.className = 'modal-msg';

    var actions = document.createElement('div');
    actions.className = 'modal-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'modal-cancel';
    cancelBtn.textContent = 'Cancel';

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'modal-confirm';
    confirmBtn.textContent = 'Continue';

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(msg);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    return { overlay: overlay, msg: msg, cancelBtn: cancelBtn, confirmBtn: confirmBtn };
  }

  /** Show the dark confirm modal. Returns a Promise<bool>. */
  function confirmModal(message) {
    if (!modalOverlay) {
      var built = buildModal();
      modalOverlay = built;
    }
    var o = modalOverlay;
    o.msg.textContent = message;
    o.overlay.hidden = false;

    return new Promise(function (resolve) {
      function cleanup() {
        o.overlay.hidden = true;
        o.cancelBtn.removeEventListener('click', onCancel);
        o.confirmBtn.removeEventListener('click', onConfirm);
        o.overlay.removeEventListener('click', onOverlayClick);
        document.removeEventListener('keydown', onEsc);
      }
      function onConfirm() { cleanup(); resolve(true);  }
      function onCancel()  { cleanup(); resolve(false); }
      function onOverlayClick(e) {
        if (e.target === o.overlay) { cleanup(); resolve(false); }
      }
      function onEsc(e) {
        if (e.key === 'Escape') { cleanup(); resolve(false); }
      }
      o.cancelBtn.addEventListener('click',  onCancel);
      o.confirmBtn.addEventListener('click', onConfirm);
      o.overlay.addEventListener('click',    onOverlayClick);
      document.addEventListener('keydown',   onEsc);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Wire up events                                                        */
  /* ------------------------------------------------------------------ */

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    if (popover && !moveMode) {
      closePopover();
    } else {
      openPopover(false);
    }
  });

  if (moveBtn) {
    moveBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (popover && moveMode) {
        closePopover();
      } else {
        openPopover(true);
      }
    });
  }

})();
