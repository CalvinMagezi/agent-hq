// ─── Pixel-Art Sprite Definitions ─────────────────────────────────────────────
// All sprites are 2D arrays of CSS color strings. '' = transparent pixel.
//
// Sprites salvaged from pixel-agents + original SimulationRoom inline definitions.

const _ = '';

// ─── Desk (32×28) ─────────────────────────────────────────────────────────────
export const DESK_SPRITE: string[][] = (() => {
    const W = '#231F20'; // brand black desk edge
    const L = '#2a2730'; // lighter dark
    const S = '#1a1d21'; // surface
    const D = '#0D0F10'; // dark edge / shadow
    const rows: string[][] = [];
    rows.push(new Array(32).fill(_));
    rows.push([_, ...new Array(30).fill(W), _]);
    for (let r = 0; r < 4; r++) rows.push([_, W, ...new Array(28).fill(r < 1 ? L : S), W, _]);
    rows.push([_, D, ...new Array(28).fill(W), D, _]);
    for (let r = 0; r < 6; r++) rows.push([_, W, ...new Array(28).fill(S), W, _]);
    rows.push([_, W, ...new Array(28).fill(L), W, _]);
    for (let r = 0; r < 6; r++) rows.push([_, W, ...new Array(28).fill(S), W, _]);
    rows.push([_, D, ...new Array(28).fill(W), D, _]);
    for (let r = 0; r < 4; r++) rows.push([_, W, ...new Array(28).fill(r > 2 ? L : S), W, _]);
    rows.push([_, ...new Array(30).fill(W), _]);
    for (let r = 0; r < 4; r++) {
        const row = new Array(32).fill(_);
        row[1] = D; row[2] = D; row[29] = D; row[30] = D;
        rows.push(row);
    }
    rows.push(new Array(32).fill(_));
    rows.push(new Array(32).fill(_));
    return rows;
})();

// ─── PC Monitor - OFF (16×16) ──────────────────────────────────────────────────
export const PC_SPRITE: string[][] = (() => {
    const F = '#333333', S = '#1a1a2e', B = '#00C6FA', D = '#222222';
    return [
        [_, _, _, F, F, F, F, F, F, F, F, F, F, _, _, _],
        [_, _, _, F, S, S, S, S, S, S, S, S, F, _, _, _],
        [_, _, _, F, S, B, B, B, B, B, B, S, F, _, _, _],
        [_, _, _, F, S, B, B, B, B, B, B, S, F, _, _, _],
        [_, _, _, F, S, B, B, B, B, B, B, S, F, _, _, _],
        [_, _, _, F, S, B, B, B, B, B, B, S, F, _, _, _],
        [_, _, _, F, S, B, B, B, B, B, B, S, F, _, _, _],
        [_, _, _, F, S, B, B, B, B, B, B, S, F, _, _, _],
        [_, _, _, F, S, S, S, S, S, S, S, S, F, _, _, _],
        [_, _, _, F, F, F, F, F, F, F, F, F, F, _, _, _],
        [_, _, _, _, _, _, _, D, D, _, _, _, _, _, _, _],
        [_, _, _, _, _, _, _, D, D, _, _, _, _, _, _, _],
        [_, _, _, _, _, _, D, D, D, D, _, _, _, _, _, _],
        [_, _, _, _, _, D, D, D, D, D, D, _, _, _, _, _],
        [_, _, _, _, _, D, D, D, D, D, D, _, _, _, _, _],
        [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
    ];
})();

// ─── PC Monitor - ON (screen glow variant) ─────────────────────────────────────
export const PC_ON_SPRITE: string[][] = (() => {
    const F = '#333333', S = '#0a0a1e', G = '#00ff99', H = '#00C6FA', D = '#222222';
    return [
        [_, _, _, F, F, F, F, F, F, F, F, F, F, _, _, _],
        [_, _, _, F, S, S, S, S, S, S, S, S, F, _, _, _],
        [_, _, _, F, S, G, H, G, H, G, H, S, F, _, _, _],
        [_, _, _, F, S, H, G, H, G, H, G, S, F, _, _, _],
        [_, _, _, F, S, G, H, G, H, G, H, S, F, _, _, _],
        [_, _, _, F, S, H, G, H, G, H, G, S, F, _, _, _],
        [_, _, _, F, S, G, H, G, H, G, H, S, F, _, _, _],
        [_, _, _, F, S, H, G, H, G, H, G, S, F, _, _, _],
        [_, _, _, F, S, S, S, S, S, S, S, S, F, _, _, _],
        [_, _, _, F, F, F, F, F, F, F, F, F, F, _, _, _],
        [_, _, _, _, _, _, _, D, D, _, _, _, _, _, _, _],
        [_, _, _, _, _, _, _, D, D, _, _, _, _, _, _, _],
        [_, _, _, _, _, _, D, D, D, D, _, _, _, _, _, _],
        [_, _, _, _, _, D, D, D, D, D, D, _, _, _, _, _],
        [_, _, _, _, _, D, D, D, D, D, D, _, _, _, _, _],
        [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
    ];
})();

// ─── Plant (16×24) ─────────────────────────────────────────────────────────────
export const PLANT_SPRITE: string[][] = (() => {
    const G = '#1DE52F', D = '#159c22', T = '#6B4E0A', P = '#8B4422', R = '#663311';
    return [
        [_, _, _, _, _, _, G, G, _, _, _, _, _, _, _, _],
        [_, _, _, _, _, G, G, G, G, _, _, _, _, _, _, _],
        [_, _, _, _, G, G, D, G, G, G, _, _, _, _, _, _],
        [_, _, _, G, G, D, G, G, D, G, G, _, _, _, _, _],
        [_, _, G, G, G, G, G, G, G, G, G, G, _, _, _, _],
        [_, G, G, D, G, G, G, G, G, G, D, G, G, _, _, _],
        [_, G, G, G, G, D, G, G, D, G, G, G, G, _, _, _],
        [_, _, G, G, G, G, G, G, G, G, G, G, _, _, _, _],
        [_, _, _, G, G, G, D, G, G, G, G, _, _, _, _, _],
        [_, _, _, _, G, G, G, G, G, G, _, _, _, _, _, _],
        [_, _, _, _, _, G, G, G, G, _, _, _, _, _, _, _],
        [_, _, _, _, _, _, T, T, _, _, _, _, _, _, _, _],
        [_, _, _, _, _, _, T, T, _, _, _, _, _, _, _, _],
        [_, _, _, _, _, _, T, T, _, _, _, _, _, _, _, _],
        [_, _, _, _, _, R, R, R, R, R, _, _, _, _, _, _],
        [_, _, _, _, R, P, P, P, P, P, R, _, _, _, _, _],
        [_, _, _, _, R, P, P, P, P, P, R, _, _, _, _, _],
        [_, _, _, _, R, P, P, P, P, P, R, _, _, _, _, _],
        [_, _, _, _, R, P, P, P, P, P, R, _, _, _, _, _],
        [_, _, _, _, R, P, P, P, P, P, R, _, _, _, _, _],
        [_, _, _, _, R, P, P, P, P, P, R, _, _, _, _, _],
        [_, _, _, _, _, R, P, P, P, R, _, _, _, _, _, _],
        [_, _, _, _, _, _, R, R, R, _, _, _, _, _, _, _],
        [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
    ];
})();

// ─── Bookshelf (16×12) ─────────────────────────────────────────────────────────
export const BOOKSHELF_SPRITE: string[][] = (() => {
    const W = '#5c3d1a', F = '#8B6914', B1 = '#d44', B2 = '#44d', B3 = '#4d4', B4 = '#d84', B5 = '#a4d';
    const S = '#3a2510';
    return [
        [W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W],
        [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
        [W, B1, B1, S, B2, B2, S, B3, B3, S, B4, B4, S, B5, B5, W],
        [W, B1, B1, S, B2, B2, S, B3, B3, S, B4, B4, S, B5, B5, W],
        [W, B1, B1, S, B2, B2, S, B3, B3, S, B4, B4, S, B5, B5, W],
        [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
        [W, B3, B3, S, B4, B4, S, B5, B5, S, B1, B1, S, B2, B2, W],
        [W, B3, B3, S, B4, B4, S, B5, B5, S, B1, B1, S, B2, B2, W],
        [W, B3, B3, S, B4, B4, S, B5, B5, S, B1, B1, S, B2, B2, W],
        [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
        [W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W],
        [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
    ];
})();

// ─── Cooler / Water Dispenser (8×12) ───────────────────────────────────────────
export const COOLER_SPRITE: string[][] = (() => {
    const B = '#aad4f5', F = '#336688', W = '#eef8ff', D = '#224466', G = '#77aacc';
    return [
        [_, F, F, F, F, F, F, _],
        [_, F, B, B, B, B, F, _],
        [_, F, B, W, B, W, F, _],
        [_, F, B, B, B, B, F, _],
        [_, D, D, D, D, D, D, _],
        [_, F, G, G, G, G, F, _],
        [_, F, G, G, G, G, F, _],
        [_, F, G, G, G, G, F, _],
        [_, F, G, G, G, G, F, _],
        [_, F, D, D, D, D, F, _],
        [_, F, F, F, F, F, F, _],
        [_, _, F, F, F, F, _, _],
    ];
})();

// ─── Whiteboard (16×12) ────────────────────────────────────────────────────────
export const WHITEBOARD_SPRITE: string[][] = (() => {
    const F = '#555555', W = '#f0f0f0', G = '#dddddd', L = '#00C6FA', K = '#1DE52F';
    return [
        [F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F],
        [F, W, W, W, W, W, W, W, W, W, W, W, W, W, W, F],
        [F, W, L, L, L, W, W, K, K, W, W, W, W, W, W, F],
        [F, W, W, W, L, W, K, W, W, K, W, W, W, W, W, F],
        [F, W, W, W, L, W, W, W, W, W, W, W, W, W, W, F],
        [F, W, L, L, L, W, K, K, K, W, W, W, W, W, W, F],
        [F, W, W, W, W, W, W, W, W, W, W, W, W, W, W, F],
        [F, W, W, W, W, G, G, G, G, G, G, G, G, W, W, F],
        [F, W, W, W, W, G, G, G, G, G, G, G, G, W, W, F],
        [F, W, W, W, W, W, W, W, W, W, W, W, W, W, W, F],
        [F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F],
        [_, _, _, _, _, F, F, F, F, F, F, _, _, _, _, _],
    ];
})();

// ─── Chair (8×8) ────────────────────────────────────────────────────────────────
export const CHAIR_SPRITE: string[][] = (() => {
    const S = '#1a1d21', C = '#2a2730', L = '#3d3850', G = '#0D0F10';
    return [
        [_, _, C, C, C, C, _, _],
        [_, C, L, L, L, L, C, _],
        [_, C, L, S, S, L, C, _],
        [_, C, L, S, S, L, C, _],
        [_, _, C, C, C, C, _, _],
        [_, G, _, C, C, _, G, _],
        [_, G, _, _, _, _, G, _],
        [_, G, _, _, _, _, G, _],
    ];
})();
