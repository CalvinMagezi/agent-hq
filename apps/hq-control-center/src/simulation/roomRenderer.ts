// ─── Room Renderer ────────────────────────────────────────────────────────────
// Handles: floor tile rendering, wall auto-tiling, furniture z-sorting, vignette.

import type { PlacedFurniture } from './types';
import { getFurnitureEntry } from './furnitureCatalog';
import { getCachedSprite } from './spriteCache';

// Sprite sheet source tile dimensions
const FLOOR_TILE_W = 16;
const FLOOR_TILE_H = 16;
const WALL_TILE_W = 16;
const WALL_TILE_H = 32;

export interface RenderContext {
    ctx: CanvasRenderingContext2D;
    cw: number;
    ch: number;
    offsetX: number;
    offsetY: number;
    tileSize: number;
    scale: number;
}

/**
 * Render all floor tiles from the tilemap using the floors sprite sheet.
 * Applies a dark multiply pass for the moody theme.
 */
export function renderFloors(
    rc: RenderContext,
    tiles: number[],
    cols: number,
    rows: number,
    floorImg: HTMLImageElement
) {
    const { ctx, offsetX, offsetY, tileSize } = rc;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const tile = getTile(tiles, cols, rows, c, r);
            if (tile >= 1 && tile <= 7) {
                const patternIdx = tile - 1;
                const srcX = patternIdx * FLOOR_TILE_W;
                const dx = offsetX + c * tileSize;
                const dy = offsetY + r * tileSize;
                ctx.drawImage(
                    floorImg,
                    srcX, 0, FLOOR_TILE_W, FLOOR_TILE_H,
                    dx, dy, tileSize, tileSize
                );
            }
        }
    }

    // Dark moody tint (multiply blend)
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#061623';
    ctx.fillRect(0, 0, rc.cw, rc.ch);

    ctx.restore();
}

/**
 * Render walls using auto-tiling (4-directional bitmask).
 */
export function renderWalls(
    rc: RenderContext,
    tiles: number[],
    cols: number,
    rows: number,
    wallImg: HTMLImageElement
) {
    const { ctx, offsetX, offsetY, tileSize } = rc;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (getTile(tiles, cols, rows, c, r) !== 0) continue;

            let mask = 0;
            if (r > 0 && getTile(tiles, cols, rows, c, r - 1) === 0) mask |= 1;
            if (c < cols - 1 && getTile(tiles, cols, rows, c + 1, r) === 0) mask |= 2;
            if (r < rows - 1 && getTile(tiles, cols, rows, c, r + 1) === 0) mask |= 4;
            if (c > 0 && getTile(tiles, cols, rows, c - 1, r) === 0) mask |= 8;

            const srcX = (mask % 4) * WALL_TILE_W;
            const srcY = Math.floor(mask / 4) * WALL_TILE_H;

            const destW = tileSize;
            const destH = tileSize * 2; // walls are 2 tiles tall
            const dx = offsetX + c * tileSize;
            const dy = offsetY + (r + 1) * tileSize - destH;

            ctx.drawImage(wallImg, srcX, srcY, WALL_TILE_W, WALL_TILE_H, dx, dy, destW, destH);
        }
    }

    ctx.restore();
}

/**
 * Render placed furniture in Y-sorted order (painter's algorithm).
 * Items higher on screen (smaller Y) are drawn first.
 *
 * @param occupiedByAgent  Set of furniture keys (by col,row) that have a seated agent.
 *                         Used to show the "on" sprite for monitors nearby desks.
 */
export function renderFurniture(
    rc: RenderContext,
    furniture: PlacedFurniture[],
    monitorOnPositions: Set<string>
) {
    const { ctx, offsetX, offsetY, tileSize, scale } = rc;

    // Sort furniture by row + footprint bottom edge for z-ordering
    const sorted = [...furniture].sort((a, b) => a.row - b.row);

    for (const item of sorted) {
        const entry = getFurnitureEntry(item.key);
        if (!entry) continue;

        const isOn = monitorOnPositions.has(`${item.col},${item.row}`);
        const spriteGrid = (isOn && entry.onSprite) ? entry.onSprite : entry.sprite;
        const canvas = getCachedSprite(spriteGrid, scale);

        const px = offsetX + item.col * tileSize;
        const py = offsetY + item.row * tileSize;

        ctx.drawImage(canvas, px - canvas.width / 2 + tileSize / 2, py - canvas.height / 2 + tileSize / 2);
    }
}

/**
 * Draw a radial vignette for depth effect.
 */
export function renderVignette(ctx: CanvasRenderingContext2D, cw: number, ch: number) {
    const gradient = ctx.createRadialGradient(cw / 2, ch / 2, ch / 4, cw / 2, ch / 2, cw);
    gradient.addColorStop(0, 'rgba(13, 15, 16, 0)');
    gradient.addColorStop(1, 'rgba(13, 15, 16, 0.8)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, cw, ch);
}

// ─── Fallback Grid ─────────────────────────────────────────────────────────────
export function renderFallbackGrid(ctx: CanvasRenderingContext2D, cw: number, ch: number, tileSize: number) {
    ctx.strokeStyle = 'rgba(29, 229, 47, 0.03)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= cw; gx += tileSize) {
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, ch); ctx.stroke();
    }
    for (let gy = 0; gy <= ch; gy += tileSize) {
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(cw, gy); ctx.stroke();
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function getTile(tiles: number[], cols: number, rows: number, c: number, r: number): number {
    if (c < 0 || c >= cols || r < 0 || r >= rows) return 8; // void
    return tiles[r * cols + c];
}
