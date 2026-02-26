// ─── BFS Pathfinding ──────────────────────────────────────────────────────────
// 4-connected BFS on a tile grid. Agents pathfind around furniture footprints
// instead of walking through them.

/**
 * Compute the set of blocked tile coordinates from placed furniture.
 * Returns a Set of "col,row" strings for O(1) lookup.
 *
 * @param furniture  Array of { col, row, footprint: [cols, rows] }
 * @param gridCols   Total grid width  (to clamp bounds)
 * @param gridRows   Total grid height (to clamp bounds)
 */
export function computeBlockedTiles(
    furniture: Array<{ col: number; row: number; footprint: [number, number] }>,
    gridCols: number,
    gridRows: number
): Set<string> {
    const blocked = new Set<string>();
    for (const f of furniture) {
        for (let dc = 0; dc < f.footprint[0]; dc++) {
            for (let dr = 0; dr < f.footprint[1]; dr++) {
                const c = f.col + dc;
                const r = f.row + dr;
                if (c >= 0 && c < gridCols && r >= 0 && r < gridRows) {
                    blocked.add(`${c},${r}`);
                }
            }
        }
    }
    return blocked;
}

/**
 * BFS pathfinding on a 4-connected tile grid.
 * Returns an array of [col, row] waypoints from start to goal (inclusive),
 * or null if no path exists.
 *
 * @param startCol   Start column
 * @param startRow   Start row
 * @param goalCol    Goal column
 * @param goalRow    Goal row
 * @param blockedTiles  Set of "col,row" strings that are impassable
 * @param gridCols   Grid width
 * @param gridRows   Grid height
 */
export function bfsPath(
    startCol: number,
    startRow: number,
    goalCol: number,
    goalRow: number,
    blockedTiles: Set<string>,
    gridCols: number,
    gridRows: number
): [number, number][] | null {
    // Trivial case
    if (startCol === goalCol && startRow === goalRow) return [[startCol, startRow]];

    const goalKey = `${goalCol},${goalRow}`;
    const startKey = `${startCol},${startRow}`;

    // Allow pathfinding to/from desks even if their origin tile is "blocked"
    // (agents need to reach the desk tile itself)
    const visited = new Set<string>([startKey]);
    const parent = new Map<string, string | null>([[startKey, null]]);
    const queue: [number, number][] = [[startCol, startRow]];

    const DIRS: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

    while (queue.length > 0) {
        const [c, r] = queue.shift()!;
        const key = `${c},${r}`;

        if (key === goalKey) {
            // Reconstruct path
            const path: [number, number][] = [];
            let cur: string | null = goalKey;
            while (cur !== null) {
                const [pc, pr] = cur.split(',').map(Number);
                path.unshift([pc, pr]);
                cur = parent.get(cur) ?? null;
            }
            return path;
        }

        for (const [dc, dr] of DIRS) {
            const nc = c + dc;
            const nr = r + dr;
            const nk = `${nc},${nr}`;

            if (nc < 0 || nc >= gridCols || nr < 0 || nr >= gridRows) continue;
            if (visited.has(nk)) continue;
            // Allow the goal tile even if it's "blocked" (e.g. the desk itself)
            if (blockedTiles.has(nk) && nk !== goalKey) continue;

            visited.add(nk);
            parent.set(nk, key);
            queue.push([nc, nr]);
        }
    }

    return null; // No path found
}

/**
 * Generate seat positions from chair-type furniture entries.
 * A seat is 1 tile in front of the chair (based on facing direction).
 *
 * @param chairs  Array of placed chairs with their grid position
 */
export function generateSeatsFromChairs(
    chairs: Array<{ col: number; row: number; label: string }>
): Array<{ col: number; row: number; label: string; facing: 'up' | 'down' | 'left' | 'right' }> {
    return chairs.map(c => ({
        col: c.col,
        row: c.row,
        label: c.label,
        facing: 'up' as const, // Chairs default to facing upward (toward desk)
    }));
}
