import { useEffect, useRef, useState } from 'react';
import { useRelayStore } from '../store/relay-store';

// Sprite sheets
import char0 from '../assets/characters/char_0.png';
import char1 from '../assets/characters/char_1.png';
import char2 from '../assets/characters/char_2.png';
import char3 from '../assets/characters/char_3.png';
import char4 from '../assets/characters/char_4.png';
import char5 from '../assets/characters/char_5.png';
import floorsImg from '../assets/floors.png';
import wallsImg from '../assets/pixel-assets/walls.png';
import defaultLayout from '../assets/default-layout.json';

// Simulation modules
import type { PixelAgent, Seat } from '../simulation/types';
import { updateAgent, drawAgent, computeSeats } from '../simulation/agentStateMachine';
import { renderFloors, renderWalls, renderFurniture, renderVignette, renderFallbackGrid } from '../simulation/roomRenderer';
import { computeBlockedTiles } from '../simulation/pathfinding';
import { startMatrixEffect } from '../simulation/matrixEffect';
import { useLayoutStore } from '../simulation/layoutStore';
import { LayoutEditor } from './LayoutEditor';
import { getFurnitureEntry } from '../simulation/furnitureCatalog';

const SPRITE_SHEETS = [char0, char1, char2, char3, char4, char5];
const FRAME_W = 16;
const SCALE = 3;

const DEMO_AGENTS_BASE = [
    { id: 'demo-gemini', name: 'Gemini', spriteIndex: 0, isDemo: true },
    { id: 'demo-claude', name: 'Claude', spriteIndex: 2, isDemo: true },
    { id: 'demo-opencode', name: 'OpenCode', spriteIndex: 4, isDemo: true },
];

function makeAgent(base: (typeof DEMO_AGENTS_BASE)[0], startX: number, startY: number): PixelAgent {
    return {
        ...base,
        x: startX,
        y: startY,
        targetX: startX,
        targetY: startY,
        path: [],
        state: 'idle',
        direction: 'down',
        frame: 0,
        frameTimer: 0,
        stateTimer: 1 + Math.random(),
        deskIndex: null,
        statusLabel: null,
    };
}

export function SimulationRoom() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const { agents: relayAgents } = useRelayStore();
    const { furniture } = useLayoutStore();
    const [showEditor, setShowEditor] = useState(false);

    const agentsRef = useRef<PixelAgent[]>([]);
    const spritesRef = useRef<HTMLImageElement[]>([]);
    const floorImgRef = useRef<HTMLImageElement | null>(null);
    const wallImgRef = useRef<HTMLImageElement | null>(null);
    const assetsLoadedRef = useRef(false);
    const reqFrameRef = useRef<number>();
    const prevRelayIdsRef = useRef<Set<string>>(new Set());
    const [agentCount, setAgentCount] = useState(0);

    // ─── Load Assets ──────────────────────────────────────────
    useEffect(() => {
        let loaded = 0;
        const total = SPRITE_SHEETS.length + 2;

        const onLoad = () => { if (++loaded === total) assetsLoadedRef.current = true; };

        const imgs = SPRITE_SHEETS.map((src) => {
            const img = new Image();
            img.src = src; img.onload = onLoad;
            return img;
        });
        spritesRef.current = imgs;

        const f = new Image(); f.src = floorsImg; f.onload = onLoad; floorImgRef.current = f;
        const w = new Image(); w.src = wallsImg; w.onload = onLoad; wallImgRef.current = w;
    }, []);

    // ─── Sync Relay Agents (with matrix spawn effect) ────────
    useEffect(() => {
        const newIds = new Set(relayAgents.map(a => a.workerId));

        if (relayAgents.length > 0) {
            const existing = new Map(agentsRef.current.map(a => [a.id, a]));

            agentsRef.current = relayAgents.map((ra, i) => {
                const prev = existing.get(ra.workerId);
                if (prev) {
                    prev.statusLabel = ra.status === 'busy' ? 'working...' : null;
                    if (ra.status === 'busy' && prev.state === 'idle') {
                        prev.state = 'walk';
                        prev.deskIndex = i % Math.max(1, agentsRef.current.length);
                    } else if (ra.status === 'online' && prev.state === 'type') {
                        prev.state = 'idle';
                        prev.stateTimer = 0;
                        prev.deskIndex = null;
                        prev.statusLabel = null;
                    }
                    return prev;
                }
                // New agent — trigger matrix effect
                if (containerRef.current && !prevRelayIdsRef.current.has(ra.workerId)) {
                    startMatrixEffect(containerRef.current, 1500);
                }
                return makeAgent(
                    { id: ra.workerId, name: ra.workerId.slice(0, 8), spriteIndex: i % SPRITE_SHEETS.length, isDemo: false },
                    200 + i * 60, 200
                );
            });
        } else if (agentsRef.current.length === 0 || agentsRef.current.every(a => a.isDemo)) {
            // Show demo agents
            agentsRef.current = DEMO_AGENTS_BASE.map((d, i) => makeAgent(d, 200 + i * 60, 200));
        }

        prevRelayIdsRef.current = newIds;
        setAgentCount(agentsRef.current.length);
    }, [relayAgents]);

    // ─── Main Render Loop ─────────────────────────────────────
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        let lastTime = performance.now();

        const draw = (time: number) => {
            reqFrameRef.current = requestAnimationFrame(draw);
            const dt = Math.min((time - lastTime) / 1000, 0.1);
            lastTime = time;

            // Resize canvas to DPR
            const parent = canvas.parentElement;
            if (parent) {
                const dpr = window.devicePixelRatio || 1;
                const cw = parent.clientWidth, ch = parent.clientHeight;
                if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
                    canvas.width = cw * dpr; canvas.height = ch * dpr;
                    canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                    ctx.imageSmoothingEnabled = false;
                }
            }

            const cw = canvas.parentElement?.clientWidth ?? canvas.width;
            const ch = canvas.parentElement?.clientHeight ?? canvas.height;

            // Layout geometry
            const layout = defaultLayout;
            const cols = layout.cols, rows = layout.rows;
            const tileSize = Math.min(cw / (cols * FRAME_W), ch / (rows * FRAME_W)) * FRAME_W;
            const offsetX = (cw - cols * tileSize) / 2;
            const offsetY = (ch - rows * tileSize) / 2;

            // Compute blocked tiles + seats from live furniture
            const activeFurniture = furniture.map(f => {
                const entry = getFurnitureEntry(f.key);
                const [fc, fr] = [entry?.footprint?.[0] ?? 1, entry?.footprint?.[1] ?? 1];
                return { col: f.col, row: f.row, footprint: [fc, fr] as [number, number] };
            });
            const blockedTiles = computeBlockedTiles(activeFurniture, cols, rows);
            const seats: Seat[] = computeSeats(furniture, tileSize, offsetX, offsetY);

            // Monitor ON positions = tiles where a typing agent is nearby
            const monitorOn = new Set<string>();
            agentsRef.current.forEach(a => {
                if (a.state === 'type' && a.deskIndex !== null && seats[a.deskIndex]) {
                    const seat = seats[a.deskIndex];
                    // Mark the tile above the seat as "on" (where the desk+monitor lives)
                    monitorOn.add(`${seat.col},${Math.max(0, seat.row - 1)}`);
                }
            });

            // Update agents
            agentsRef.current.forEach(agent =>
                updateAgent(agent, dt, seats, blockedTiles, cols, rows, tileSize, offsetX, offsetY)
            );

            // ── Draw ──────────────────────────────────────────
            ctx.fillStyle = '#0D0F10';
            ctx.fillRect(0, 0, cw, ch);

            const rc = { ctx, cw, ch, offsetX, offsetY, tileSize, scale: SCALE };

            if (assetsLoadedRef.current && floorImgRef.current && wallImgRef.current) {
                renderFloors(rc, layout.tiles, cols, rows, floorImgRef.current);
                renderWalls(rc, layout.tiles, cols, rows, wallImgRef.current);
            } else {
                renderFallbackGrid(ctx, cw, ch, tileSize);
            }

            // Render furniture sprites (z-sorted by row)
            renderFurniture(rc, furniture, monitorOn);

            renderVignette(ctx, cw, ch);

            // Agents sorted by Y (painter's algorithm)
            const sorted = [...agentsRef.current].sort((a, b) => a.y - b.y);
            sorted.forEach(agent => drawAgent(ctx, agent, spritesRef.current));
        };

        reqFrameRef.current = requestAnimationFrame(draw);
        return () => { if (reqFrameRef.current) cancelAnimationFrame(reqFrameRef.current); };
    }, [furniture]);

    return (
        <div ref={containerRef} className="w-full h-full relative border border-gray-800 rounded-lg overflow-hidden" style={{ background: '#0D0F10' }}>
            {/* Header overlay */}
            <div className="absolute top-4 left-4 z-10 bg-[rgba(20,20,30,0.85)] px-4 py-2 rounded-lg border border-gray-800 backdrop-blur-md">
                <h3 className="text-sm font-semibold text-gray-300">HQ Sandbox (Live)</h3>
                <p className="text-xs text-gray-500">
                    Tracking {agentCount} agent{agentCount !== 1 ? 's' : ''}{' '}
                    {agentCount > 0 && agentsRef.current[0]?.isDemo && (
                        <span className="text-[#00C6FA]">· demo mode</span>
                    )}
                </p>
            </div>

            {/* Editor toggle */}
            <button
                onClick={() => setShowEditor(s => !s)}
                className="absolute top-4 right-4 z-10 px-3 py-1.5 rounded-lg text-xs font-medium bg-[rgba(20,20,30,0.85)] border border-gray-700 text-gray-400 hover:text-white hover:border-[#00C6FA] transition-colors backdrop-blur-md"
            >
                {showEditor ? '✕ Close Editor' : '🛋 Edit Layout'}
            </button>

            <canvas ref={canvasRef} className="block w-full h-full" style={{ imageRendering: 'pixelated' }} />

            {/* Slide-out Layout Editor */}
            {showEditor && (
                <div className="absolute inset-y-0 right-0 w-72 z-20">
                    <LayoutEditor onClose={() => setShowEditor(false)} />
                </div>
            )}
        </div>
    );
}
