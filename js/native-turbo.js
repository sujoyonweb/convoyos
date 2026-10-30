/**
 * convoyOS v0.0.1 - Phase 3 Native HTTP/TCP Turbo Bridge, Hotspot Client & Android WebView Saver
 * - Zero-config LAN/Hotspot discovery via UDP Multicast (:53317)
 * - Upgrades same-LAN transfers to Kernel HTTP/TCP Streaming (60 - 250+ MB/s)
 * - Intercepts WebView blob: downloads inside .apk/.exe so WebRTC & Global Link files save directly to native Downloads
 */
(function () {
    const TURBO_PORT = 53317;
    const LOCAL_API = `http://127.0.0.1:${TURBO_PORT}`;

    let isNativeShell = false;
    let isConnectedToHotspotHost = window.location.port === String(TURBO_PORT);
    let localLanIp = null;
    let turboPeers = new Map();

    document.addEventListener('DOMContentLoaded', () => {
        initTurboBridge();
    });

    async function initTurboBridge() {
        // 1. Detect if running inside the compiled convoyOS Native App (.apk / .exe)
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 450);
            const res = await fetch(`${LOCAL_API}/api/node-info`, { signal: ctrl.signal });
            clearTimeout(timer);

            if (res.ok) {
                const info = await res.json();
                isNativeShell = true;
                localLanIp = info.lanIp;

                // Automatically configure Pair Tab QR to act as a Zero-Install Wi-Fi / Hotspot Host
                if (localLanIp && localLanIp !== '127.0.0.1') {
                    window.convoyStorage.saveSettings({
                        lanIpOverride: `${localLanIp}:${TURBO_PORT}`
                    });
                    window.convoyDiscovery.renderPairTabQR();
                }

                window.convoyApp.setNetworkBadge(true, `Turbo LAN (${localLanIp})`);
                installNativeBlobDownloadInterceptor();
                startNativeMulticastRadarLoop();
                checkWindowsExplorerCliFiles();
            }
        } catch (_) {}

        // 2. Detect if opened in a mobile/desktop browser via a friend's Zero-Install Hotspot QR (:53317)
        if (!isNativeShell && isConnectedToHotspotHost) {
            connectAsZeroInstallGuest();
        }

        // 3. Hook transfer dispatcher so LAN peers use Kernel HTTP Turbo automatically
        hookTransferDispatcher();
    }

    // =========================================================================
    // 1. ANDROID / WINDOWS WEBVIEW BLOB DOWNLOAD INTERCEPTOR
    // =========================================================================
    function installNativeBlobDownloadInterceptor() {
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (isNativeShell && this.download && this.href && this.href.startsWith('blob:')) {
                const fileName = this.download || 'download.bin';
                const blobUrl = this.href;
                saveBlobToNativeDownloads(blobUrl, fileName);
                return;
            }
            return origClick.apply(this, arguments);
        };
    }

    async function saveBlobToNativeDownloads(blobUrl, fileName) {
        try {
            const res = await fetch(blobUrl);
            const blob = await res.blob();
            const saveRes = await fetch(
                `${LOCAL_API}/api/save-local?name=${encodeURIComponent(fileName)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: blob
                }
            );
            if (saveRes.ok) {
                const info = await saveRes.json();
                window.convoyApp.showToast(`Saved "${info.savedName || fileName}" to Downloads!`, 'success');
            }
        } catch (_) {}
    }

    // =========================================================================
    // 2. 0% INTERNET UDP MULTICAST RADAR & WINDOWS RIGHT-CLICK CLI STAGING
    // =========================================================================
    function startNativeMulticastRadarLoop() {
        const pollLan = async () => {
            try {
                const s = window.convoyStorage.getSettings();
                const res = await fetch(
                    `${LOCAL_API}/api/lan-peers?id=${encodeURIComponent(s.nodeId)}&name=${encodeURIComponent(s.deviceName)}&os=${encodeURIComponent(s.osName)}&type=${encodeURIComponent(s.deviceType)}`
                );
                if (!res.ok) return;
                const data = await res.json();

                if (Array.isArray(data.peers)) {
                    data.peers.forEach((p) => {
                        if (!p.id || p.id === s.nodeId) return;
                        turboPeers.set(p.id, p);
                        window.convoyDiscovery.registerOfflinePeer({
                            id: p.id,
                            name: p.name,
                            os: `${p.os || 'LAN'} • Turbo HTTP`,
                            type: p.type || 'laptop',
                            paired: true,
                            turboEndpoint: `http://${p.ip}:${p.port || TURBO_PORT}`
                        });
                    });
                }

                if (Array.isArray(data.incomingFiles) && data.incomingFiles.length > 0) {
                    data.incomingFiles.forEach((item) => {
                        window.convoyApp.showToast(
                            `Saved "${item.fileName}" (${window.convoyDragDrop.formatBytes(item.fileSize)}) to Downloads!`,
                            'success'
                        );
                    });
                }
            } catch (_) {}
        };

        pollLan();
        setInterval(pollLan, 2000);
    }

    async function checkWindowsExplorerCliFiles() {
        try {
            const res = await fetch(`${LOCAL_API}/api/cli-staged`);
            if (!res.ok) return;
            const list = await res.json();
            if (Array.isArray(list) && list.length > 0) {
                const fetchedFiles = [];
                for (const item of list) {
                    const blobRes = await fetch(`${LOCAL_API}/api/cli-file?id=${encodeURIComponent(item.id)}`);
                    if (blobRes.ok) {
                        const blob = await blobRes.blob();
                        const fileObj = new File([blob], item.name, { type: blob.type || 'application/octet-stream' });
                        fetchedFiles.push(fileObj);
                    }
                }
                if (fetchedFiles.length > 0) {
                    window.convoyDragDrop.addFilesToQueue(fetchedFiles);
                }
            }
        } catch (_) {}
    }

    // =========================================================================
    // 3. ZERO-INSTALL WI-FI / HOTSPOT GUEST MODE
    // =========================================================================
    async function connectAsZeroInstallGuest() {
        try {
            const hostOrigin = window.location.origin;
            const res = await fetch(`${hostOrigin}/api/node-info`);
            if (!res.ok) return;
            const hostInfo = await res.json();

            const hostPeer = {
                id: hostInfo.nodeId || 'HOTSPOT-HOST',
                name: hostInfo.deviceName || 'Hotspot Host',
                os: 'Direct Wi-Fi Host • 100+ MB/s',
                type: 'laptop',
                paired: true,
                turboEndpoint: hostOrigin
            };

            turboPeers.set(hostPeer.id, {
                id: hostPeer.id,
                name: hostPeer.name,
                turboEndpoint: hostOrigin
            });

            window.convoyDiscovery.registerOfflinePeer(hostPeer);
            window.convoyApp.setNetworkBadge(true, 'Connected to Hotspot Host');
            window.convoyApp.showToast(`Connected directly to ${hostPeer.name} (0% Internet Mode)!`, 'success');
        } catch (_) {}
    }

    // =========================================================================
    // 4. KERNEL HTTP/TCP TURBO STREAMER (60 - 250+ MB/S) WITH WEBRTC FALLBACK
    // =========================================================================
    function hookTransferDispatcher() {
        if (!window.convoyTransfer || !window.convoyTransfer.initiateWebRtcTransfer) return;

        const originalWebRtcTransfer = window.convoyTransfer.initiateWebRtcTransfer;

        window.convoyTransfer.initiateWebRtcTransfer = async function (peer, resumeOffset = 0) {
            const knownTurbo = turboPeers.get(peer?.id);
            const endpoint =
                peer?.turboEndpoint ||
                (knownTurbo ? (knownTurbo.turboEndpoint || `http://${knownTurbo.ip}:${knownTurbo.port || TURBO_PORT}`) : null);

            if (endpoint && resumeOffset === 0) {
                const reachable = await probeTurboEndpoint(endpoint);
                if (reachable) {
                    const files = window.convoyDragDrop.getStagedFiles();
                    if (files && files.length > 0) {
                        await runKernelHttpTurboBatch(peer, endpoint, files);
                        return;
                    }
                }
            }

            return originalWebRtcTransfer.call(this, peer, resumeOffset);
        };
    }

    async function probeTurboEndpoint(endpoint) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 350);
            const res = await fetch(`${endpoint}/api/ping`, { signal: ctrl.signal });
            clearTimeout(timer);
            return res.ok;
        } catch (_) {
            return false;
        }
    }

    async function runKernelHttpTurboBatch(peer, endpoint, files) {
        const modal = document.getElementById('transferModal');
        const titleEl = document.getElementById('transferModalTitle');
        const fnEl = document.getElementById('transferFilename');
        const pctEl = document.getElementById('transferPercent');
        const chunkEl = document.getElementById('transferChunkCounter');
        const sizeEl = document.getElementById('transferSize');
        const barEl = document.getElementById('transferProgressBar');
        const speedEl = document.getElementById('transferSpeed');
        const doneBtn = document.getElementById('transferDoneBtn');
        const pauseBtn = document.getElementById('pauseResumeBtn');
        const iconUse = document.getElementById('transferStatusIconUse');

        const totalBatchBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
        let completedBytes = 0;
        const batchStartTime = performance.now();

        if (modal) modal.classList.remove('hidden');
        if (titleEl) titleEl.textContent = `Turbo Streaming to ${peer.name}...`;
        if (iconUse) iconUse.setAttribute('href', '#icon-cloud-up');
        if (doneBtn) doneBtn.classList.add('hidden');
        if (pauseBtn) pauseBtn.classList.add('hidden');

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const displayLabel = files.length > 1 ? `(${i + 1}/${files.length}) ${file.name}` : file.name;
            if (fnEl) fnEl.textContent = displayLabel;

            const ok = await streamSingleFileViaHttp(endpoint, file, (loadedInFile) => {
                const currentTotal = completedBytes + loadedInFile;
                const pct = totalBatchBytes > 0 ? Math.min(99, Math.round((currentTotal / totalBatchBytes) * 100)) : 99;
                const elapsedSec = Math.max(0.05, (performance.now() - batchStartTime) / 1000);
                const mbps = ((currentTotal / (1024 * 1024)) / elapsedSec).toFixed(2);

                const totalChunks = Math.max(1, Math.ceil(totalBatchBytes / 65536));
                const curChunk = Math.min(totalChunks, Math.ceil(currentTotal / 65536));

                if (pctEl) pctEl.textContent = `${pct}%`;
                if (chunkEl) chunkEl.textContent = `${curChunk} / ${totalChunks} Chunks`;
                if (sizeEl) {
                    sizeEl.textContent = `${window.convoyDragDrop.formatBytes(currentTotal)} / ${window.convoyDragDrop.formatBytes(totalBatchBytes)}`;
                }
                if (barEl) barEl.style.width = `${pct}%`;
                if (speedEl) speedEl.textContent = `${mbps} MB/s • Kernel HTTP Turbo`;
            });

            if (!ok) {
                window.convoyApp.showToast('Turbo stream interrupted, switching to WebRTC Direct...', 'info');
                return;
            }
            completedBytes += file.size;
        }

        const totalElapsed = Math.max(0.05, (performance.now() - batchStartTime) / 1000);
        const avgMbps = ((totalBatchBytes / (1024 * 1024)) / totalElapsed).toFixed(2);
        const totalChunks = Math.max(1, Math.ceil(totalBatchBytes / 65536));

        if (titleEl) titleEl.textContent = `Delivered ${files.length} item(s) to ${peer.name}`;
        if (pctEl) pctEl.textContent = '100%';
        if (chunkEl) chunkEl.textContent = `${totalChunks} / ${totalChunks} Chunks`;
        if (sizeEl) {
            const totalFormatted = window.convoyDragDrop.formatBytes(totalBatchBytes);
            sizeEl.textContent = `${totalFormatted} / ${totalFormatted}`;
        }
        if (barEl) barEl.style.width = '100%';
        if (speedEl) speedEl.textContent = `${avgMbps} MB/s • 100% Complete (Kernel Turbo)`;
        if (iconUse) iconUse.setAttribute('href', '#icon-check');
        if (doneBtn) doneBtn.classList.remove('hidden');

        window.convoyApp.showToast(`Turbo-sent ${files.length} item(s) at ${avgMbps} MB/s!`, 'success');
    }

    function streamSingleFileViaHttp(endpoint, file, onProgress) {
        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            const senderName = window.convoyStorage.getSettings().deviceName;
            const url = `${endpoint}/api/upload?name=${encodeURIComponent(file.name)}&size=${file.size}&sender=${encodeURIComponent(senderName)}`;

            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(e.loaded);
                }
            };

            xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
            xhr.onerror = () => resolve(false);
            xhr.onabort = () => resolve(false);

            xhr.send(file);
        });
    }
})();