/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST?: Array<{ url: string; revision: string | null }> }

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST ?? [])

// Push notification handler
self.addEventListener('push', (event) => {
  if (!event.data) return
  let data: { title?: string; body?: string; tag?: string; url?: string } = {}
  try { data = event.data.json() } catch { data = { body: event.data.text() } }

  event.waitUntil(
    self.registration.showNotification(data.title ?? 'HQ Control Center', {
      body: data.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag ?? 'hq',
      data: { url: data.url ?? '/' },
    })
  )
})

// On notification click — open/focus PWA
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string })?.url ?? '/'

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((c) => c.url.startsWith(self.location.origin))
        if (existing) {
          existing.focus()
          return existing.navigate(url)
        }
        return self.clients.openWindow(url)
      })
  )
})
