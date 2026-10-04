/** Work-conserving pool with a bounded number of active operations. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>, deadline = Infinity): Promise<R[]> {
  const out: R[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (Date.now() < deadline) {
      const index = next++
      if (index >= items.length) return
      out[index] = await work(items[index], index)
    }
  }))
  return out.filter((v) => v !== undefined)
}
