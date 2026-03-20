import { useState, useRef, useCallback } from 'react'
import {
    useQuery,
    useQueryClient,
    experimental_streamedQuery,
    queryOptions,
} from '@tanstack/react-query'

interface UseChatStreamReturn {
    isStreaming: boolean
    streamingContent: string
    toolActivity: string | null
    sendMessage: (content: string, threadId: string, harness: string) => void
    stop: () => void
    reset: () => void
}

interface PendingRequest {
    content: string
    threadId: string
    harness: string
}

/**
 * SSE chat streaming hook backed by TanStack Query's experimental_streamedQuery.
 *
 * Each message send creates a new query key (threadId + timestamp). The async
 * generator reads the /chat-stream SSE endpoint and yields word-boundary-buffered
 * chunks — so TQ's setQueryData fires at word/punctuation boundaries, not per raw
 * token. This keeps re-renders minimal while maintaining natural rendering rhythm.
 *
 * Query cache:
 *   key: ['chat', 'stream', requestId]
 *   data: accumulated response text (string, grows incrementally)
 *   fetchStatus: 'fetching' while streaming, 'idle' when done
 *
 * The WS connection still handles chat:history atomic swap and thread CRUD.
 */
export function useChatStream(): UseChatStreamReturn {
    const queryClient = useQueryClient()
    const [requestId, setRequestId] = useState<string | null>(null)
    const [toolActivity, setToolActivity] = useState<string | null>(null)
    const abortRef = useRef<AbortController | null>(null)
    const pendingRef = useRef<PendingRequest | null>(null)

    const streamOptions = queryOptions({
        queryKey: ['chat', 'stream', requestId] as const,
        enabled: requestId !== null,
        queryFn: experimental_streamedQuery({
            queryFn: async function* ({ signal }) {
                const pending = pendingRef.current
                if (!pending) return

                const abort = new AbortController()
                abortRef.current = abort
                // Let TanStack Query's own signal also cancel us
                signal.addEventListener('abort', () => abort.abort(), { once: true })

                const res = await fetch('/chat-stream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        threadId: pending.threadId,
                        content: pending.content,
                        harness: pending.harness,
                    }),
                    signal: abort.signal,
                })

                if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

                const reader = res.body.getReader()
                const decoder = new TextDecoder()
                let incomplete = ''
                // Word-boundary buffer — accumulate tokens here, yield at boundaries
                // so TQ's setQueryData fires at word/punctuation edges, not per raw token.
                let wordBuf = ''

                const yieldBoundary = function* (): Generator<string> {
                    const match = wordBuf.match(/^([\s\S]*[\s.?!,;:\n])/)
                    if (match) {
                        const safe = match[1]
                        wordBuf = wordBuf.slice(safe.length)
                        yield safe
                    }
                }

                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break

                    incomplete += decoder.decode(value, { stream: true })
                    const lines = incomplete.split('\n')
                    incomplete = lines.pop() ?? ''

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue
                        try {
                            const event = JSON.parse(line.slice(6))
                            if (event.type === 'token') {
                                setToolActivity(null)
                                wordBuf += event.token
                                yield* yieldBoundary()
                            } else if (event.type === 'status') {
                                setToolActivity(event.status ?? null)
                            }
                            // 'done' / 'error' handled by stream ending or thrown error
                        } catch { /* ignore malformed SSE lines */ }
                    }
                }

                // Flush any remaining partial word (e.g. final word before EOF)
                if (wordBuf) {
                    yield wordBuf
                    wordBuf = ''
                }
            },
            refetchMode: 'reset',
        }),
    })

    const streamQuery = useQuery(streamOptions)

    // isStreaming: true while the fetch is actively reading chunks
    const isStreaming = streamQuery.fetchStatus === 'fetching'
    // streamingContent: accumulated text — TQ grows this incrementally in the cache
    const streamingContent = (streamQuery.data as string | undefined) ?? ''

    const reset = useCallback(() => {
        abortRef.current?.abort()
        setToolActivity(null)
        if (requestId) {
            queryClient.removeQueries({ queryKey: ['chat', 'stream', requestId] })
        }
        setRequestId(null)
    }, [queryClient, requestId])

    const stop = useCallback(() => {
        abortRef.current?.abort()
        // Don't clear the content — let the bubble stay visible until chat:history swaps
    }, [])

    const sendMessage = useCallback((content: string, threadId: string, harness: string) => {
        // Cancel any in-flight request
        abortRef.current?.abort()
        setToolActivity(null)
        pendingRef.current = { content, threadId, harness }
        // New request ID triggers a fresh query
        setRequestId(`${threadId}-${Date.now()}`)
    }, [])

    return { isStreaming, streamingContent, toolActivity, sendMessage, stop, reset }
}
