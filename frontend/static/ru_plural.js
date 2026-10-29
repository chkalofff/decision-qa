export function pluralRu(n, one, few, many) {
  const m = Math.abs(n) % 100;
  const d = m % 10;
  if (m > 10 && m < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
}

export function formatRu(n, one, few, many) {
  return `${n} ${pluralRu(n, one, few, many)}`;
}
