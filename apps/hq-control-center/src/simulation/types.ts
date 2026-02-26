// ─── Core Simulation Types ────────────────────────────────────────────────────

export type Direction = 'up' | 'down' | 'left' | 'right';
export type AgentState = 'idle' | 'walk' | 'type';
export type FloorColor = string; // CSS color string

export interface SpriteData {
    grid: string[][];
}

export interface FurnitureEntry {
    /** Unique key, e.g. "desk", "plant", "monitor_off" */
    key: string;
    /** Display label shown in the editor palette */
    label: string;
    /** Category for grouping in editor palette */
    category: 'desk' | 'plant' | 'electronic' | 'lounge' | 'storage';
    /** Pixel-art sprite grid (rows of CSS color strings, '' = transparent) */
    sprite: string[][];
    /** Size in tiles [cols, rows] */
    footprint: [number, number];
    /** If true, agents can be assigned to sit here */
    isDesk: boolean;
    /** Optional alternate on-state sprite (for monitors, lamps, etc.) */
    onSprite?: string[][];
}

export interface PixelAgent {
    id: string;
    name: string;
    spriteIndex: number;
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    /** Current path from BFS, array of [col, row] waypoints */
    path: [number, number][];
    state: AgentState;
    direction: Direction;
    frame: number;
    frameTimer: number;
    stateTimer: number;
    isDemo: boolean;
    /** Assigned desk index (null = wandering) */
    deskIndex: number | null;
    statusLabel: string | null;
}

export interface LayoutTile {
    /** 0 = wall, 1-7 = floor variants, 8 = void */
    type: number;
}

export interface PlacedFurniture {
    key: string;
    col: number;
    row: number;
    rotation: 0 | 90 | 180 | 270;
}

export interface RoomLayout {
    cols: number;
    rows: number;
    tiles: number[];
    furniture: PlacedFurniture[];
}

export interface Seat {
    col: number;
    row: number;
    /** Screen-space pixel coordinates (computed at runtime) */
    px: number;
    py: number;
    /** Direction agent faces when seated */
    facing: Direction;
    /** Label shown below seat */
    label: string;
}
