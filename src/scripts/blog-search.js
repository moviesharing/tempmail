const search = document.querySelector("[data-blog-search]");
const cards = [...document.querySelectorAll("[data-article-card]")];
const empty = document.querySelector("[data-search-empty]");

search?.addEventListener("input", () => {
  const query = search.value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const card of cards) {
    const matches = card.dataset.search?.includes(query) ?? true;
    card.hidden = !matches;
    if (matches) visible += 1;
  }
  if (empty) empty.hidden = visible !== 0;
});
