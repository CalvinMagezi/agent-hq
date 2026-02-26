// ─── Sprite Cache ─────────────────────────────────────────────────────────────
// WeakMap-per-zoom cache: avoids re-creating canvas elements on every frame.
// Key is the sprite grid array reference (object identity), value is a map from
// scale → HTMLCanvasElement.

type SpriteGrid = string[][];

// Cache: sprite grid reference → (scale → canvas)
const cache = new WeakMap<SpriteGrid, Map<number, HTMLCanvasElement>>();

/**
 * Render a pixel-art sprite grid to a canvas and cache by (grid, scale).
 * Returns a cached canvas if one already exists for this (grid, scale) pair.
 */
export function getCachedSprite(grid: SpriteGrid, scale: number): HTMLCanvasElement {
    let scaleMap = cache.get(grid);
    if (!scaleMap) {
        scaleMap = new Map();
        cache.set(grid, scaleMap);
    }

    let canvas = scaleMap.get(scale);
    if (!canvas) {
        canvas = renderSpriteToCanvas(grid, scale);
        scaleMap.set(scale, canvas);
    }

    return canvas;
}

/**
 * Evict all cached canvases for a given sprite grid (e.g. when sprite changes).
 */
export function invalidateCache(grid: SpriteGrid): void {
    cache.delete(grid);
}

/**
 * Render a pixel-art grid to an offscreen canvas.
 * Each non-empty cell in `grid` is drawn as a `scale × scale` filled square.
 */
function renderSpriteToCanvas(grid: SpriteGrid, scale: number): HTMLCanvasElement {
    const cols = grid[0]?.length ?? 0;
    const rows = grid.length;
    const canvas = document.createElement('canvas');
    canvas.width = cols * scale;
    canvas.height = rows * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const color = grid[r][c];
            if (color) {
                ctx.fillStyle = color;
                ctx.fillRect(c * scale, r * scale, scale, scale);
            }
        }
    }

    return canvas;
}
