import { useQuery } from '@tanstack/react-query'

export interface ThreadMessage {
    role: 'user' | 'assistant' | 'system'
    content: string
    harness?: string
    timestamp: string
    stats?: {
        model: string
        latencyMs: number
        inputTokens: number
        outputTokens: number
        cost: number
        contextUsed?: number
    }
}

export interface Thread {
    threadId: string
    title: string
    harness: string
    messages: ThreadMessage[]
    createdAt: string
    updatedAt: string
    sessionTotals: { inputTokens: number; outputTokens: number; cost: number }
}

export function useThread(threadId: string | null) {
    return useQuery<Thread | null>({
        queryKey: ['thread', threadId] as const,
        enabled: !!threadId,
        queryFn: async () => {
            const res = await fetch(`/threads/${threadId}`)
            if (res.status === 404) return null
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return res.json()
        },
        staleTime: 30_000,
    })
}
