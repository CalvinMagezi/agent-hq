/**
 * StreamBuffer — buffers streaming text chunks and flushes at word/punctuation
 * boundaries for natural rendering. Prevents partial words from appearing
 * mid-render. Falls back to immediate flush after `silenceMs` of inactivity
 * (handles code blocks and content with no whitespace/punctuation).
 *
 * Replace the 50ms debounce in ChatPanel with this for natural word-paced output.
 */
export class StreamBuffer {
    private pending = ''
    private silenceTimer: ReturnType<typeof setTimeout> | null = null
    private readonly onFlush: (text: string) => void
    private readonly silenceMs: number

    constructor(onFlush: (text: string) => void, silenceMs = 200) {
        this.onFlush = onFlush
        this.silenceMs = silenceMs
    }

    /**
     * Push a new chunk into the buffer.
     * Flushes everything up to the last word/punctuation boundary immediately.
     * Remaining partial word is held until the next boundary or silence timeout.
     */
    push(chunk: string) {
        this.pending += chunk

        // Find the last safe flush point: after any whitespace or punctuation.
        // This ensures we never render a word mid-token.
        const match = this.pending.match(/^([\s\S]*[\s.?!,;:\n])/)
        if (match) {
            const safe = match[1]
            this.pending = this.pending.slice(safe.length)
            this.onFlush(safe)
        }

        // Reset silence fallback for remaining partial content.
        if (this.silenceTimer) clearTimeout(this.silenceTimer)
        if (this.pending) {
            this.silenceTimer = setTimeout(() => this._flushAll(), this.silenceMs)
        } else {
            this.silenceTimer = null
        }
    }

    /**
     * Force-flush all pending content immediately.
     * Call this on chat:done to ensure the final partial word is rendered.
     */
    flush() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer)
            this.silenceTimer = null
        }
        this._flushAll()
    }

    private _flushAll() {
        this.silenceTimer = null
        if (this.pending) {
            const text = this.pending
            this.pending = ''
            this.onFlush(text)
        }
    }

    dispose() {
        if (this.silenceTimer) clearTimeout(this.silenceTimer)
    }
}
