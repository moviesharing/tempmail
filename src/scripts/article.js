const progress = document.querySelector("[data-reading-progress]");
const article = document.querySelector(".article-content");

if (progress && article) {
  let scheduled = false;
  const update = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      const bounds = article.getBoundingClientRect();
      const available = article.offsetHeight + Math.max(0, window.innerHeight * 0.6);
      const distance = Math.min(available, Math.max(0, window.innerHeight * 0.6 - bounds.top));
      progress.style.transform = `scaleX(${available ? distance / available : 0})`;
      scheduled = false;
    });
  };
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}
