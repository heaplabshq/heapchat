/* Bounded-concurrency map: run `fn` over `items` with at most `limit` in flight,
   preserving result order. */
async function mapLimit(items, limit, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const j = i++; res[j] = await fn(items[j]); } }));
  return res;
}

module.exports = { mapLimit };
