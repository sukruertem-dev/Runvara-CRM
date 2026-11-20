/**
 * Adding edge blocker -> blocked creates a cycle iff `blocked` already reaches `blocker`.
 * Returns the cycle as node ids starting and ending with `blocker`, else null.
 */
export function wouldCreateCycle(
  edges: readonly (readonly [blocker: string, blocked: string])[],
  add: readonly [string, string],
): string[] | null {
  const [blocker, blocked] = add;
  if (blocker === blocked) return [blocker, blocker];

  const adj = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const list = adj.get(from);
    if (list === undefined) adj.set(from, [to]);
    else list.push(to);
  }

  // Iterative DFS from `blocked` looking for `blocker`; parent map reconstructs the path.
  const parent = new Map<string, string | null>([[blocked, null]]);
  const stack: string[] = [blocked];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node === blocker) {
      const path: string[] = [];
      let cur: string | null | undefined = node;
      while (cur !== null && cur !== undefined) {
        path.push(cur);
        cur = parent.get(cur);
      }
      path.reverse(); // blocked ... blocker
      return [blocker, ...path];
    }
    for (const next of adj.get(node) ?? []) {
      if (!parent.has(next)) {
        parent.set(next, node);
        stack.push(next);
      }
    }
  }
  return null;
}
