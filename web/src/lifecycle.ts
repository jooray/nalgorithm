/** Explicit cleanup for observers/subscriptions owned by disposable DOM subtrees. */
const cleanups = new WeakMap<Element, Array<() => void>>()
export function onDispose(element: Element, cleanup: () => void): void {
  const list = cleanups.get(element) ?? []
  list.push(cleanup)
  cleanups.set(element, list)
}
export function disposeTree(root: Element): void {
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const cleanup of cleanups.get(node) ?? []) cleanup()
    cleanups.delete(node)
  }
}
