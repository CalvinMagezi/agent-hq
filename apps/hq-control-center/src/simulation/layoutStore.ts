// ─── Layout Store (Zustand) ───────────────────────────────────────────────────
// Manages the simulation room furniture layout with undo/redo and persistence.

import { create } from 'zustand';
import type { PlacedFurniture } from './types';

export interface LayoutState {
    furniture: PlacedFurniture[];
    isDirty: boolean;
    history: PlacedFurniture[][];  // Undo stack (snapshots)
    future: PlacedFurniture[][];   // Redo stack

    // Actions
    loadFromElectron: () => Promise<void>;
    saveToElectron: () => Promise<void>;
    placeFurniture: (item: PlacedFurniture) => void;
    removeFurniture: (col: number, row: number) => void;
    moveFurniture: (fromCol: number, fromRow: number, toCol: number, toRow: number) => void;
    rotateFurniture: (col: number, row: number) => void;
    undo: () => void;
    redo: () => void;
    resetToDefault: () => void;
}

// Default furniture layout matching the original SimulationRoom vibe
const DEFAULT_FURNITURE: PlacedFurniture[] = [
    { key: 'desk', col: 5, row: 7, rotation: 0 },
    { key: 'desk', col: 13, row: 7, rotation: 0 },
    { key: 'desk', col: 5, row: 13, rotation: 0 },
    { key: 'desk', col: 13, row: 13, rotation: 0 },
    { key: 'plant', col: 1, row: 1, rotation: 0 },
    { key: 'bookshelf', col: 18, row: 2, rotation: 0 },
    { key: 'cooler', col: 17, row: 15, rotation: 0 },
    { key: 'whiteboard', col: 8, row: 2, rotation: 0 },
];

export const useLayoutStore = create<LayoutState>((set, get) => ({
    furniture: DEFAULT_FURNITURE,
    isDirty: false,
    history: [],
    future: [],

    loadFromElectron: async () => {
        if (typeof window === 'undefined' || !window.electronAPI?.loadLayout) return;
        try {
            const saved = await window.electronAPI.loadLayout();
            if (saved?.furniture) {
                set({
                    furniture: saved.furniture as PlacedFurniture[],
                    isDirty: false,
                    history: [],
                    future: [],
                });
            }
        } catch (err) {
            console.warn('[LayoutStore] No saved layout, using defaults.');
        }
    },

    saveToElectron: async () => {
        if (typeof window === 'undefined' || !window.electronAPI?.saveLayout) return;
        const { furniture } = get();
        await window.electronAPI.saveLayout({
            version: 1,
            furniture: furniture as any,
            savedAt: Date.now(),
        });
        set({ isDirty: false });
    },

    placeFurniture: (item) => {
        const { furniture, history } = get();
        set({
            history: [...history.slice(-49), furniture],
            future: [],
            furniture: [...furniture, item],
            isDirty: true,
        });
        get().saveToElectron();
    },

    removeFurniture: (col, row) => {
        const { furniture, history } = get();
        const next = furniture.filter(f => !(f.col === col && f.row === row));
        set({
            history: [...history.slice(-49), furniture],
            future: [],
            furniture: next,
            isDirty: true,
        });
        get().saveToElectron();
    },

    moveFurniture: (fromCol, fromRow, toCol, toRow) => {
        const { furniture, history } = get();
        const next = furniture.map(f =>
            f.col === fromCol && f.row === fromRow ? { ...f, col: toCol, row: toRow } : f
        );
        set({
            history: [...history.slice(-49), furniture],
            future: [],
            furniture: next,
            isDirty: true,
        });
        get().saveToElectron();
    },

    rotateFurniture: (col, row) => {
        const { furniture, history } = get();
        const next = furniture.map(f => {
            if (f.col !== col || f.row !== row) return f;
            const next90: PlacedFurniture['rotation'] = ({ 0: 90, 90: 180, 180: 270, 270: 0 } as const)[f.rotation];
            return { ...f, rotation: next90 };
        });
        set({
            history: [...history.slice(-49), furniture],
            future: [],
            furniture: next,
            isDirty: true,
        });
        get().saveToElectron();
    },

    undo: () => {
        const { history, furniture, future } = get();
        if (history.length === 0) return;
        const prev = history[history.length - 1];
        set({
            history: history.slice(0, -1),
            future: [furniture, ...future.slice(0, 49)],
            furniture: prev,
            isDirty: true,
        });
        get().saveToElectron();
    },

    redo: () => {
        const { future, furniture, history } = get();
        if (future.length === 0) return;
        const next = future[0];
        set({
            history: [...history.slice(-49), furniture],
            future: future.slice(1),
            furniture: next,
            isDirty: true,
        });
        get().saveToElectron();
    },

    resetToDefault: () => {
        const { furniture, history } = get();
        set({
            history: [...history.slice(-49), furniture],
            future: [],
            furniture: DEFAULT_FURNITURE,
            isDirty: true,
        });
        get().saveToElectron();
    },
}));

// Load from Electron on first import (safe to call multiple times)
if (typeof window !== 'undefined') {
    // Defer to avoid blocking module evaluation
    setTimeout(() => useLayoutStore.getState().loadFromElectron(), 0);
}
