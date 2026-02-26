// ─── Colorization Utilities ───────────────────────────────────────────────────
// Two modes (from pixel-agents):
//   1. "colorize" — convert grayscale sprite pixels to HSL color
//   2. "adjust"   — hue-shift an already-colored sprite

/**
 * Parse a CSS hex color string (#rrggbb or #rgb) to [r, g, b].
 */
function hexToRgb(hex: string): [number, number, number] {
    const clean = hex.replace('#', '');
    if (clean.length === 3) {
        return [
            parseInt(clean[0] + clean[0], 16),
            parseInt(clean[1] + clean[1], 16),
            parseInt(clean[2] + clean[2], 16),
        ];
    }
    return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
    ];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }

    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

/**
 * Colorize mode: replaces grayscale pixels with a tinted version at the given hue.
 * Pixels are checked for near-gray (R ≈ G ≈ B) and re-tinted to hsl(hue, sat%, brightness).
 */
export function colorizeSprite(
    grid: string[][],
    hue: number,
    saturation = 60
): string[][] {
    return grid.map(row =>
        row.map(cell => {
            if (!cell) return cell;
            const [r, g, b] = hexToRgb(cell);
            const [, , l] = rgbToHsl(r, g, b);
            const isGrayscale = Math.abs(r - g) < 20 && Math.abs(g - b) < 20;
            if (!isGrayscale) return cell;
            return `hsl(${hue}, ${saturation}%, ${l}%)`;
        })
    );
}

/**
 * Adjust mode: hue-shift an already-colored sprite by `shift` degrees.
 */
export function hueShiftSprite(grid: string[][], shift: number): string[][] {
    return grid.map(row =>
        row.map(cell => {
            if (!cell) return cell;
            try {
                const [r, g, b] = hexToRgb(cell);
                const [h, s, l] = rgbToHsl(r, g, b);
                return `hsl(${(h + shift + 360) % 360}, ${s}%, ${l}%)`;
            } catch {
                return cell;
            }
        })
    );
}
