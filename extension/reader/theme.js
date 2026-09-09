// AtomicVaultReader — the theme stamp.
//
// Loaded in <head>, before the body paints. Its only job is to put the resolved
// theme on <html> early enough that the reader never flashes light before going
// dark. matchMedia is synchronous, so this costs one statement.
//
// reader.js re-stamps a moment later if the reader has stored an override, and
// owns the control and the listener. This file owns the first paint and nothing
// else.

(function () {
  var root = document.documentElement;
  var dark = false;

  try {
    dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (err) {
    // No matchMedia. Light is the base theme, so an absent signal means light.
  }

  root.setAttribute("data-theme", dark ? "dark" : "light");
})();
