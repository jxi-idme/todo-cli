/* journal-mood.js — click-to-pick mood for the entry form.
   Vanilla JS only, no third-party libraries.

   Seven Pompompurin GIFs (1..7) sit on the "What happened today" line. Mood is
   single-select and optional: click a GIF to select it (CSS dims the other six
   via the picker's `has-selection` class); click the selected one again to
   deselect. The chosen value (1..7, or "") is mirrored into a hidden input
   (name="mood") that posts with the form. The template pre-renders the saved
   state server-side; this script keeps it in sync on interaction.
*/

(function () {
  'use strict';

  var picker = document.querySelector('.mood-picker');
  if (!picker) return;
  var input = document.querySelector('.mood-input');
  if (!input) return;
  var opts = picker.querySelectorAll('.mood-opt');

  function select(opt) {
    for (var i = 0; i < opts.length; i++) {
      opts[i].classList.toggle('selected', opts[i] === opt);
    }
    picker.classList.add('has-selection');
    input.value = opt.getAttribute('data-mood') || '';
  }

  function deselect() {
    for (var i = 0; i < opts.length; i++) {
      opts[i].classList.remove('selected');
    }
    picker.classList.remove('has-selection');
    input.value = '';
  }

  for (var i = 0; i < opts.length; i++) {
    opts[i].addEventListener('click', function () {
      if (this.classList.contains('selected')) {
        deselect();
      } else {
        select(this);
      }
    });
  }

  // Reconcile from the hidden input on load (defensive; the template already
  // pre-renders the classes).
  var current = (input.value || '').trim();
  if (current === '') {
    deselect();
  } else {
    for (var j = 0; j < opts.length; j++) {
      if (opts[j].getAttribute('data-mood') === current) {
        select(opts[j]);
        break;
      }
    }
  }
})();
