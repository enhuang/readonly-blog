function slugify(title) {
  if (title == null) return '';
  const s = String(title)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { slugify };
