/**
 * convoyOS v0.0.1 - Bulletproof Cross-Device Discovery, Global Link (ToffeeShare) & Signaling Engine
 */
(function () {
    const PUBLIC_GITHUB_PAGES_URL = 'https://sujoyonweb.github.io/convoyos/';
    const BROKER_URLS = [
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt'
    ];
    const HEARTBEAT_MS = 3500;
    const PEER_TIMEOUT_MS = 20000;
    const ACK_COOLDOWN_MS = 2500;
    const SHARE_CODE_SESSION_KEY = 'convoy_global_share_code_v2';

    let brokerIndex = 0;
    let wsClient = null;
    let wsConnected = false;
    let rxBuffer = new Uint8Array(0);

    let localBroadcast = null;
    let livePeers = new Map();        // peerId -> peerInfo
    let lastAckSent = new Map();      // peerId -> timestamp
    const seenMsgIds = new Set();

    let ipRoomTopic = 'convoyos/v2/lan/global_default';
    let globalShareCode = getOrCreateShareCode();
    let activeJoinCode = null;
    let waitingGlobalReceiver = null;
    let globalRequestRetryTimer = null;

    let cameraStream = null;
    let scanLoopActive = false;
    let offlinePc = null;

    function getOrCreateShareCode() {
        try {
            let code = sessionStorage.getItem(SHARE_CODE_SESSION_KEY);
            if (!code || code.length !== 6) {
                code = String(Math.floor(100000 + Math.random() * 900000));
                sessionStorage.setItem(SHARE_CODE_SESSION_KEY, code);
            }
            return code;
        } catch (_) {
            return String(Math.floor(100000 + Math.random() * 900000));
        }
    }

    async function init() {
        // 1. Open same-browser multi-tab channel FIRST so local #share= links work instantaneously
        if ('BroadcastChannel' in window) {
            localBroadcast = new BroadcastChannel('convoyos_local_tabs_v4');
            localBroadcast.onmessage = (e) => {
                if (e.data?.isRawBinary) {
                    const myId = window.convoyStorage.getSettings().nodeId;
                    if (e.data.targetId === myId) {
                        window.convoyTransfer.handleIncomingRawBinaryPacket(e.data.buffer);
                    }
                } else {
                    handleSignalingPayload(e.data);
                }
            };
        }

        renderPairTabQR();
        renderGlobalShareTab();

        // 2. Check URL hash (#share=XXXXXX or #pair=XXXXXX) before connecting
        checkUrlForIncomingHash();

        // 3. Connect to WebSocket MQTT broker
        connectMqttWebSocket();

        // 4. Resolve shared router IPv4 via STUN + HTTP fallback
        resolveSharedIpv4Room().then((resolvedTopic) => {
            if (resolvedTopic && resolvedTopic !== ipRoomTopic) {
                ipRoomTopic = resolvedTopic;
                if (wsConnected) {
                    subscribeTopic(ipRoomTopic);
                    announcePresence(true);
                }
            }
        });

        // 5. Periodic heartbeat & stale-peer cleanup
        setInterval(() => {
            if (!wsConnected && navigator.onLine) {
                connectMqttWebSocket();
            }
            announcePresence(false);
            pruneStalePeers();
        }, HEARTBEAT_MS);

        // 6. Instant recovery when switching back to tab or waking phone screen
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                if (!wsConnected && navigator.onLine) connectMqttWebSocket();
                announcePresence(true);
            }
        });

        window.addEventListener('focus', () => {
            announcePresence(true);
        });

        window.addEventListener('beforeunload', () => {
            sendLeaveSignal();
        });

        renderDeviceList();
    }

    // =========================================================================
    // BRAVE-PROOF PUBLIC IPV4 DISCOVERY (STUN + HTTP FALLBACK)
    // =========================================================================
    function getPublicIpv4ViaStun() {
        return new Promise((resolve) => {
            try {
                const pc = new RTCPeerConnection({
                    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
                });
                let resolved = false;
                const done = (ip) => {
                    if (resolved) return;
                    resolved = true;
                    try { pc.close(); } catch (_) {}
                    resolve(ip);
                };

                setTimeout(() => done(null), 1800);

                pc.createDataChannel('stun_probe');
                pc.onicecandidate = (e) => {
                    if (!e.candidate || !e.candidate.candidate) return;
                    const candStr = e.candidate.candidate;
                    const match = candStr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+\d+\s+typ\s+srflx/);
                    if (match && match[1]) {
                        done(match[1]);
                    }
                };
                pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => done(null));
            } catch (_) {
                resolve(null);
            }
        });
    }

    async function getPublicIpViaHttp() {
        const endpoints = [
            'https://api.ipify.org?format=text',
            'https://ipv4.icanhazip.com',
            'https://1.1.1.1/cdn-cgi/trace'
        ];
        for (const url of endpoints) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 1800);
                const res = await fetch(url, { signal: ctrl.signal });
                clearTimeout(timer);
                const text = (await res.text()).trim();
                const rawIp = text.includes('ip=') ? text.match(/ip=([^\n\r]+)/)?.[1] : text;
                if (rawIp) return rawIp.trim();
            } catch (_) {}
        }
        return null;
    }

    function normalizeIpForRoomHash(ipStr) {
        if (!ipStr) return null;
        if (ipStr.includes(':')) {
            return ipStr.split(':').slice(0, 4).join(':').toLowerCase();
        }
        return ipStr;
    }

    async function resolveSharedIpv4Room() {
        let ip = await getPublicIpv4ViaStun();
        if (!ip) {
            ip = await getPublicIpViaHttp();
        }
        const normalized = normalizeIpForRoomHash(ip);
        if (!normalized) return ipRoomTopic;

        let hash = 5381;
        for (let i = 0; i < normalized.length; i++) {
            hash = (hash * 33) ^ normalized.charCodeAt(i);
        }
        return `convoyos/v2/lan/${(hash >>> 0).toString(16)}`;
    }

    // =========================================================================
    // ZERO-DEPENDENCY MQTT v3.1.1 (JSON + RAW BINARY STREAMING)
    // =========================================================================
    function appendBytes(a, b) {
        if (a.length === 0) return b;
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    }

    function encodeRemainingLength(len) {
        const bytes = [];
        do {
            let encoded = len % 128;
            len = Math.floor(len / 128);
            if (len > 0) encoded |= 128;
            bytes.push(encoded);
        } while (len > 0);
        return bytes;
    }

    function encodeUtf8Prefixed(str) {
        const u8 = new TextEncoder().encode(str);
        return [(u8.length >> 8) & 0xff, u8.length & 0xff, ...u8];
    }

    function buildMqttConnectPacket(clientId) {
        const body = [
            0x00, 0x04, 0x4d, 0x51, 0x54, 0x54,
            0x04,
            0x02,
            0x00, 0x3c,
            ...encodeUtf8Prefixed(clientId)
        ];
        return new Uint8Array([0x10, ...encodeRemainingLength(body.length), ...body]);
    }

    function buildMqttSubscribePacket(topic, packetId) {
        const body = [
            (packetId >> 8) & 0xff,
            packetId & 0xff,
            ...encodeUtf8Prefixed(topic),
            0x00
        ];
        return new Uint8Array([0x82, ...encodeRemainingLength(body.length), ...body]);
    }

    function buildMqttPublishBytesPacket(topic, payloadUint8) {
        const topicBytes = encodeUtf8Prefixed(topic);
        const remLen = topicBytes.length + payloadUint8.byteLength;
        const remBytes = encodeRemainingLength(remLen);
        const pkt = new Uint8Array(1 + remBytes.length + remLen);

        let offset = 0;
        pkt[offset++] = 0x30;
        for (const b of remBytes) pkt[offset++] = b;
        pkt.set(topicBytes, offset);
        offset += topicBytes.length;
        pkt.set(payloadUint8, offset);
        return pkt;
    }

    function connectMqttWebSocket() {
        if (!navigator.onLine) {
            window.convoyApp?.setNetworkBadge(false, 'Offline Mode');
            return;
        }
        if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const url = BROKER_URLS[brokerIndex % BROKER_URLS.length];
        try {
            rxBuffer = new Uint8Array(0);
            wsClient = new WebSocket(url, 'mqtt');
            wsClient.binaryType = 'arraybuffer';

            wsClient.onopen = () => {
                const settings = window.convoyStorage.getSettings();
                const clientId = 'cv_' + settings.nodeId + '_' + Math.floor(1000 + Math.random() * 8999);
                wsClient.send(buildMqttConnectPacket(clientId));
            };

            wsClient.onmessage = (event) => {
                rxBuffer = appendBytes(rxBuffer, new Uint8Array(event.data));

                while (rxBuffer.length >= 2) {
                    const headerByte = rxBuffer[0];
                    const packetType = headerByte >> 4;

                    let offset = 1;
                    let mult = 1;
                    let remLen = 0;
                    let encodedByte;
                    let headerComplete = false;

                    do {
                        if (offset >= rxBuffer.length) break;
                        encodedByte = rxBuffer[offset++];
                        remLen += (encodedByte & 127) * mult;
                        mult *= 128;
                        if ((encodedByte & 128) === 0) {
                            headerComplete = true;
                            break;
                        }
                    } while (offset < 5);

                    if (!headerComplete) break;

                    const packetEnd = offset + remLen;
                    if (packetEnd > rxBuffer.length) break;

                    if (packetType === 2) {
                        wsConnected = true;
                        window.convoyApp?.setNetworkBadge(true, 'Live Ready');
                        subscribeAllRooms();
                        setTimeout(() => {
                            announcePresence(true);
                            // If this tab was opened with #share=XXXXXX, fire the MQTT share request now
                            if (activeJoinCode) {
                                dispatchGlobalShareRequestPackets(activeJoinCode);
                            }
                        }, 100);
                    } else if (packetType === 3) {
                        const topicLen = (rxBuffer[offset] << 8) | rxBuffer[offset + 1];
                        const topicStr = new TextDecoder().decode(rxBuffer.slice(offset + 2, offset + 2 + topicLen));
                        const payloadStart = offset + 2 + topicLen;
                        const payloadSlice = rxBuffer.slice(payloadStart, packetEnd);

                        if (topicStr.startsWith('convoyos/v2/bin/')) {
                            window.convoyTransfer.handleIncomingRawBinaryPacket(payloadSlice.buffer);
                        } else {
                            try {
                                const jsonStr = new TextDecoder().decode(payloadSlice);
                                const data = JSON.parse(jsonStr);
                                handleSignalingPayload(data);
                            } catch (_) {}
                        }
                    }

                    rxBuffer = rxBuffer.slice(packetEnd);
                }
            };

            wsClient.onclose = () => {
                wsConnected = false;
                rxBuffer = new Uint8Array(0);
                brokerIndex++;
                setTimeout(connectMqttWebSocket, 2000);
            };

            wsClient.onerror = () => {
                wsConnected = false;
            };
        } catch (_) {}
    }

    function subscribeTopic(topic) {
        if (!wsClient || !wsConnected || wsClient.readyState !== WebSocket.OPEN) return;
        const pktId = Math.floor(10 + Math.random() * 60000);
        wsClient.send(buildMqttSubscribePacket(topic, pktId));
    }

    function subscribeAllRooms() {
        const s = window.convoyStorage.getSettings();
        const topics = new Set([
            ipRoomTopic,
            'convoyos/v2/lan/global_default',
            `convoyos/v2/node/${s.nodeId}`,
            `convoyos/v2/bin/${s.nodeId}`,
            `convoyos/v2/pin/${s.pairPin}`,
            `convoyos/v2/share/${globalShareCode}`,
            ...window.convoyStorage.getPairedRooms().map((pin) => `convoyos/v2/pin/${pin}`)
        ]);

        topics.forEach((t) => subscribeTopic(t));
    }

    function publishSignaling(topic, payloadObj) {
        try {
            const jsonStr = JSON.stringify(payloadObj);
            const jsonBytes = new TextEncoder().encode(jsonStr);

            if (wsClient && wsConnected && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(buildMqttPublishBytesPacket(topic, jsonBytes));
            }

            if (localBroadcast) {
                try {
                    localBroadcast.postMessage(JSON.parse(jsonStr));
                } catch (_) {}
            }
        } catch (_) {}
    }

    function sendBinaryChunk(targetNodeId, arrayBuffer) {
        if (wsClient && wsConnected && wsClient.readyState === WebSocket.OPEN) {
            const u8 = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
            wsClient.send(buildMqttPublishBytesPacket(`convoyos/v2/bin/${targetNodeId}`, u8));
        }
        if (localBroadcast) {
            try {
                localBroadcast.postMessage({
                    isRawBinary: true,
                    targetId: targetNodeId,
                    buffer: arrayBuffer
                });
            } catch (_) {}
        }
    }

    function getBufferedAmount() {
        if (wsClient && wsConnected && wsClient.readyState === WebSocket.OPEN) {
            return wsClient.bufferedAmount || 0;
        }
        return 0;
    }

    // =========================================================================
    // LIVE PRESENCE, DETERMINISTIC SIGNALING & PEER PRUNING
    // =========================================================================
    function buildSelfPeerDescriptor(isPairedChannel = false) {
        const s = window.convoyStorage.getSettings();
        return {
            id: s.nodeId,
            name: s.deviceName,
            type: s.deviceType,
            os: s.osName,
            pin: s.pairPin,
            paired: isPairedChannel
        };
    }

    function announcePresence(isScanRequest = false) {
        const s = window.convoyStorage.getSettings();
        const lanPacket = {
            type: 'HEARTBEAT',
            scanRequest: Boolean(isScanRequest),
            peer: buildSelfPeerDescriptor(false)
        };

        publishSignaling(ipRoomTopic, lanPacket);
        if (ipRoomTopic !== 'convoyos/v2/lan/global_default') {
            publishSignaling('convoyos/v2/lan/global_default', lanPacket);
        }

        const pairedPacket = {
            type: 'HEARTBEAT',
            scanRequest: Boolean(isScanRequest),
            peer: buildSelfPeerDescriptor(true)
        };
        publishSignaling(`convoyos/v2/pin/${s.pairPin}`, pairedPacket);

        window.convoyStorage.getPairedRooms().forEach((pin) => {
            publishSignaling(`convoyos/v2/pin/${pin}`, pairedPacket);
        });

        if (wsClient && wsConnected && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(new Uint8Array([0xc0, 0x00]));
        }
    }

    function sendLeaveSignal() {
        const s = window.convoyStorage.getSettings();
        const msg = { type: 'LEAVE', peerId: s.nodeId };
        publishSignaling(ipRoomTopic, msg);
        window.convoyStorage.getPairedRooms().forEach((pin) => {
            publishSignaling(`convoyos/v2/pin/${pin}`, msg);
        });
    }

    function sendDirectSignal(targetNodeId, payload) {
        const packet = {
            ...payload,
            targetId: targetNodeId,
            peer: buildSelfPeerDescriptor(false),
            msgId: 'M-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        };

        publishSignaling(`convoyos/v2/node/${targetNodeId}`, packet);
    }

    function registerOrRefreshPeer(peerObj, forcePaired = false) {
        if (!peerObj || !peerObj.id) return false;
        const s = window.convoyStorage.getSettings();
        if (peerObj.id === s.nodeId) return false;

        const isNew = !livePeers.has(peerObj.id);
        const existing = livePeers.get(peerObj.id);
        const savedPins = window.convoyStorage.getPairedRooms();
        const isPaired =
            forcePaired ||
            Boolean(peerObj.paired) ||
            Boolean(existing?.paired) ||
            savedPins.includes(String(peerObj.pin));

        const updatedPeer = {
            ...peerObj,
            paired: isPaired,
            lastSeen: Date.now()
        };
        livePeers.set(peerObj.id, updatedPeer);

        if (isNew) {
            renderDeviceList();
            if (window.convoyTransfer?.prewarmPeerConnection) {
                window.convoyTransfer.prewarmPeerConnection(updatedPeer);
            }
        }
        return isNew;
    }

    function handleSignalingPayload(data) {
        if (!data) return;

        if (data.msgId) {
            if (seenMsgIds.has(data.msgId)) return;
            seenMsgIds.add(data.msgId);
            if (seenMsgIds.size > 800) {
                const oldest = seenMsgIds.values().next().value;
                seenMsgIds.delete(oldest);
            }
        }

        const s = window.convoyStorage.getSettings();

        if (data.peer && data.peer.id && data.peer.id !== s.nodeId) {
            registerOrRefreshPeer(data.peer);
        }

        if (data.type === 'HEARTBEAT' && data.peer && data.peer.id !== s.nodeId) {
            const incoming = data.peer;
            const lastAck = lastAckSent.get(incoming.id) || 0;
            if (data.scanRequest || (Date.now() - lastAck > ACK_COOLDOWN_MS)) {
                lastAckSent.set(incoming.id, Date.now());
                sendDirectSignal(incoming.id, {
                    type: 'HEARTBEAT_ACK',
                    peer: buildSelfPeerDescriptor(incoming.paired)
                });
            }
        } else if (data.type === 'HEARTBEAT_ACK' && data.peer && data.peer.id !== s.nodeId) {
            registerOrRefreshPeer(data.peer);
        } else if (data.type === 'LEAVE' && data.peerId) {
            if (livePeers.delete(data.peerId)) renderDeviceList();
        } else if (data.type === 'PAIR_CONFIRM' && data.peer && data.peer.id !== s.nodeId) {
            window.convoyStorage.addPairedRoom(data.pin);
            registerOrRefreshPeer(data.peer, true);
            renderDeviceList();
            window.convoyApp.switchHubTab('nearby');
            window.convoyApp.showToast(`Paired with ${data.peer.name}!`, 'success');
        } else if (
            data.type === 'GLOBAL_SHARE_REQUEST' &&
            String(data.shareCode) === String(globalShareCode) &&
            data.peer &&
            data.peer.id !== s.nodeId
        ) {
            handleIncomingGlobalShareRequest(data.peer);
        } else if (data.type === 'GLOBAL_SHARE_WAITING' && data.targetId === s.nodeId) {
            if (globalRequestRetryTimer) clearInterval(globalRequestRetryTimer);
            activeJoinCode = null;
            window.convoyApp.showToast(`Connected to ${data.senderName}! Waiting for sender to stage files...`, 'info');
        } else if (data.type === 'WEBRTC_SIGNAL' && data.targetId === s.nodeId) {
            if (globalRequestRetryTimer) clearInterval(globalRequestRetryTimer);
            activeJoinCode = null;
            window.convoyTransfer.handleIncomingWebRtcSignal(data);
        } else if (data.type === 'TRANSFER_CTRL' && data.targetId === s.nodeId) {
            if (globalRequestRetryTimer) clearInterval(globalRequestRetryTimer);
            activeJoinCode = null;
            window.convoyTransfer.handleSignalingTransferCtrl(data);
        }
    }

    function pruneStalePeers() {
        const now = Date.now();
        let removedAny = false;
        livePeers.forEach((peer, id) => {
            if (window.convoyTransfer?.isPeerActive && window.convoyTransfer.isPeerActive(id)) {
                peer.lastSeen = now;
                return;
            }
            if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
                livePeers.delete(id);
                removedAny = true;
            }
        });
        if (removedAny) renderDeviceList();
    }

    // =========================================================================
    // GLOBAL LINK (TOFFEESHARE MODE) ENGINE
    // =========================================================================
    function getShareableBaseUrl() {
        const s = window.convoyStorage.getSettings();
        // 1. If user specified a custom LAN IP override in Settings, use it
        if (s.lanIpOverride && s.lanIpOverride.trim()) {
            const clean = s.lanIpOverride.trim().replace(/^https?:\/\//, '');
            return `http://${clean}${window.location.pathname}`;
        }
        // 2. If running on localhost / 127.0.0.1, use sujoyonweb's live GitHub Pages URL
        // so phones scanning the QR code open the real hosted web app instead of failing on 127.0.0.1!
        const host = window.location.hostname;
        if (host === '127.0.0.1' || host === 'localhost' || window.location.protocol === 'file:') {
            return PUBLIC_GITHUB_PAGES_URL;
        }
        return window.location.origin + window.location.pathname;
    }

    function renderGlobalShareTab() {
        const codeEl = document.getElementById('globalCodeDisplay');
        const urlEl = document.getElementById('globalUrlInput');

        if (codeEl) {
            codeEl.textContent = globalShareCode.slice(0, 3) + '-' + globalShareCode.slice(3);
        }

        const shareUrl = `${getShareableBaseUrl()}#share=${globalShareCode}`;
        if (urlEl) {
            urlEl.value = shareUrl;
        }

        window.convoyQR.renderInto('globalQrContainer', shareUrl, '#0c0c0c');
        updateGlobalShareBadge();
    }

    function updateGlobalShareBadge() {
        const statusEl = document.getElementById('globalShareStatus');
        if (!statusEl) return;

        const files = window.convoyDragDrop?.getStagedFiles() || [];
        if (files.length === 0) {
            statusEl.textContent = 'Select files on the left to activate link';
            statusEl.style.color = 'var(--text-secondary)';
            statusEl.style.borderColor = 'var(--border-subtle)';
        } else {
            const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
            const sizeStr = window.convoyDragDrop.formatBytes(totalBytes);
            statusEl.textContent = `${files.length} file(s) ready (${sizeStr}) • Link Active`;
            statusEl.style.color = '#34d399';
            statusEl.style.borderColor = 'var(--accent-emerald-border)';
        }
    }

    function regenerateGlobalShareCode() {
        globalShareCode = String(Math.floor(100000 + Math.random() * 900000));
        try {
            sessionStorage.setItem(SHARE_CODE_SESSION_KEY, globalShareCode);
        } catch (_) {}
        waitingGlobalReceiver = null;
        subscribeTopic(`convoyos/v2/share/${globalShareCode}`);
        renderGlobalShareTab();
        window.convoyApp.showToast('Generated new Global Share link & QR code', 'info');
    }

    function copyGlobalShareLink() {
        const files = window.convoyDragDrop.getStagedFiles();
        if (files.length === 0) {
            window.convoyApp.showToast('Tip: Select files on the left so recipients can download immediately!', 'info');
        }
        const urlEl = document.getElementById('globalUrlInput');
        const shareUrl = urlEl?.value || `${getShareableBaseUrl()}#share=${globalShareCode}`;
        navigator.clipboard?.writeText(shareUrl);
        window.convoyApp.showToast(`Copied Global Link (${globalShareCode.slice(0, 3)}-${globalShareCode.slice(3)})!`, 'success');
    }

    async function nativeShareGlobalLink() {
        const urlEl = document.getElementById('globalUrlInput');
        const shareUrl = urlEl?.value || `${getShareableBaseUrl()}#share=${globalShareCode}`;
        const files = window.convoyDragDrop.getStagedFiles();
        const title = files.length > 0
            ? `Download ${files.length} file(s) via convoyOS P2P`
            : 'Download files via convoyOS P2P';

        if (navigator.share) {
            try {
                await navigator.share({
                    title: 'convoyOS Direct P2P Share',
                    text: title,
                    url: shareUrl
                });
                return;
            } catch (_) {}
        }
        copyGlobalShareLink();
    }

    function handleIncomingGlobalShareRequest(receiverPeer) {
        registerOrRefreshPeer(receiverPeer, true);
        const files = window.convoyDragDrop.getStagedFiles();

        if (files.length === 0) {
            waitingGlobalReceiver = receiverPeer;
            sendDirectSignal(receiverPeer.id, {
                type: 'GLOBAL_SHARE_WAITING',
                senderName: window.convoyStorage.getSettings().deviceName
            });
            window.convoyApp.showToast(
                `${receiverPeer.name} connected via Global Link! Select files on the left to start sending.`,
                'info'
            );
            return;
        }

        waitingGlobalReceiver = null;
        window.convoyApp.showToast(`${receiverPeer.name} connected via Global Link! Starting stream...`, 'success');
        window.convoyTransfer.initiateWebRtcTransfer(receiverPeer);
    }

    function onFilesStaged() {
        updateGlobalShareBadge();
        if (waitingGlobalReceiver) {
            const peerToServe = waitingGlobalReceiver;
            waitingGlobalReceiver = null;
            window.convoyTransfer.initiateWebRtcTransfer(peerToServe);
        }
    }

    function dispatchGlobalShareRequestPackets(rawCode) {
        const shareTopic = `convoyos/v2/share/${rawCode}`;
        subscribeTopic(shareTopic);

        const sendReq = () => {
            if (!activeJoinCode) return;
            const requestPacket = {
                type: 'GLOBAL_SHARE_REQUEST',
                shareCode: rawCode,
                peer: buildSelfPeerDescriptor(true),
                msgId: 'G-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
            };
            // Broadcast over share topic + default rooms so sender receives it with 0 delay
            publishSignaling(shareTopic, requestPacket);
            publishSignaling(ipRoomTopic, requestPacket);
            publishSignaling('convoyos/v2/lan/global_default', requestPacket);
        };

        sendReq();
        if (globalRequestRetryTimer) clearInterval(globalRequestRetryTimer);
        let retries = 0;
        globalRequestRetryTimer = setInterval(() => {
            if (!activeJoinCode || retries >= 6) {
                clearInterval(globalRequestRetryTimer);
                return;
            }
            retries++;
            sendReq();
        }, 1600);
    }

    function joinGlobalShareByCode(codeOverride) {
        const input = document.getElementById('globalJoinCodeInput');
        const rawCode = String(codeOverride || input?.value || '').replace(/\D/g, '');
        if (rawCode.length !== 6) {
            window.convoyApp.showToast('Please enter a valid 6-digit Share Code', 'error');
            return;
        }

        activeJoinCode = rawCode;
        if (input) input.value = '';

        window.convoyApp.showToast(`Connecting to Global Share #${rawCode.slice(0, 3)}-${rawCode.slice(3)}...`, 'success');

        // Send immediately (works in <5ms for same-PC browser tabs via BroadcastChannel, and over MQTT if connected)
        dispatchGlobalShareRequestPackets(rawCode);

        if (!wsConnected && navigator.onLine) {
            connectMqttWebSocket();
        }
    }

    // =========================================================================
    // RENDER NEARBY LIST
    // =========================================================================
    function getIconId(type) {
        if (type === 'mobile') return '#icon-mobile';
        if (type === 'desktop') return '#icon-desktop';
        if (type === 'tablet') return '#icon-tablet';
        return '#icon-laptop';
    }

    function renderDeviceList() {
        const container = document.getElementById('deviceList');
        if (!container) return;

        container.innerHTML = '';
        const peersArray = Array.from(livePeers.values());

        if (peersArray.length === 0) {
            container.innerHTML = `
                <div class="empty-radar-state">
                    <div class="empty-radar-icon">
                        <svg class="icon"><use href="#icon-wifi"></use></svg>
                    </div>
                    <div>
                        <h4 style="font-size:13px; font-weight:600; color:#fff">Scanning for Active Devices...</h4>
                        <p style="font-size:12px; color:var(--text-secondary); max-width:260px; margin-top:4px">
                            Open convoyOS on another device on the same Wi-Fi, or use <strong style="color:#60a5fa; cursor:pointer" onclick="window.convoyApp.switchHubTab('pair')">Pair</strong> / <strong style="color:#60a5fa; cursor:pointer" onclick="window.convoyApp.switchHubTab('global')">Global Link</strong>.
                        </p>
                    </div>
                </div>
            `;
            return;
        }

        peersArray.forEach((peer) => {
            const accentHex = peer.paired ? '#a855f7' : '#3b82f6';
            const textHex = peer.paired ? '#c084fc' : '#60a5fa';
            const iconHref = getIconId(peer.type);

            const card = document.createElement('div');
            card.className = 'device-card';
            card.onclick = () => window.convoyTransfer.initiateWebRtcTransfer(peer);

            card.innerHTML = `
                <div class="device-accent-bar" style="background:${accentHex}"></div>
                <div class="device-left">
                    <div class="device-avatar" style="color:${textHex}">
                        <svg class="icon"><use href="${iconHref}"></use></svg>
                    </div>
                    <div>
                        <h4 class="device-name">
                            ${peer.name}
                            ${peer.paired ? '<span class="paired-tag">PAIRED</span>' : ''}
                        </h4>
                        <p class="device-meta">${peer.os} • Live P2P</p>
                    </div>
                </div>
                <div class="device-right">
                    <span class="ready-badge">Online</span>
                    <div class="send-trigger-icon">
                        <svg class="icon" style="font-size:12px"><use href="#icon-send"></use></svg>
                    </div>
                </div>
            `;
            container.appendChild(card);
        });
    }

    function refreshPeers() {
        const icon = document.getElementById('refreshIcon');
        if (icon) icon.classList.add('spin-anim');
        if (!wsConnected && navigator.onLine) {
            connectMqttWebSocket();
        }
        announcePresence(true);
        setTimeout(() => {
            if (icon) icon.classList.remove('spin-anim');
            pruneStalePeers();
            renderDeviceList();
            window.convoyApp.showToast(`Active devices online: ${livePeers.size}`, 'info');
        }, 500);
    }

    // =========================================================================
    // PAIR TAB & OFFLINE HANDSHAKE
    // =========================================================================
    function renderPairTabQR() {
        const s = window.convoyStorage.getSettings();
        const pinEl = document.getElementById('pairPinDisplay');
        if (pinEl) {
            pinEl.textContent = s.pairPin.slice(0, 3) + '-' + s.pairPin.slice(3);
        }
        const pairUrl = `${getShareableBaseUrl()}#pair=${s.pairPin}`;
        window.convoyQR.renderInto('pairQrContainer', pairUrl, '#0c0c0c');
    }

    function connectWithPin(pinOverride) {
        const input = document.getElementById('pairPinInput');
        const rawPin = String(pinOverride || input?.value || '').replace(/\D/g, '');
        if (rawPin.length !== 6) {
            window.convoyApp.showToast('Please enter a valid 6-digit PIN code', 'error');
            return;
        }

        window.convoyStorage.addPairedRoom(rawPin);
        const topic = `convoyos/v2/pin/${rawPin}`;
        subscribeTopic(topic);

        publishSignaling(topic, {
            type: 'PAIR_CONFIRM',
            pin: rawPin,
            peer: buildSelfPeerDescriptor(true)
        });

        announcePresence(true);
        if (input) input.value = '';
        window.convoyApp.switchHubTab('nearby');
        window.convoyApp.showToast(`Joined PIN room ${rawPin}! Discovering peer...`, 'success');
    }

    function checkUrlForIncomingHash() {
        const hash = window.location.hash || '';

        const pairMatch = hash.match(/#pair=(\d{6})/);
        if (pairMatch && pairMatch[1]) {
            const scannedPin = pairMatch[1];
            history.replaceState(null, '', window.location.pathname);
            setTimeout(() => {
                connectWithPin(scannedPin);
            }, 300);
            return;
        }

        const shareMatch = hash.match(/#share=(\d{6})/);
        if (shareMatch && shareMatch[1]) {
            const shareCode = shareMatch[1];
            history.replaceState(null, '', window.location.pathname);
            setTimeout(() => {
                window.convoyApp?.switchHubTab('global');
                joinGlobalShareByCode(shareCode);
            }, 250);
        }
    }

    async function startCameraScanner() {
        const modal = document.getElementById('cameraModal');
        const video = document.getElementById('cameraVideo');
        if (!modal || !video) return;

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            window.convoyApp.showToast('Camera requires HTTPS (GitHub Pages) or localhost', 'error');
            return;
        }

        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' }
            });
            video.srcObject = cameraStream;
            modal.classList.remove('hidden');
            scanLoopActive = true;

            if ('BarcodeDetector' in window) {
                const detector = new BarcodeDetector({ formats: ['qr_code'] });
                const scanFrame = async () => {
                    if (!scanLoopActive) return;
                    try {
                        const codes = await detector.detect(video);
                        if (codes && codes.length > 0) {
                            const rawValue = codes[0].rawValue || '';
                            stopCameraScanner();
                            handleScannedQrValue(rawValue);
                            return;
                        }
                    } catch (_) {}
                    requestAnimationFrame(scanFrame);
                };
                requestAnimationFrame(scanFrame);
            }
        } catch (_) {
            window.convoyApp.showToast('Camera permission denied or unavailable', 'error');
        }
    }

    function stopCameraScanner() {
        scanLoopActive = false;
        if (cameraStream) {
            cameraStream.getTracks().forEach((t) => t.stop());
            cameraStream = null;
        }
        const modal = document.getElementById('cameraModal');
        if (modal) modal.classList.add('hidden');
    }

    function handleScannedQrValue(raw) {
        const shareMatch = raw.match(/share=(\d{6})/);
        if (shareMatch && shareMatch[1]) {
            window.convoyApp.switchHubTab('global');
            joinGlobalShareByCode(shareMatch[1]);
            return;
        }

        const pinMatch = raw.match(/pair=(\d{6})/) || raw.match(/^(\d{6})$/);
        if (pinMatch && pinMatch[1]) {
            connectWithPin(pinMatch[1]);
        } else {
            window.convoyApp.showToast('Scanned QR code! Connecting...', 'success');
        }
    }

    async function openOfflineHandshakeModal() {
        const modal = document.getElementById('offlineModal');
        const tokenInput = document.getElementById('offlineLocalToken');
        if (!modal) return;
        modal.classList.remove('hidden');

        try {
            if (offlinePc) offlinePc.close();
            offlinePc = new RTCPeerConnection({ iceServers: [] });
            const dc = offlinePc.createDataChannel('convoy_offline');
            window.convoyTransfer.attachOfflineDataChannel(offlinePc, dc);

            offlinePc.onicecandidate = (e) => {
                if (!e.candidate && offlinePc.localDescription) {
                    const encoded = btoa(JSON.stringify({
                        type: offlinePc.localDescription.type,
                        sdp: offlinePc.localDescription.sdp
                    }));
                    if (tokenInput) tokenInput.value = encoded;
                    window.convoyQR.renderInto('offlineHandshakeQr', encoded.slice(0, 110), '#0c0c0c');
                }
            };

            const offer = await offlinePc.createOffer();
            await offlinePc.setLocalDescription(offer);
        } catch (_) {}
    }

    function closeOfflineHandshakeModal() {
        const modal = document.getElementById('offlineModal');
        if (modal) modal.classList.add('hidden');
    }

    function copyOfflineToken() {
        const el = document.getElementById('offlineLocalToken');
        if (!el || !el.value) return;
        navigator.clipboard?.writeText(el.value);
        window.convoyApp.showToast('Copied offline WebRTC handshake token!', 'success');
    }

    async function applyOfflineToken() {
        const remoteEl = document.getElementById('offlineRemoteTokenInput');
        const localEl = document.getElementById('offlineLocalToken');
        const stepLabel = document.getElementById('offlineStepLabel');
        const raw = (remoteEl?.value || '').trim();
        if (!raw) return;

        try {
            const desc = JSON.parse(atob(raw));
            if (desc.type === 'offer') {
                if (offlinePc) offlinePc.close();
                offlinePc = new RTCPeerConnection({ iceServers: [] });
                offlinePc.ondatachannel = (e) => {
                    window.convoyTransfer.attachOfflineDataChannel(offlinePc, e.channel);
                };
                offlinePc.onicecandidate = (e) => {
                    if (!e.candidate && offlinePc.localDescription) {
                        const ansToken = btoa(JSON.stringify({
                            type: offlinePc.localDescription.type,
                            sdp: offlinePc.localDescription.sdp
                        }));
                        if (localEl) localEl.value = ansToken;
                        if (stepLabel) {
                            stepLabel.textContent = 'Step 2: Copy this Answer token back to the first device!';
                        }
                        window.convoyApp.showToast('Answer generated! Copy it to the sender.', 'success');
                    }
                };
                await offlinePc.setRemoteDescription(desc);
                const answer = await offlinePc.createAnswer();
                await offlinePc.setLocalDescription(answer);
            } else if (desc.type === 'answer' && offlinePc) {
                await offlinePc.setRemoteDescription(desc);
                closeOfflineHandshakeModal();
                window.convoyApp.showToast('0% Internet Offline LAN Connection Established!', 'success');
            }
            if (remoteEl) remoteEl.value = '';
        } catch (_) {
            window.convoyApp.showToast('Invalid offline handshake token', 'error');
        }
    }

    function registerOfflinePeer(peerObj) {
        livePeers.set(peerObj.id, { ...peerObj, lastSeen: Date.now() + 3600000 });
        renderDeviceList();
        window.convoyApp.switchHubTab('nearby');
    }

    window.convoyDiscovery = {
        init,
        announcePresence,
        refreshPeers,
        renderDeviceList,
        renderPairTabQR,
        renderGlobalShareTab,
        updateGlobalShareBadge,
        regenerateGlobalShareCode,
        copyGlobalShareLink,
        nativeShareGlobalLink,
        joinGlobalShareByCode,
        onFilesStaged,
        connectWithPin,
        startCameraScanner,
        stopCameraScanner,
        sendDirectSignal,
        sendBinaryChunk,
        getBufferedAmount,
        openOfflineHandshakeModal,
        closeOfflineHandshakeModal,
        copyOfflineToken,
        applyOfflineToken,
        registerOfflinePeer
    };
})();