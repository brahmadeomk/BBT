/*
 * On-screen keyboard policy — WHEN the keyboard should be up.
 *
 * Runs in the BROWSER (injected into every dashboard page by the "OSK Focus
 * Watcher" global ui_template) and in Node under `node --test`. It is the same
 * file in both: `test/hmi/osk-policy.test.js` asserts the copy embedded in
 * flows_BBT.json is byte-identical to this one, so the tested code and the
 * shipped code cannot drift.
 *
 * WHY NOT onboard's OWN auto-show. onboard finds focused text fields through
 * AT-SPI, which for a web page means Chromium must build an accessibility tree
 * for the whole dashboard (--force-renderer-accessibility). That is paid on
 * every repaint, on a panel where §12 spent weeks getting Node-RED from 106% to
 * 23% of a core, to save one tap. The dashboard already knows exactly which
 * element has focus — `focusin` tells it for free. So the policy lives here and
 * onboard is driven over D-Bus, with its own auto-show left off.
 *
 * WHY A DELAYED HIDE. Moving between two fields fires focusout then focusin.
 * Hiding immediately would flap the keyboard on every tab between cells of the
 * Modbus Settings table. A blur only ARMS a hide; a focus inside the window
 * cancels it. The window also covers the case where tapping the keyboard itself
 * momentarily moves focus — onboard uses XTEST and an unfocusable window so it
 * should not, but a 400 ms grace costs nothing and a flapping keyboard on a
 * commissioning screen is miserable.
 *
 * The policy is a pure reducer: it never touches the DOM, never calls D-Bus and
 * never reads a clock. Callers pass `nowMs` and act on the returned command.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BusductOskPolicy = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_HIDE_DELAY_MS = 400;

  /* Input types that take typed characters. Everything else either has its own
   * picker (date, color, file) or is a click target (button, checkbox, range) —
   * raising a keyboard over those is worse than not raising one, because it
   * covers the control the operator is trying to hit. */
  var TEXT_INPUT_TYPES = {
    text: true, password: true, number: true, email: true,
    tel: true, search: true, url: true, '': true,
  };

  /**
   * @param {{tag?: string, type?: string, readOnly?: boolean, disabled?: boolean,
   *          isContentEditable?: boolean}} field - a plain descriptor, NOT a DOM node,
   *          so this is testable without a DOM.
   */
  function isTextEntry(field) {
    if (!field || field.disabled || field.readOnly) return false;
    if (field.isContentEditable) return true;
    var tag = String(field.tag || '').toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    return TEXT_INPUT_TYPES[String(field.type == null ? '' : field.type).toLowerCase()] === true;
  }

  function createOskPolicy(options) {
    var opts = options || {};
    var hideDelayMs = typeof opts.hideDelayMs === 'number' ? opts.hideDelayMs : DEFAULT_HIDE_DELAY_MS;

    var visible = false;
    var hideAtMs = null;

    /* `command` is what to ask onboard for, or null when nothing should change.
     * Returning null rather than a redundant 'show' matters: each command is one
     * exec spawn on the Pi, and tabbing across a 9-column table would otherwise
     * fire one per cell. `nextTickMs` is when the caller should call tick(). */
    function result(command, nextTickMs) {
      return { command: command || null, nextTickMs: typeof nextTickMs === 'number' ? nextTickMs : null, visible: visible };
    }

    return {
      /** A focusin landed on `field`. */
      focus: function (field, nowMs) {
        if (!isTextEntry(field)) {
          /* Focus moved to something that is not a text field — a button, a
           * dropdown, the page body. That is a real reason to put the keyboard
           * away, but through the same armed-hide path, so tapping a spinner
           * between two fields does not flap it. */
          if (visible && hideAtMs === null) {
            hideAtMs = nowMs + hideDelayMs;
            return result(null, hideAtMs);
          }
          return result(null, hideAtMs);
        }
        hideAtMs = null;                       // cancel any armed hide
        if (visible) return result(null, null); // already up: say nothing
        visible = true;
        return result('show', null);
      },

      /** A focusout left a field and nothing has taken focus yet. */
      blur: function (nowMs) {
        if (!visible) return result(null, null);
        hideAtMs = nowMs + hideDelayMs;
        return result(null, hideAtMs);
      },

      /** Call at (or after) the last `nextTickMs`. */
      tick: function (nowMs) {
        if (!visible || hideAtMs === null || nowMs < hideAtMs) {
          return result(null, hideAtMs);
        }
        hideAtMs = null;
        visible = false;
        return result('hide', null);
      },

      /** Enter pressed, or the operator pressed a Done/Apply control: put it away now. */
      done: function () {
        hideAtMs = null;
        if (!visible) return result(null, null);
        visible = false;
        return result('hide', null);
      },

      /** The dashboard page was hidden or navigated away. Never leave it up. */
      pageHidden: function () {
        return this.done();
      },

      /** On-demand: a keyboard button on the HMI, or onboard's own icon palette. */
      toggle: function () {
        hideAtMs = null;
        visible = !visible;
        return result(visible ? 'show' : 'hide', null);
      },

      /* Reconciles with what onboard actually is, e.g. after the operator closed
       * it from its own title bar. Without this the policy would believe it is
       * still up and never send another 'show'. */
      syncVisible: function (actuallyVisible) {
        visible = !!actuallyVisible;
        hideAtMs = null;
        return result(null, null);
      },

      isVisible: function () { return visible; },
    };
  }

  return { createOskPolicy: createOskPolicy, isTextEntry: isTextEntry, DEFAULT_HIDE_DELAY_MS: DEFAULT_HIDE_DELAY_MS };
}));
