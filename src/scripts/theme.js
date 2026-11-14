const root = document.documentElement;
const toggle = document.querySelector("[data-theme-toggle]");
const navToggle = document.querySelector("[data-nav-toggle]");
const nav = document.querySelector("[data-primary-nav]");

function setTheme(theme) {
  root.dataset.theme = theme;
  try {
    localStorage.setItem("tempmail-theme", theme);
  } catch {
    // Theme remains active for this page when storage is unavailable.
  }
  toggle?.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
}

let preference = "light";
try {
  preference = localStorage.getItem("tempmail-theme") || "light";
} catch {
  preference = "light";
}
setTheme(preference === "dark" ? "dark" : "light");

toggle?.addEventListener("click", () => {
  setTheme(root.dataset.theme === "dark" ? "light" : "dark");
});

navToggle?.addEventListener("click", () => {
  const expanded = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!expanded));
  navToggle.setAttribute("aria-label", expanded ? "Open navigation" : "Close navigation");
  nav?.classList.toggle("nav-open", !expanded);
});
