/* Apply the saved theme before first paint. SWEEO's default is light. */
(() => {
  "use strict";
  let theme = "light";
  try { if (localStorage.getItem("sweeo-theme") === "dark") theme = "dark"; } catch (_) { /* Storage may be unavailable. */ }
  document.documentElement.dataset.theme = theme;
  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("themeSwitch");
    function updateButton() {
      const dark = document.documentElement.dataset.theme === "dark";
      const en = document.documentElement.lang === "en";
      button.setAttribute("aria-pressed", String(dark));
      button.setAttribute("aria-label", en ? (dark ? "Light mode" : "Dark mode") : (dark ? "โหมดสว่าง" : "โหมดมืด"));
      button.title = button.getAttribute("aria-label");
    }
    button.addEventListener("click", () => {
      theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = theme;
      try { localStorage.setItem("sweeo-theme", theme); } catch (_) { /* The toggle still works for this page. */ }
      updateButton();
    });
    updateButton();
  });
})();
