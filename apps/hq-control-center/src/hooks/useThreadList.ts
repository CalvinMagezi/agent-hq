import { useQuery } from '@tanstack/react-query'

export interface ThreadMeta {
    threadId: string
    title: string
    harness: string
    updatedAt: string
    messageCount: number
}

export function useThreadList() {
    return useQuery<ThreadMeta[]>({
        queryKey: ['threads'] as const,
        queryFn: async () => {
            const res = await fetch('/threads')
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return res.json()
        },
        staleTime: 30_000,
        placeholderData: [],
    })
}
