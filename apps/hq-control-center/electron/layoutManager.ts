import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { LayoutPayload } from './types';

const LAYOUTS_DIR = () => path.join(app.getPath('userData'), 'layouts');
const LAYOUT_FILE = () => path.join(LAYOUTS_DIR(), 'layout.json');

/**
 * Load the saved layout from userData/layouts/layout.json.
 * Returns null if no layout has been saved yet.
 */
export async function loadLayout(): Promise<LayoutPayload | null> {
    try {
        const raw = await fs.readFile(LAYOUT_FILE(), 'utf-8');
        return JSON.parse(raw) as LayoutPayload;
    } catch {
        return null; // File doesn't exist yet — first run
    }
}

/**
 * Atomically save the layout to userData/layouts/layout.json.
 * Uses a tmp-file + rename pattern to prevent corruption on crash.
 * Writes are debounced at the call-site (500ms) in ipc-handlers.ts.
 */
export async function saveLayout(payload: LayoutPayload): Promise<boolean> {
    try {
        const dir = LAYOUTS_DIR();
        await fs.mkdir(dir, { recursive: true });

        const file = LAYOUT_FILE();
        const tmp = `${file}.tmp`;

        await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
        await fs.rename(tmp, file); // Atomic replacement

        return true;
    } catch (err) {
        console.error('[LayoutManager] Failed to save layout:', err);
        return false;
    }
}
