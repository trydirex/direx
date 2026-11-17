// SPDX-License-Identifier: AGPL-3.0-only
// Pure. A Person group is a connected component of records joined by live links
// (proposed or merged); its id is the lowest record id in it.

/** Maps each record to its group's id. Records with no live link are their own group. */
export function groupIds(records: readonly string[], liveLinks: readonly (readonly [string, string])[]): Map<string, string> {
  const parent = new Map(records.map((r) => [r, r]));
  const find = (r: string): string => {
    let root = r;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(r, root);
    return root;
  };
  for (const [a, b] of liveLinks) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const [ra, rb] = [find(a), find(b)];
    // The lower id stays the root, so every root is its component's lowest id.
    if (ra < rb) parent.set(rb, ra);
    else if (rb < ra) parent.set(ra, rb);
  }
  return new Map(records.map((r) => [r, find(r)]));
}

/** A link always stores the lower id first. */
export const ordered = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
