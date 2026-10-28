/**
 * convoyOS v0.0.1 - Real Cross-Device Discovery, WebSocket MQTT Signaling & QR Pairing
 */
(function () {
    const BROKER_URLS = [
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt'
    ];
    const HEARTBEAT_MS = 3500;
    const PEER_TIMEOUT_MS = 10000;

    let brokerIndex = 0;
    let wsClient = null;
    let wsConnected = false;
    let localBroadcast = null;
    let livePeers = new Map(); // peerId -> peerInfo
    const seenMsgIds = new Set();

    let ipRoomTopic = 'convoyos/v2/lan/default';
    let cameraStream = null;
    let scanLoopActive = false;
    let offlinePc = null;

    async function init() {
        // 1. Render scannable Pair QR & 6-Digit PIN
        renderPairTabQR();

        // 2. Check if opened via scanned QR link (#pair=123456)
        checkUrlForPairPin();

        // 3. Same-browser multi-tab discovery
        if ('BroadcastChannel' in window) {
            localBroadcast = new BroadcastChannel('convoyos_local_tabs_v2');
            localBroadcast.onmessage = (e) => handleSignalingPayload(e.data, 'local-tab');
        }

        // 4. Resolve shared IPv4 address so PC & Android on same Wi-Fi join the exact same room
        await resolveSharedIpv4Room();

        // 5. Connect to WebSocket MQTT signaling broker
        connectMqttWebSocket();

        // 6. Periodic heartbeat & dead-peer cleanup
        setInterval(() => {
            announcePresence();
            pruneStalePeers();
        }, HEARTBEAT_MS);

        window.addEventListener('beforeunload', () => {
            sendLeaveSignal();
        });

        renderDeviceList();
    }

    async function resolveSharedIpv4Room() {
        const endpoints = [
            'https://api.ipify.org?format=text',
            'https://ipv4.icanhazip.com',
            'https://1.1.1.1/cdn-cgi/trace'
        ];

        for (const url of endpoints) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 2200);
                const res = await fetch(url, { signal: ctrl.signal });
                clearTimeout(timer);
                const text = (await res.text()).trim();
                const ipMatch = text.includes('ip=') ? text.match(/ip=([^\n\r]+)/)?.[1] : text;
                if (ipMatch) {
                    const cleanIp = ipMatch.trim();
                    let hash = 5381;
                    for (let i = 0; i < cleanIp.length; i++) {
                        hash = (hash * 33) ^ cleanIp.charCodeAt(i);
                    }
                    ipRoomTopic = `convoyos/v2/lan/${(hash >>> 0).toString(16)}`;
                    return;
                }
            } catch (_) {}
        }
    }

    // =========================================================================
    // ZERO-DEPENDENCY MQTT v3.1.1 OVER WEBSOCKETS
    // =========================================================================
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
            0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // 'MQTT'
            0x04,                               // Protocol level 4 (v3.1.1)
            0x02,                               // Clean session
            0x00, 0x3c,                         // Keep-alive 60s
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

    function buildMqttPublishPacket(topic, jsonString) {
        const topicBytes = encodeUtf8Prefixed(topic);
        const payloadBytes = new TextEncoder().encode(jsonString);
        const remLen = topicBytes.length + payloadBytes.length;
        const remBytes = encodeRemainingLength(remLen);
        const pkt = new Uint8Array(1 + remBytes.length + remLen);

        let offset = 0;
        pkt[offset++] = 0x30; // PUBLISH QoS 0
        for (const b of remBytes) pkt[offset++] = b;
        pkt.set(topicBytes, offset);
        offset += topicBytes.length;
        pkt.set(payloadBytes, offset);
        return pkt;
    }

    function connectMqttWebSocket() {
        if (!navigator.onLine) {
            window.convoyApp?.setNetworkBadge(false, 'Offline Mode');
            return;
        }

        const url = BROKER_URLS[brokerIndex % BROKER_URLS.length];
        try {
            wsClient = new WebSocket(url, 'mqtt');
            wsClient.binaryType = 'arraybuffer';

            wsClient.onopen = () => {
                const settings = window.convoyStorage.getSettings();
                const clientId = 'cv_' + settings.nodeId + '_' + Math.floor(1000 + Math.random() * 8999);
                wsClient.send(buildMqttConnectPacket(clientId));
            };

            wsClient.onmessage = (event) => {
                const buf = new Uint8Array(event.data);
                let offset = 0;

                // Loop through all MQTT frames in the WebSocket buffer
                while (offset < buf.length) {
                    const headerByte = buf[offset++];
                    const packetType = headerByte >> 4;

                    let mult = 1;
                    let remLen = 0;
                    let encodedByte;
                    do {
                        if (offset >= buf.length) return;
                        encodedByte = buf[offset++];
                        remLen += (encodedByte & 127) * mult;
                        mult *= 128;
                    } while ((encodedByte & 128) !== 0);

                    const packetEnd = offset + remLen;
                    if (packetEnd > buf.length) break;

                    if (packetType === 2) {
                        // CONNACK
                        wsConnected = true;
                        window.convoyApp?.setNetworkBadge(true, 'Live Ready');
                        subscribeAllRooms();
                        announcePresence();
                    } else if (packetType === 3) {
                        // PUBLISH
                        const topicLen = (buf[offset] << 8) | buf[offset + 1];
                        const topicStr = new TextDecoder().decode(buf.slice(offset + 2, offset + 2 + topicLen));
                        const payloadStart = offset + 2 + topicLen;
                        const payloadBytes = buf.slice(payloadStart, packetEnd);
                        try {
                            const jsonStr = new TextDecoder().decode(payloadBytes);
                            const data = JSON.parse(jsonStr);
                            handleSignalingPayload(data, topicStr);
                        } catch (_) {}
                    }

                    offset = packetEnd;
                }
            };

            wsClient.onclose = () => {
                wsConnected = false;
                brokerIndex++;
                setTimeout(connectMqttWebSocket, 3000);
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
            `convoyos/v2/node/${s.nodeId}`,
            `convoyos/v2/pin/${s.pairPin}`,
            ...window.convoyStorage.getPairedRooms().map((pin) => `convoyos/v2/pin/${pin}`)
        ]);

        let delay = 0;
        topics.forEach((t) => {
            setTimeout(() => subscribeTopic(t), delay);
            delay += 60;
        });
    }

    function publishSignaling(topic, payloadObj) {
        const json = JSON.stringify(payloadObj);
        if (localBroadcast) {
            localBroadcast.postMessage(payloadObj);
        }
        if (wsClient && wsConnected && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(buildMqttPublishPacket(topic, json));
        }
    }

    // =========================================================================
    // LIVE PRESENCE, DIRECT SIGNAL ROUTING & PEER PRUNING
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

    function announcePresence() {
        const s = window.convoyStorage.getSettings();
        publishSignaling(ipRoomTopic, {
            type: 'HEARTBEAT',
            peer: buildSelfPeerDescriptor(false)
        });

        publishSignaling(`convoyos/v2/pin/${s.pairPin}`, {
            type: 'HEARTBEAT',
            peer: buildSelfPeerDescriptor(true)
        });

        window.convoyStorage.getPairedRooms().forEach((pin) => {
            publishSignaling(`convoyos/v2/pin/${pin}`, {
                type: 'HEARTBEAT',
                peer: buildSelfPeerDescriptor(true)
            });
        });

        if (wsClient && wsConnected && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(new Uint8Array([0xc0, 0x00])); // MQTT PINGREQ
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
        const s = window.convoyStorage.getSettings();
        const packet = {
            ...payload,
            targetId: targetNodeId,
            msgId: 'M-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        };

        const targetPeer = livePeers.get(targetNodeId);
        const targetTopics = new Set([
            ipRoomTopic,
            `convoyos/v2/node/${targetNodeId}`,
            `convoyos/v2/pin/${s.pairPin}`
        ]);

        // Route over the exact topic where the peer was discovered + its PIN room
        if (targetPeer) {
            if (targetPeer.originTopic && targetPeer.originTopic !== 'local-tab') {
                targetTopics.add(targetPeer.originTopic);
            }
            if (targetPeer.pin) {
                targetTopics.add(`convoyos/v2/pin/${targetPeer.pin}`);
            }
        }
        window.convoyStorage.getPairedRooms().forEach((pin) => {
            targetTopics.add(`convoyos/v2/pin/${pin}`);
        });

        // For high-frequency WS_CHUNK packets, use the peer's primary verified topic to avoid flooding
        if (payload.ctrl === 'WS_CHUNK' && targetPeer?.originTopic && targetPeer.originTopic !== 'local-tab') {
            publishSignaling(targetPeer.originTopic, packet);
            return;
        }

        targetTopics.forEach((topic) => publishSignaling(topic, packet));
    }

    function handleSignalingPayload(data, sourceTopic) {
        if (!data) return;

        if (data.msgId) {
            if (seenMsgIds.has(data.msgId)) return;
            seenMsgIds.add(data.msgId);
            if (seenMsgIds.size > 500) {
                const oldest = seenMsgIds.values().next().value;
                seenMsgIds.delete(oldest);
            }
        }

        const s = window.convoyStorage.getSettings();

        if (data.type === 'HEARTBEAT' && data.peer && data.peer.id !== s.nodeId) {
            const incoming = data.peer;
            const isNew = !livePeers.has(incoming.id);
            const savedPins = window.convoyStorage.getPairedRooms();
            const isPaired = incoming.paired || savedPins.includes(String(incoming.pin));

            livePeers.set(incoming.id, {
                ...incoming,
                paired: isPaired,
                originTopic: sourceTopic,
                lastSeen: Date.now()
            });

            if (isNew) {
                renderDeviceList();
                sendDirectSignal(incoming.id, {
                    type: 'HEARTBEAT_ACK',
                    peer: buildSelfPeerDescriptor(isPaired)
                });
            }
        } else if (data.type === 'HEARTBEAT_ACK' && data.peer && data.peer.id !== s.nodeId) {
            const incoming = data.peer;
            const isNew = !livePeers.has(incoming.id);
            livePeers.set(incoming.id, {
                ...incoming,
                originTopic: sourceTopic,
                lastSeen: Date.now()
            });
            if (isNew) renderDeviceList();
        } else if (data.type === 'LEAVE' && data.peerId) {
            if (livePeers.delete(data.peerId)) renderDeviceList();
        } else if (data.type === 'PAIR_CONFIRM' && data.peer && data.peer.id !== s.nodeId) {
            window.convoyStorage.addPairedRoom(data.pin);
            livePeers.set(data.peer.id, {
                ...data.peer,
                paired: true,
                originTopic: sourceTopic,
                lastSeen: Date.now()
            });
            renderDeviceList();
            window.convoyApp.switchHubTab('nearby');
            window.convoyApp.showToast(`Paired with ${data.peer.name}!`, 'success');
        } else if (data.type === 'WEBRTC_SIGNAL' && data.targetId === s.nodeId) {
            window.convoyTransfer.handleIncomingWebRtcSignal(data);
        } else if (data.type === 'TRANSFER_CTRL' && data.targetId === s.nodeId) {
            window.convoyTransfer.handleSignalingTransferCtrl(data);
        }
    }

    function pruneStalePeers() {
        const now = Date.now();
        let removedAny = false;
        livePeers.forEach((peer, id) => {
            if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
                livePeers.delete(id);
                removedAny = true;
            }
        });
        if (removedAny) renderDeviceList();
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
                            Open convoyOS on another device on the same Wi-Fi, or use the <strong style="color:#60a5fa; cursor:pointer" onclick="window.convoyApp.switchHubTab('pair')">Pair</strong> tab to connect via QR or PIN.
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
        announcePresence();
        setTimeout(() => {
            if (icon) icon.classList.remove('spin-anim');
            pruneStalePeers();
            renderDeviceList();
            window.convoyApp.showToast(`Active devices online: ${livePeers.size}`, 'info');
        }, 600);
    }

    // =========================================================================
    // PAIR TAB & OFFLINE HANDSHAKE
    // =========================================================================
    function getShareableBaseUrl() {
        const s = window.convoyStorage.getSettings();
        if (s.lanIpOverride && s.lanIpOverride.trim()) {
            const clean = s.lanIpOverride.trim().replace(/^https?:\/\//, '');
            return `http://${clean}${window.location.pathname}`;
        }
        return window.location.origin + window.location.pathname;
    }

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

        announcePresence();
        if (input) input.value = '';
        window.convoyApp.switchHubTab('nearby');
        window.convoyApp.showToast(`Joined PIN room ${rawPin}! Discovering peer...`, 'success');
    }

    function checkUrlForPairPin() {
        const hash = window.location.hash || '';
        const match = hash.match(/#pair=(\d{6})/);
        if (match && match[1]) {
            const scannedPin = match[1];
            history.replaceState(null, '', window.location.pathname);
            setTimeout(() => {
                connectWithPin(scannedPin);
            }, 900);
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
                    const encoded = btoa(JSON.stringify(offlinePc.localDescription));
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
                        const ansToken = btoa(JSON.stringify(offlinePc.localDescription));
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
        refreshPeers,
        renderDeviceList,
        renderPairTabQR,
        connectWithPin,
        startCameraScanner,
        stopCameraScanner,
        sendDirectSignal,
        openOfflineHandshakeModal,
        closeOfflineHandshakeModal,
        copyOfflineToken,
        applyOfflineToken,
        registerOfflinePeer
    };
})();