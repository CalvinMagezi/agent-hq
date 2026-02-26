// ─── Agent State Machine ──────────────────────────────────────────────────────
// Handles: idle/walk/type state transitions, animation frames, wander AI,
// and BFS path following.

import type { PixelAgent, Seat } from './types';
import { bfsPath } from './pathfinding';
import type { PlacedFurniture } from './types';
import { getFurnitureEntry } from './furnitureCatalog';

// ─── Timing Constants ──────────────────────────────────────────────────────────
export const WALK_SPEED = 80;            // pixels/sec
export const WALK_FRAME_DURATION = 0.15; // sec per walk frame
export const TYPE_FRAME_DURATION = 0.35; // sec per type frame
export const WANDER_PAUSE_MIN = 2.0;
export const WANDER_PAUSE_MAX = 5.0;
export const TYPE_DURATION_MIN = 4.0;
export const TYPE_DURATION_MAX = 10.0;

// Sprite sheet row mapping (Walk direction → sprite row)
export const DIR_ROW = { down: 0, left: 1, right: 2, up: 3 } as const;

export function randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

// ─── State Update ──────────────────────────────────────────────────────────────

/**
 * Update a single agent for one frame.
 *
 * @param agent         The agent to update
 * @param dt            Delta time in seconds
 * @param seats         Available seat positions (derived from desk furniture)
 * @param blockedTiles  Set of "col,row" strings that are impassable
 * @param gridCols      Grid width
 * @param gridRows      Grid height
 * @param tileSize      Rendered tile size in pixels
 * @param offsetX       Canvas X offset
 * @param offsetY       Canvas Y offset
 */
export function updateAgent(
    agent: PixelAgent,
    dt: number,
    seats: Seat[],
    blockedTiles: Set<string>,
    gridCols: number,
    gridRows: number,
    tileSize: number,
    offsetX: number,
    offsetY: number
): void {
    agent.frameTimer += dt;
    agent.stateTimer -= dt;

    switch (agent.state) {
        case 'walk':
            updateWalk(agent, dt, tileSize, offsetX, offsetY);
            break;
        case 'type':
            updateType(agent);
            break;
        case 'idle':
            updateIdle(agent, seats, blockedTiles, gridCols, gridRows, tileSize, offsetX, offsetY);
            break;
    }
}

function updateWalk(
    agent: PixelAgent,
    dt: number,
    tileSize: number,
    offsetX: number,
    offsetY: number
): void {
    // Animate walk cycle
    if (agent.frameTimer >= WALK_FRAME_DURATION) {
        agent.frameTimer -= WALK_FRAME_DURATION;
        agent.frame = (agent.frame + 1) % 4;
    }

    // Follow BFS path waypoints
    if (agent.path.length > 0) {
        const [nextCol, nextRow] = agent.path[0];
        const targetPx = offsetX + (nextCol + 0.5) * tileSize;
        const targetPy = offsetY + (nextRow + 0.5) * tileSize;

        const dx = targetPx - agent.x;
        const dy = targetPy - agent.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 3) {
            const vx = (dx / dist) * WALK_SPEED * dt;
            const vy = (dy / dist) * WALK_SPEED * dt;
            agent.x += vx;
            agent.y += vy;

            if (Math.abs(dx) > Math.abs(dy)) {
                agent.direction = dx > 0 ? 'right' : 'left';
            } else {
                agent.direction = dy > 0 ? 'down' : 'up';
            }
        } else {
            // Reached waypoint, advance to next
            agent.x = targetPx;
            agent.y = targetPy;
            agent.path.shift();

            if (agent.path.length === 0) {
                // Arrived at final destination
                arrivedAtDestination(agent);
            }
        }
    } else {
        // No path — walk directly to target (fallback for no-BFS scenarios)
        const dx = agent.targetX - agent.x;
        const dy = agent.targetY - agent.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 4) {
            const vx = (dx / dist) * WALK_SPEED * dt;
            const vy = (dy / dist) * WALK_SPEED * dt;
            agent.x += vx;
            agent.y += vy;

            if (Math.abs(dx) > Math.abs(dy)) {
                agent.direction = dx > 0 ? 'right' : 'left';
            } else {
                agent.direction = dy > 0 ? 'down' : 'up';
            }
        } else {
            agent.x = agent.targetX;
            agent.y = agent.targetY;
            arrivedAtDestination(agent);
        }
    }
}

function arrivedAtDestination(
    agent: PixelAgent
): void {
    if (agent.deskIndex !== null) {
        agent.state = 'type';
        agent.frame = 0;
        agent.frameTimer = 0;
        agent.stateTimer = randomRange(TYPE_DURATION_MIN, TYPE_DURATION_MAX);
        agent.statusLabel = agent.isDemo ? null : 'working...';

        // Note: x/y already snapped by walk logic
    } else {
        agent.state = 'idle';
        agent.stateTimer = randomRange(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
    }
}

function updateType(
    agent: PixelAgent
): void {
    if (agent.frameTimer >= TYPE_FRAME_DURATION) {
        agent.frameTimer -= TYPE_FRAME_DURATION;
        agent.frame = (agent.frame + 1) % 2;
    }

    // After typing duration, go idle and wander (demo agents only)
    if (agent.stateTimer <= 0 && agent.isDemo) {
        agent.state = 'idle';
        agent.frame = 0;
        agent.stateTimer = randomRange(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
        agent.statusLabel = null;
        agent.deskIndex = null;
    }
}

function updateIdle(
    agent: PixelAgent,
    seats: Seat[],
    blockedTiles: Set<string>,
    gridCols: number,
    gridRows: number,
    tileSize: number,
    offsetX: number,
    offsetY: number
): void {
    agent.frame = 0;
    agent.statusLabel = null;

    if (agent.stateTimer <= 0 && agent.isDemo) {
        const goToDesk = seats.length > 0 && Math.random() > 0.3;

        if (goToDesk) {
            const dIdx = Math.floor(Math.random() * seats.length);
            const seat = seats[dIdx];
            agent.deskIndex = dIdx;

            // Compute BFS path from current tile to seat tile
            const startCol = Math.floor((agent.x - offsetX) / tileSize);
            const startRow = Math.floor((agent.y - offsetY) / tileSize);
            const path = bfsPath(startCol, startRow, seat.col, seat.row, blockedTiles, gridCols, gridRows);
            agent.path = path ?? [];
            agent.targetX = offsetX + (seat.col + 0.5) * tileSize;
            agent.targetY = offsetY + (seat.row + 0.5) * tileSize;
        } else {
            // Wander to a random open tile
            agent.deskIndex = null;
            const randomCol = Math.floor(Math.random() * gridCols);
            const randomRow = Math.floor(Math.random() * gridRows);
            const startCol = Math.floor((agent.x - offsetX) / tileSize);
            const startRow = Math.floor((agent.y - offsetY) / tileSize);
            if (!blockedTiles.has(`${randomCol},${randomRow}`)) {
                const path = bfsPath(startCol, startRow, randomCol, randomRow, blockedTiles, gridCols, gridRows);
                agent.path = path ?? [];
                agent.targetX = offsetX + (randomCol + 0.5) * tileSize;
                agent.targetY = offsetY + (randomRow + 0.5) * tileSize;
            }
        }

        agent.state = 'walk';
        agent.frame = 0;
        agent.frameTimer = 0;
    }
}

// ─── Agent Drawing ─────────────────────────────────────────────────────────────

const FRAME_W = 16;
const FRAME_H = 16;
const SCALE = 3;
const DRAW_W = FRAME_W * SCALE;
const DRAW_H = FRAME_H * SCALE;

const COLORS = {
    textBright: '#dfdfdf',
    brandBlue: '#00C6FA',
    brandGreen: '#1DE52F',
    bubbleBg: 'rgba(0, 198, 250, 0.85)',
    bubbleText: '#0D0F10',
    shadow: 'rgba(0,0,0,0.5)',
};

/**
 * Draw a single agent on the canvas (sprite + name label + status bubble).
 */
export function drawAgent(
    ctx: CanvasRenderingContext2D,
    agent: PixelAgent,
    sprites: HTMLImageElement[]
): void {
    const sprite = sprites[agent.spriteIndex];

    if (!sprite) {
        ctx.beginPath();
        ctx.arc(agent.x, agent.y, 12, 0, Math.PI * 2);
        ctx.fillStyle = agent.state === 'type' ? COLORS.brandBlue : COLORS.brandGreen;
        ctx.fill();
    } else {
        let srcRow: number;
        let srcCol: number;

        switch (agent.state) {
            case 'walk':
                srcRow = DIR_ROW[agent.direction];
                srcCol = agent.frame % 4;
                break;
            case 'type':
                srcRow = DIR_ROW[agent.direction];
                srcCol = agent.frame % 2;
                break;
            case 'idle':
            default:
                srcRow = DIR_ROW[agent.direction];
                srcCol = 0;
                break;
        }

        // Shadow
        ctx.fillStyle = COLORS.shadow;
        ctx.beginPath();
        ctx.ellipse(agent.x, agent.y + DRAW_H / 2 - 4, DRAW_W / 3, 5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Sprite
        ctx.drawImage(
            sprite,
            srcCol * FRAME_W,
            srcRow * FRAME_H,
            FRAME_W, FRAME_H,
            agent.x - DRAW_W / 2,
            agent.y - DRAW_H / 2,
            DRAW_W, DRAW_H
        );
    }

    // Name label
    ctx.fillStyle = COLORS.textBright;
    ctx.font = 'bold 10px Inter, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(agent.name, agent.x, agent.y - DRAW_H / 2 - 6);

    // Status bubble
    if (agent.statusLabel && agent.state === 'type') {
        const text = agent.statusLabel;
        const bw = ctx.measureText(text).width + 14;
        const bh = 18;
        const bx = agent.x - bw / 2;
        const by = agent.y - DRAW_H / 2 - 28;

        ctx.fillStyle = COLORS.bubbleBg;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 4);
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(agent.x - 4, by + bh);
        ctx.lineTo(agent.x, by + bh + 5);
        ctx.lineTo(agent.x + 4, by + bh);
        ctx.fill();

        ctx.fillStyle = COLORS.bubbleText;
        ctx.font = '500 9px Inter, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(text, agent.x, by + 13);
    }
}

// ─── Seat Generation ───────────────────────────────────────────────────────────

/**
 * Derive seat positions from placed desk furniture.
 * Returns the working seats agents can be assigned to.
 */
export function computeSeats(
    furniture: PlacedFurniture[],
    tileSize: number,
    offsetX: number,
    offsetY: number
): Seat[] {
    const seats: Seat[] = [];

    furniture.forEach((item) => {
        const entry = getFurnitureEntry(item.key);
        if (!entry?.isDesk) return;

        // Place agent one tile below the desk center
        const seatCol = item.col + Math.floor(entry.footprint[0] / 2);
        const seatRow = item.row + entry.footprint[1];

        seats.push({
            col: seatCol,
            row: seatRow,
            px: offsetX + (seatCol + 0.5) * tileSize,
            py: offsetY + (seatRow + 0.5) * tileSize,
            facing: 'up',
            label: `Desk ${seats.length + 1}`,
        });
    });

    return seats;
}
