// ─── Furniture Catalog ────────────────────────────────────────────────────────
// Dynamic catalog: each entry defines a furniture type with footprint, sprite,
// category, desk flag, and optional on/off state sprites.

import type { FurnitureEntry } from './types';
import {
    DESK_SPRITE,
    PC_SPRITE,
    PC_ON_SPRITE,
    PLANT_SPRITE,
    BOOKSHELF_SPRITE,
    COOLER_SPRITE,
    WHITEBOARD_SPRITE,
    CHAIR_SPRITE,
} from './sprites';

export const FURNITURE_CATALOG: FurnitureEntry[] = [
    {
        key: 'desk',
        label: 'Desk',
        category: 'desk',
        sprite: DESK_SPRITE,
        footprint: [2, 2],
        isDesk: true,
    },
    {
        key: 'monitor_off',
        label: 'Monitor',
        category: 'electronic',
        sprite: PC_SPRITE,
        onSprite: PC_ON_SPRITE,
        footprint: [1, 1],
        isDesk: false,
    },
    {
        key: 'plant',
        label: 'Plant',
        category: 'plant',
        sprite: PLANT_SPRITE,
        footprint: [1, 2],
        isDesk: false,
    },
    {
        key: 'bookshelf',
        label: 'Bookshelf',
        category: 'storage',
        sprite: BOOKSHELF_SPRITE,
        footprint: [1, 1],
        isDesk: false,
    },
    {
        key: 'cooler',
        label: 'Water Cooler',
        category: 'lounge',
        sprite: COOLER_SPRITE,
        footprint: [1, 1],
        isDesk: false,
    },
    {
        key: 'whiteboard',
        label: 'Whiteboard',
        category: 'lounge',
        sprite: WHITEBOARD_SPRITE,
        footprint: [2, 1],
        isDesk: false,
    },
    {
        key: 'chair',
        label: 'Chair',
        category: 'desk',
        sprite: CHAIR_SPRITE,
        footprint: [1, 1],
        isDesk: false,
    },
];

/** Get a catalog entry by key */
export function getFurnitureEntry(key: string): FurnitureEntry | undefined {
    return FURNITURE_CATALOG.find(f => f.key === key);
}

/** Get all entries in a given category */
export function getFurnitureByCategory(category: FurnitureEntry['category']): FurnitureEntry[] {
    return FURNITURE_CATALOG.filter(f => f.category === category);
}

/** Get all entries that count as desks (assignable to agents) */
export function getDeskEntries(): FurnitureEntry[] {
    return FURNITURE_CATALOG.filter(f => f.isDesk);
}
