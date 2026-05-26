const toggle = document.getElementById("faq-toggle-all");
const items = Array.from(document.querySelectorAll(".faq-item"));

function sync() {
  const allOpen = items.every((item) => item.open);
  toggle.textContent = allOpen ? "collapse all" : "expand all";
  toggle.setAttribute("aria-expanded", String(allOpen));
}

if (toggle && items.length) {
  toggle.addEventListener("click", () => {
    const expand = !items.every((item) => item.open);
    // Pin the scroll position: the first toggle after a mid-page reload can
    // otherwise drift as the browser reconciles scroll anchoring/restoration
    // on the forced layout. Re-assert on the next frame to beat async adjust.
    const y = window.scrollY;
    items.forEach((item) => (item.open = expand));
    sync();
    window.scrollTo(0, y);
    requestAnimationFrame(() => window.scrollTo(0, y));
  });
  items.forEach((item) => item.addEventListener("toggle", sync));
}
