// @ts-ignore - The types for api routes change too often in early v1
import { createAPIFileRoute } from '@tanstack/react-start/api'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { VAULT_PATH } from '../../server/vault'

export const APIRoute = createAPIFileRoute('/api/vault-asset')({
    GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url)
        const assetPath = url.searchParams.get('path')

        if (!assetPath) {
            return new Response('Missing path', { status: 400 })
        }

        const fullPath = path.join(VAULT_PATH, assetPath)

        // Security check to prevent path traversal outside vault
        if (!fullPath.startsWith(VAULT_PATH)) {
            return new Response('Invalid path', { status: 403 })
        }

        if (!fs.existsSync(fullPath)) {
            return new Response('Not found', { status: 404 })
        }

        const stat = fs.statSync(fullPath)

        // Better Content-Type mapping
        const ext = path.extname(fullPath).toLowerCase()
        let contentType = 'application/octet-stream'
        if (ext === '.pdf') contentType = 'application/pdf'
        else if (['.png', '.jpeg', '.jpg', '.gif', '.webp', '.svg'].includes(ext)) {
            contentType = `image/${ext.replace('.', '')}`
            if (ext === '.svg') contentType = 'image/svg+xml'
            if (ext === '.jpg') contentType = 'image/jpeg'
        } else if (ext === '.docx') contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        else if (ext === '.pptx') contentType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        else if (ext === '.xlsx') contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        else if (ext === '.html' || ext === '.htm') contentType = 'text/html'

        const buffer = fs.readFileSync(fullPath)

        return new Response(buffer, {
            headers: {
                'Content-Type': contentType,
                'Content-Length': stat.size.toString(),
                'Cache-Control': 'public, max-age=3600',
            },
        })
    },
})
