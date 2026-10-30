/**
 * convoyOS v0.0.1 - Network-First Service Worker + Direct Stream & Android Share Target
 */
const CACHE_NAME = 'convoyos-offline-v0.4.0';
const OFFLINE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './css/variables.css',
    './css/reset.css',
    './css/main.css',
    './css/components.css',
    './js/qr.js',
    './js/storage.js',
    './js/dragdrop.js',
    './js/discovery.js',
    './js/transfer.js',
    './js/app.js',
    './js/native-turbo.js',
    './assets/favicon.svg',
    './assets/favicon.png',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './assets/fonts/inter-v20-latin-regular.woff2',
    './assets/fonts/inter-v20-latin-500.woff2',
    './assets/fonts/inter-v20-latin-600.woff2',
    './assets/fonts/jetbrains-mono-v24-latin-regular.woff2',
    './assets/fonts/jetbrains-mono-v24-latin-500.woff2',
    './assets/fonts/jetbrains-mono-v24-latin-700.woff2'
];

const activeDownloadStreams = new Map();
let pendingSharedPayload = null;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) return caches.delete(key);
                })
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'CLAIM_SHARED_ITEMS' && pendingSharedPayload) {
        event.source?.postMessage({
            type: 'CONVOY_OS_SHARE_TARGET',
            ...pendingSharedPayload
        });
        pendingSharedPayload = null;
        return;
    }

    if (data.type === 'REGISTER_DOWNLOAD_STREAM' && data.streamId && event.ports?.[0]) {
        const port = event.ports[0];
        let streamController = null;

        const stream = new ReadableStream({
            start(controller) {
                streamController = controller;
            },
            cancel() {
                activeDownloadStreams.delete(data.streamId);
            }
        });

        port.onmessage = (msgEvt) => {
            const payload = msgEvt.data;
            if (!streamController) return;

            if (payload === 'EOF') {
                try { streamController.close(); } catch (_) {}
                activeDownloadStreams.delete(data.streamId);
            } else if (payload === 'ABORT') {
                try { streamController.error(new Error('Transfer aborted')); } catch (_) {}
                activeDownloadStreams.delete(data.streamId);
            } else if (payload instanceof ArrayBuffer) {
                try { streamController.enqueue(new Uint8Array(payload)); } catch (_) {}
            } else if (ArrayBuffer.isView(payload)) {
                try { streamController.enqueue(payload); } catch (_) {}
            }
        };

        activeDownloadStreams.set(data.streamId, {
            stream,
            fileName: data.fileName || 'download.bin',
            fileSize: data.fileSize || 0,
            fileType: data.fileType || 'application/octet-stream'
        });

        port.postMessage({ type: 'STREAM_REGISTERED', streamId: data.streamId });
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 1. Intercept Android System Share Sheet POST (share_target)
    if (event.request.method === 'POST' && url.searchParams.has('share-target')) {
        event.respondWith(
            (async () => {
                try {
                    const formData = await event.request.formData();
                    const files = formData.getAll('shared_files') || [];
                    const textParts = [
                        formData.get('title'),
                        formData.get('text'),
                        formData.get('url')
                    ].filter(Boolean);
                    pendingSharedPayload = {
                        files,
                        text: textParts.join(' — ')
                    };
                } catch (_) {}
                return Response.redirect('./index.html?share-target=1', 303);
            })()
        );
        return;
    }

    if (event.request.method !== 'GET') return;

    // 2. Intercept Direct-to-Disk Stream Downloads
    const streamMatch = url.pathname.match(/\/__convoy_stream__\/([^/]+)$/);
    if (streamMatch && streamMatch[1]) {
        const streamId = decodeURIComponent(streamMatch[1]);
        const entry = activeDownloadStreams.get(streamId);
        if (entry) {
            activeDownloadStreams.delete(streamId);
            const safeName = entry.fileName.replace(/["\r\n]/g, '_');
            const headers = new Headers({
                'Content-Type': entry.fileType || 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
                'Cache-Control': 'no-store'
            });
            if (entry.fileSize > 0) {
                headers.set('Content-Length', String(entry.fileSize));
            }
            event.respondWith(new Response(entry.stream, { status: 200, headers }));
            return;
        }
    }

    // 3. Network-First with Offline Cache Fallback for App Assets
    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const clone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return networkResponse;
            })
            .catch(() => {
                return caches.match(event.request).then((cached) => cached || caches.match('./index.html'));
            })
    );
});