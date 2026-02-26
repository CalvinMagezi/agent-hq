// ─── Matrix Digital Rain Effect ───────────────────────────────────────────────
// Plays when an agent comes online. Classic green-character rain effect
// adapted from pixel-agents for use as a canvas overlay.

interface RainDrop {
    col: number;       // Column index
    y: number;         // Current Y pixel position
    speed: number;     // Fall speed px/frame
    charTimer: number; // Timer for character cycling
    chars: string[];   // Character column (trail)
    active: boolean;
}

const CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノHAQHWGENERATING01';
const FONT_SIZE = 14;
const RAIN_COLOR_HEAD = '#ffffff';
const RAIN_COLOR_BRIGHT = '#00ff99';
const RAIN_COLOR_MID = '#00C6FA';
const RAIN_COLOR_TAIL = 'rgba(0, 198, 250, 0.3)';

function randomChar(): string {
    return CHARS[Math.floor(Math.random() * CHARS.length)];
}

/**
 * Start a matrix rain effect on the given container element.
 * The canvas is created as an absolute overlay and removed automatically after `duration` ms.
 *
 * @param container  The parent element to overlay
 * @param duration   Effect duration in milliseconds (default 2000)
 * @param onDone     Optional callback when effect ends
 */
export function startMatrixEffect(
    container: HTMLElement,
    duration = 2000,
    onDone?: () => void
): () => void {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '100';
    canvas.style.borderRadius = 'inherit';

    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    container.appendChild(canvas);

    const ctx = canvas.getContext('2d')!;
    const cols = Math.floor(w / FONT_SIZE);

    const drops: RainDrop[] = Array.from({ length: cols }, (_, col) => ({
        col,
        y: -Math.random() * h,
        speed: 2 + Math.random() * 4,
        charTimer: 0,
        chars: Array.from({ length: 20 }, () => randomChar()),
        active: true,
    }));

    const startTime = performance.now();
    let frameId: number | null = null;

    function frame(now: number) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Fade out in the last 30%
        const alpha = progress > 0.7 ? 1 - (progress - 0.7) / 0.3 : 1;

        ctx.fillStyle = `rgba(13, 15, 16, 0.15)`;
        ctx.fillRect(0, 0, w, h);

        ctx.font = `${FONT_SIZE}px monospace`;
        ctx.textAlign = 'left';

        for (const drop of drops) {
            // Update and shift characters
            drop.charTimer++;
            if (drop.charTimer % 3 === 0) {
                drop.chars.shift();
                drop.chars.push(randomChar());
            }

            // Draw the column trail
            for (let i = 0; i < drop.chars.length; i++) {
                const cy = drop.y - i * FONT_SIZE;
                if (cy < -FONT_SIZE || cy > h + FONT_SIZE) continue;

                const ratio = i / drop.chars.length;
                if (i === 0) {
                    ctx.fillStyle = RAIN_COLOR_HEAD;
                } else if (ratio < 0.15) {
                    ctx.fillStyle = RAIN_COLOR_BRIGHT;
                } else if (ratio < 0.5) {
                    ctx.fillStyle = RAIN_COLOR_MID;
                } else {
                    ctx.fillStyle = RAIN_COLOR_TAIL;
                }

                ctx.globalAlpha = alpha;
                ctx.fillText(drop.chars[i], drop.col * FONT_SIZE, cy);
            }

            drop.y += drop.speed;

            // Reset drop when it goes fully off screen
            if (drop.y - drop.chars.length * FONT_SIZE > h) {
                drop.y = -Math.random() * h * 0.3;
                drop.speed = 2 + Math.random() * 4;
            }
        }

        ctx.globalAlpha = 1;

        if (elapsed < duration) {
            frameId = requestAnimationFrame(frame);
        } else {
            // Remove canvas and fire callback
            canvas.remove();
            onDone?.();
        }
    }

    frameId = requestAnimationFrame(frame);

    // Return a cleanup function
    return () => {
        if (frameId !== null) cancelAnimationFrame(frameId);
        canvas.remove();
    };
}
