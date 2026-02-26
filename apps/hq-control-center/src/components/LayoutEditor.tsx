import { useState } from 'react';
import { getFurnitureByCategory } from '../simulation/furnitureCatalog';
import { useLayoutStore } from '../simulation/layoutStore';
import type { PlacedFurniture } from '../simulation/types';
import type { FurnitureEntry } from '../simulation/types';

interface LayoutEditorProps {
    onClose: () => void;
}

const CATEGORIES: Array<{ key: FurnitureEntry['category']; label: string; icon: string }> = [
    { key: 'desk', label: 'Desks', icon: '🖥' },
    { key: 'storage', label: 'Storage', icon: '📚' },
    { key: 'plant', label: 'Plants', icon: '🌿' },
    { key: 'electronic', label: 'Electronics', icon: '💡' },
    { key: 'lounge', label: 'Lounge', icon: '☕' },
];

export function LayoutEditor({ onClose }: LayoutEditorProps) {
    const {
        furniture,
        placeFurniture,
        removeFurniture,
        rotateFurniture,
        undo, redo, resetToDefault,
        history, future, isDirty,
    } = useLayoutStore();

    const [selected, setSelected] = useState<{ col: number; row: number } | null>(null);
    const [activeCategory, setActiveCategory] = useState<FurnitureEntry['category']>('desk');
    const [dragFrom, setDragFrom] = useState<{ col: number; row: number } | null>(null);

    // Grid preview dimensions (compact 21x21 in the panel)
    const GRID_COLS = 21;
    const GRID_ROWS = 21;
    const CELL = 12; // px per cell in mini-grid

    function handleGridClick(col: number, row: number) {
        const hit = furniture.find(f => f.col === col && f.row === row);
        if (hit) {
            setSelected(s => (s?.col === col && s?.row === row) ? null : { col, row });
        } else {
            setSelected(null);
        }
    }

    function handleRotate() {
        if (!selected) return;
        rotateFurniture(selected.col, selected.row);
    }

    function handleDelete() {
        if (!selected) return;
        removeFurniture(selected.col, selected.row);
        setSelected(null);
    }

    function handlePlace(entry: FurnitureEntry) {
        // Find first available empty spot
        for (let r = 2; r < GRID_ROWS - 2; r++) {
            for (let c = 2; c < GRID_COLS - 2; c++) {
                const occupied = furniture.some(f => f.col === c && f.row === r);
                if (!occupied) {
                    const item: PlacedFurniture = { key: entry.key, col: c, row: r, rotation: 0 };
                    placeFurniture(item);
                    setSelected({ col: c, row: r });
                    return;
                }
            }
        }
    }

    // Drag support within the mini-grid
    function handleDragStart(col: number, row: number) {
        const hit = furniture.find(f => f.col === col && f.row === row);
        if (hit) setDragFrom({ col, row });
    }

    function handleDrop(toCol: number, toRow: number) {
        if (!dragFrom) return;
        const { moveFurniture } = useLayoutStore.getState();
        moveFurniture(dragFrom.col, dragFrom.row, toCol, toRow);
        setSelected({ col: toCol, row: toRow });
        setDragFrom(null);
    }

    const selectedItem = selected
        ? furniture.find(f => f.col === selected.col && f.row === selected.row)
        : null;

    return (
        <div className="h-full flex flex-col bg-[#0d1117] border-l border-gray-800 text-white overflow-hidden shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-[#161b22] border-b border-gray-800">
                <div>
                    <h2 className="text-sm font-bold text-white">Layout Editor</h2>
                    <p className="text-[10px] text-gray-500">{isDirty ? '● Unsaved changes' : '✓ Saved'}</p>
                </div>
                <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg">✕</button>
            </div>

            {/* Undo / Redo / Reset */}
            <div className="flex gap-1 px-3 py-2 border-b border-gray-800 bg-[#0d1117]">
                <button
                    onClick={undo}
                    disabled={history.length === 0}
                    className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >↩ Undo</button>
                <button
                    onClick={redo}
                    disabled={future.length === 0}
                    className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >↪ Redo</button>
                <button
                    onClick={resetToDefault}
                    className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 transition-colors"
                >⟳ Reset</button>
            </div>

            {/* Mini grid preview */}
            <div className="flex items-center justify-center p-3 bg-[#0a0d10] border-b border-gray-800">
                <div
                    className="relative border border-gray-700 overflow-hidden"
                    style={{ width: GRID_COLS * CELL, height: GRID_ROWS * CELL, background: '#1a1d21' }}
                >
                    {/* Grid lines */}
                    {Array.from({ length: GRID_COLS + 1 }).map((_, i) => (
                        <div key={`v${i}`} className="absolute top-0 bottom-0 border-l border-gray-800/50" style={{ left: i * CELL }} />
                    ))}
                    {Array.from({ length: GRID_ROWS + 1 }).map((_, i) => (
                        <div key={`h${i}`} className="absolute left-0 right-0 border-t border-gray-800/50" style={{ top: i * CELL }} />
                    ))}

                    {/* Drop targets */}
                    {dragFrom && Array.from({ length: GRID_COLS }).map((_, c) =>
                        Array.from({ length: GRID_ROWS }).map((_, r) => (
                            <div
                                key={`drop-${c}-${r}`}
                                className="absolute"
                                style={{ left: c * CELL, top: r * CELL, width: CELL, height: CELL }}
                                onMouseUp={() => handleDrop(c, r)}
                            />
                        ))
                    )}

                    {/* Placed furniture */}
                    {furniture.map((f, i) => {
                        const isSelected = selected?.col === f.col && selected?.row === f.row;
                        return (
                            <div
                                key={i}
                                className="absolute rounded cursor-pointer transition-all"
                                style={{
                                    left: f.col * CELL + 1,
                                    top: f.row * CELL + 1,
                                    width: CELL - 2,
                                    height: CELL - 2,
                                    background: isSelected ? '#00C6FA' : '#2a2730',
                                    outline: isSelected ? '1px solid #00C6FA' : 'none',
                                }}
                                onClick={() => handleGridClick(f.col, f.row)}
                                draggable
                                onDragStart={() => handleDragStart(f.col, f.row)}
                                title={f.key}
                            />
                        );
                    })}

                    {/* Click grid cells to deselect */}
                    <div
                        className="absolute inset-0"
                        style={{ pointerEvents: dragFrom ? 'auto' : 'none' }}
                        onMouseUp={() => setDragFrom(null)}
                    />
                </div>
            </div>

            {/* Selected item controls */}
            {selectedItem && (
                <div className="px-3 py-2 bg-[#161b22] border-b border-gray-800">
                    <p className="text-[10px] text-[#00C6FA] font-semibold mb-1.5 uppercase tracking-wider">
                        Selected: {selectedItem.key} ({selectedItem.col}, {selectedItem.row})
                    </p>
                    <div className="flex gap-1">
                        <button onClick={handleRotate} className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-gray-700 transition-colors">
                            ↻ Rotate
                        </button>
                        <button onClick={handleDelete} className="flex-1 text-[10px] py-1 rounded bg-red-950 hover:bg-red-900 text-red-300 transition-colors">
                            🗑 Delete
                        </button>
                    </div>
                </div>
            )}

            {/* Category tabs */}
            <div className="flex overflow-x-auto px-2 pt-2 gap-1 border-b border-gray-800 bg-[#0d1117]">
                {CATEGORIES.map(cat => (
                    <button
                        key={cat.key}
                        onClick={() => setActiveCategory(cat.key)}
                        className={`text-[10px] px-2 py-1 rounded-t whitespace-nowrap transition-colors ${activeCategory === cat.key
                            ? 'bg-[#161b22] text-[#00C6FA] border-t border-x border-gray-700'
                            : 'text-gray-500 hover:text-gray-300'
                            }`}
                    >
                        {cat.icon} {cat.label}
                    </button>
                ))}
            </div>

            {/* Furniture palette */}
            <div className="flex-1 overflow-y-auto p-3 bg-[#0d1117]">
                <div className="grid grid-cols-2 gap-2">
                    {getFurnitureByCategory(activeCategory).map(entry => (
                        <button
                            key={entry.key}
                            onClick={() => handlePlace(entry)}
                            className="p-2 rounded-lg border border-gray-700 bg-[#161b22] hover:border-[#00C6FA] hover:bg-[#0a1628] transition-all text-left group"
                        >
                            <div className="text-lg mb-0.5">
                                {entry.category === 'desk' ? '🖥' :
                                    entry.category === 'plant' ? '🌿' :
                                        entry.category === 'storage' ? '📚' :
                                            entry.category === 'electronic' ? '💡' : '☕'}
                            </div>
                            <p className="text-[10px] font-medium text-gray-300 group-hover:text-white truncate">{entry.label}</p>
                            <p className="text-[9px] text-gray-600">{entry.footprint[0]}×{entry.footprint[1]} tiles</p>
                        </button>
                    ))}
                </div>
            </div>

            {/* Footer hint */}
            <div className="px-3 py-2 bg-[#161b22] border-t border-gray-800">
                <p className="text-[9px] text-gray-600 text-center">
                    Click grid to select · Drag to move · Click palette to place
                </p>
            </div>
        </div>
    );
}
