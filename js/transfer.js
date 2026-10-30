/**
 * convoyOS v0.0.1 - Phase 1 + Phase 2 Multi-Channel Striped WebRTC, Large-File & Instant Text Engine
 */
(function () {
    const WEBRTC_CHUNK_SIZE = 65536;            // 64 KB payload per chunk
    const STRIPE_HEADER_SIZE = 8;               // 4-byte 'CVSP' magic + 4-byte Uint32 seq
    const PARALLEL_STRIPE_COUNT = 4;            // 4 parallel RTCDataChannels per peer
    const MACRO_READ_SIZE = 4194304;            // 4 MB disk prefetch batch
    const WEBRTC_MAX_BUFFER = 4194304;          // 4 MB high-water mark per channel
    const WEBRTC_LOW_BUFFER = 1048576;          // 1 MB low-water refill trigger per channel
    const RAM_COMPACT_THRESHOLD = 33554432;     // Compact RAM chunks into disk-paged Blob every 32 MB
    const ACK_INTERVAL_BYTES = 262144;          // Receiver sends PROGRESS_ACK every 256 KB
    const DEFAULT_DOC_TITLE = document.title || 'convoyOS — Fast Local & P2P File Sharing';

    const MAGIC_B0 = 0x43;
    const MAGIC_B1 = 0x56;
    const MAGIC_B2 = 0x53;
    const MAGIC_B3 = 0x50;

    const ICE_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ]
    };

    let peerConnections = new Map();
    let peerSessionIds = new Map();
    let dataChannels = new Map();
    let stripeChannels = new Map();
    let pendingIceBySession = new Map();
    let signalQueue = Promise.resolve();

    let outgoingState = null;
    let incomingState = null;
    let uiUpdateTimer = null;
    let offerRetryTimer = null;
    let webrtcWatchdogTimer = null;
    let reconnectTimer = null;
    let activeWakeLock = null;
    let lastReceivedTextSnippet = { text: '', fileName: 'clipboard.txt', senderName: 'Peer' };

    function init() {
        window.addEventListener('beforeunload', (e) => {
            if (outgoingState || incomingState) {
                e.preventDefault();
                e.returnValue = 'A file transfer is currently in progress.';
                return e.returnValue;
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && (outgoingState || incomingState)) {
                requestScreenWakeLock();
            }
        });
    }

    function isPeerActive(peerId) {
        const dc = dataChannels.get(peerId);
        if (dc && dc.readyState === 'open') return true;
        if (outgoingState && outgoingState.peer?.id === peerId) return true;
        if (incomingState && incomingState.peer?.id === peerId) return true;
        return false;
    }

    // =========================================================================
    // SAFEGUARDS: WAKE LOCK, DISK SPACE CHECK, HAPTICS & TAB TITLE
    // =========================================================================
    async function requestScreenWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            if (activeWakeLock) return;
            activeWakeLock = await navigator.wakeLock.request('screen');
            activeWakeLock.addEventListener('release', () => {
                activeWakeLock = null;
            });
        } catch (_) {}
    }

    async function releaseScreenWakeLock() {
        if (!activeWakeLock) return;
        try {
            await activeWakeLock.release();
        } catch (_) {}
        activeWakeLock = null;
    }

    function triggerHapticPing(pattern = 40) {
        try {
            if (navigator.vibrate) navigator.vibrate(pattern);
        } catch (_) {}
    }

    function setTabTitleProgress(text) {
        document.title = text ? `${text} • convoyOS` : DEFAULT_DOC_TITLE;
    }

    async function checkAvailableDiskSpace(requiredBytes) {
        if (!navigator.storage || !navigator.storage.estimate) return true;
        try {
            const estimate = await navigator.storage.estimate();
            if (estimate && typeof estimate.quota === 'number' && typeof estimate.usage === 'number') {
                const freeBytes = estimate.quota - estimate.usage;
                if (freeBytes > 0 && requiredBytes > freeBytes) {
                    const freeStr = window.convoyDragDrop.formatBytes(freeBytes);
                    const reqStr = window.convoyDragDrop.formatBytes(requiredBytes);
                    window.convoyApp.showToast(
                        `Warning: Only ${freeStr} browser storage free for ${reqStr} transfer`,
                        'error'
                    );
                    return false;
                }
            }
        } catch (_) {}
        return true;
    }

    function serializeSdp(desc) {
        if (!desc) return null;
        return { type: desc.type, sdp: desc.sdp };
    }

    function serializeCandidate(cand) {
        if (!cand) return null;
        return {
            candidate: cand.candidate,
            sdpMid: cand.sdpMid,
            sdpMLineIndex: cand.sdpMLineIndex,
            usernameFragment: cand.usernameFragment
        };
    }

    // =========================================================================
    // 1. BACKGROUND WEBRTC PRE-WARMING
    // =========================================================================
    function prewarmPeerConnection(peer) {
        if (!peer || !peer.id) return;
        const myId = window.convoyStorage.getSettings().nodeId;
        if (myId < peer.id) {
            const existingDc = dataChannels.get(peer.id);
            const existingPc = peerConnections.get(peer.id);
            if (existingDc && (existingDc.readyState === 'open' || existingDc.readyState === 'connecting')) {
                return;
            }
            if (existingPc && existingPc.connectionState === 'connecting') {
                return;
            }
            startWebRtcConnection(peer);
        }
    }

    // =========================================================================
    // 2. INITIATE BATCH TRANSFER
    // =========================================================================
    async function initiateWebRtcTransfer(peer, resumeOffset = 0) {
        const files = window.convoyDragDrop.getStagedFiles();
        if (files.length === 0) {
            window.convoyApp.showToast('Please select or drop files on the left panel first!', 'error');
            const dropZone = document.getElementById('dropZone');
            if (dropZone) {
                dropZone.classList.add('dropzone-active');
                setTimeout(() => dropZone.classList.remove('dropzone-active'), 1200);
            }
            return;
        }

        clearTimers();
        requestScreenWakeLock();

        const manifest = files.map((f, idx) => ({
            index: idx,
            name: f.relativePath || f.name,
            size: f.size,
            type: f.type || 'application/octet-stream',
            isTextSnippet: Boolean(f.isTextSnippet)
        }));
        const totalBatchBytes = manifest.reduce((sum, item) => sum + item.size, 0);
        const batchTitle = files.length === 1
            ? files[0].name
            : `${files.length} files (${files[0].name} + ${files.length - 1} more)`;

        outgoingState = {
            batchId: 'BATCH-' + Date.now().toString(36).toUpperCase(),
            peer,
            files,
            manifest,
            fileIndex: 0,
            currentFile: files[0],
            fileByteOffset: resumeOffset,
            chunkSeq: Math.floor(resumeOffset / WEBRTC_CHUNK_SIZE),
            completedFilesBytes: 0,
            confirmedBatchBytes: resumeOffset,
            totalBatchBytes,
            startTime: performance.now(),
            firstByteTime: null,
            speedSamples: [],
            paused: false,
            accepted: false,
            pumping: false,
            waitingForNextFileAck: false,
            reconnecting: false,
            prefetchedMacro: null,
            transportLabel: 'WebRTC Direct'
        };

        openTransferModalUI(
            `Waiting for ${peer.name} to accept...`,
            batchTitle,
            resumeOffset,
            totalBatchBytes
        );

        const existingDc = dataChannels.get(peer.id);
        const existingPc = peerConnections.get(peer.id);
        const isHealthy =
            existingDc &&
            (existingDc.readyState === 'open' || existingDc.readyState === 'connecting') &&
            existingPc &&
            existingPc.connectionState !== 'failed' &&
            existingPc.connectionState !== 'closed';

        if (!isHealthy) {
            startWebRtcConnection(peer);
        }

        prefetchNextMacroBlock(files[0], resumeOffset);

        const mySettings = window.convoyStorage.getSettings();
        const offerPacket = {
            type: 'TRANSFER_CTRL',
            ctrl: 'BATCH_OFFER',
            batchId: outgoingState.batchId,
            sender: {
                ...mySettings,
                paired: Boolean(peer.paired)
            },
            manifest,
            totalBatchBytes,
            startByteOffset: resumeOffset
        };

        if (existingDc && existingDc.readyState === 'open') {
            try {
                existingDc.send(JSON.stringify({ dcCtrl: 'BATCH_OFFER_DIRECT', packet: offerPacket }));
            } catch (_) {}
        }
        window.convoyDiscovery.sendDirectSignal(peer.id, offerPacket);

        let retries = 0;
        offerRetryTimer = setInterval(() => {
            if (!outgoingState || outgoingState.accepted || retries >= 4) {
                clearInterval(offerRetryTimer);
                return;
            }
            retries++;
            window.convoyDiscovery.sendDirectSignal(peer.id, offerPacket);
        }, 2000);
    }

    function prefetchNextMacroBlock(file, offset) {
        if (!file || offset >= file.size) return;
        const end = Math.min(file.size, offset + MACRO_READ_SIZE);
        const promise = file.slice(offset, end).arrayBuffer();
        if (outgoingState && outgoingState.currentFile === file) {
            outgoingState.prefetchedMacro = { offset, end, promise };
        }
    }

    // =========================================================================
    // 3. 4-CHANNEL PARALLEL WEBRTC SIGNALING & AUTO-RECONNECT
    // =========================================================================
    async function startWebRtcConnection(peer) {
        try {
            if (peerConnections.has(peer.id)) {
                try { peerConnections.get(peer.id).close(); } catch (_) {}
            }
            stripeChannels.set(peer.id, []);

            const sessionId = 'W-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
            peerSessionIds.set(peer.id, sessionId);
            pendingIceBySession.set(sessionId, []);

            const pc = new RTCPeerConnection(ICE_CONFIG);
            peerConnections.set(peer.id, pc);

            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                    handleMidTransferNetworkBlip(peer);
                }
            };

            let offerDispatched = false;
            const localCandidateBuffer = [];

            pc.onicecandidate = (e) => {
                if (!e.candidate) return;
                const plainCand = serializeCandidate(e.candidate);
                if (!offerDispatched) {
                    localCandidateBuffer.push(plainCand);
                } else {
                    window.convoyDiscovery.sendDirectSignal(peer.id, {
                        type: 'WEBRTC_SIGNAL',
                        sessionId,
                        sender: window.convoyStorage.getSettings(),
                        signal: { type: 'candidate', candidate: plainCand }
                    });
                }
            };

            const primaryDc = pc.createDataChannel('convoy_fast_stream', { ordered: true });
            setupDataChannel(peer, primaryDc, true);

            for (let i = 1; i < PARALLEL_STRIPE_COUNT; i++) {
                const stripeDc = pc.createDataChannel(`convoy_stripe_${i}`, { ordered: true });
                setupDataChannel(peer, stripeDc, false);
            }

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            window.convoyDiscovery.sendDirectSignal(peer.id, {
                type: 'WEBRTC_SIGNAL',
                sessionId,
                sender: window.convoyStorage.getSettings(),
                signal: { type: 'sdp', sdp: serializeSdp(pc.localDescription) }
            });

            offerDispatched = true;
            while (localCandidateBuffer.length > 0) {
                const cand = localCandidateBuffer.shift();
                window.convoyDiscovery.sendDirectSignal(peer.id, {
                    type: 'WEBRTC_SIGNAL',
                    sessionId,
                    sender: window.convoyStorage.getSettings(),
                    signal: { type: 'candidate', candidate: cand }
                });
            }
        } catch (_) {}
    }

    function handleMidTransferNetworkBlip(peer) {
        if (!outgoingState || outgoingState.paused || outgoingState.peer.id !== peer.id) return;
        if (outgoingState.reconnecting) return;

        outgoingState.reconnecting = true;
        outgoingState.pumping = false;
        outgoingState.transportLabel = 'Reconnecting Wi-Fi...';

        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            if (!outgoingState) return;
            startWebRtcConnection(peer);
        }, 900);
    }

    function handleIncomingWebRtcSignal(packet) {
        signalQueue = signalQueue
            .then(() => processWebRtcSignalSerial(packet))
            .catch(() => {});
    }

    async function processWebRtcSignalSerial(packet) {
        const sender = packet.sender;
        const sig = packet.signal;
        const sessionId = packet.sessionId || 'default';
        if (!sender || !sig) return;
        const peerId = sender.nodeId;

        try {
            if (sig.type === 'sdp' && sig.sdp.type === 'offer') {
                if (peerConnections.has(peerId)) {
                    try { peerConnections.get(peerId).close(); } catch (_) {}
                }
                stripeChannels.set(peerId, []);

                peerSessionIds.set(peerId, sessionId);
                if (!pendingIceBySession.has(sessionId)) {
                    pendingIceBySession.set(sessionId, []);
                }

                const pc = new RTCPeerConnection(ICE_CONFIG);
                peerConnections.set(peerId, pc);

                let answerDispatched = false;
                const localAnswerCandidates = [];

                pc.onicecandidate = (e) => {
                    if (!e.candidate) return;
                    const plainCand = serializeCandidate(e.candidate);
                    if (!answerDispatched) {
                        localAnswerCandidates.push(plainCand);
                    } else {
                        window.convoyDiscovery.sendDirectSignal(peerId, {
                            type: 'WEBRTC_SIGNAL',
                            sessionId,
                            sender: window.convoyStorage.getSettings(),
                            signal: { type: 'candidate', candidate: plainCand }
                        });
                    }
                };

                pc.ondatachannel = (e) => {
                    const isPrimary = e.channel.label === 'convoy_fast_stream';
                    setupDataChannel({ id: peerId, name: sender.deviceName }, e.channel, isPrimary);
                };

                await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
                await flushSessionIceQueue(sessionId, pc);

                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                window.convoyDiscovery.sendDirectSignal(peerId, {
                    type: 'WEBRTC_SIGNAL',
                    sessionId,
                    sender: window.convoyStorage.getSettings(),
                    signal: { type: 'sdp', sdp: serializeSdp(pc.localDescription) }
                });

                answerDispatched = true;
                while (localAnswerCandidates.length > 0) {
                    const cand = localAnswerCandidates.shift();
                    window.convoyDiscovery.sendDirectSignal(peerId, {
                        type: 'WEBRTC_SIGNAL',
                        sessionId,
                        sender: window.convoyStorage.getSettings(),
                        signal: { type: 'candidate', candidate: cand }
                    });
                }
            } else if (sig.type === 'sdp' && sig.sdp.type === 'answer') {
                const pc = peerConnections.get(peerId);
                if (pc && pc.signalingState === 'have-local-offer') {
                    await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
                    await flushSessionIceQueue(sessionId, pc);
                }
            } else if (sig.type === 'candidate' && sig.candidate) {
                const pc = peerConnections.get(peerId);
                const activeSession = peerSessionIds.get(peerId);
                if (pc && activeSession === sessionId && pc.remoteDescription && pc.remoteDescription.type) {
                    await pc.addIceCandidate(new RTCIceCandidate(sig.candidate));
                } else {
                    if (!pendingIceBySession.has(sessionId)) {
                        pendingIceBySession.set(sessionId, []);
                    }
                    pendingIceBySession.get(sessionId).push(sig.candidate);
                }
            }
        } catch (_) {}
    }

    async function flushSessionIceQueue(sessionId, pc) {
        const queue = pendingIceBySession.get(sessionId) || [];
        pendingIceBySession.set(sessionId, []);
        for (const cand of queue) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch (_) {}
        }
    }

    function setupDataChannel(peer, dc, isPrimary = true) {
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = WEBRTC_LOW_BUFFER;

        if (isPrimary) {
            dataChannels.set(peer.id, dc);
        }

        dc.onopen = () => {
            if (!stripeChannels.has(peer.id)) {
                stripeChannels.set(peer.id, []);
            }
            const pool = stripeChannels.get(peer.id);
            if (!pool.includes(dc)) {
                pool.push(dc);
            }

            if (isPrimary) {
                if (webrtcWatchdogTimer) clearTimeout(webrtcWatchdogTimer);
                if (outgoingState && outgoingState.peer.id === peer.id && outgoingState.accepted) {
                    if (outgoingState.reconnecting) {
                        outgoingState.reconnecting = false;
                        outgoingState.transportLabel = 'WebRTC Direct';
                        sendBatchControlFrame(peer.id, {
                            dcCtrl: 'REQUEST_RESUME_OFFSET',
                            fileIndex: outgoingState.fileIndex
                        });
                    } else if (!outgoingState.pumping) {
                        outgoingState.transportLabel = 'WebRTC Direct';
                        beginCurrentFileTransfer();
                    }
                }
            } else if (outgoingState && outgoingState.peer.id === peer.id && outgoingState.accepted && !outgoingState.pumping && !outgoingState.waitingForNextFileAck) {
                pumpWebRtcMacroChunks();
            }
        };

        dc.onbufferedamountlow = () => {
            if (outgoingState && !outgoingState.paused && !outgoingState.waitingForNextFileAck) {
                pumpWebRtcMacroChunks();
            }
        };

        dc.onclose = () => {
            const pool = stripeChannels.get(peer.id);
            if (pool) {
                const idx = pool.indexOf(dc);
                if (idx !== -1) pool.splice(idx, 1);
            }
        };

        dc.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    const parsed = JSON.parse(event.data);
                    if (parsed.dcCtrl === 'BATCH_OFFER_DIRECT') {
                        handleSignalingTransferCtrl(parsed.packet);
                    } else {
                        handleBatchControlFrame(parsed);
                    }
                } catch (_) {}
            } else if (event.data instanceof ArrayBuffer) {
                handleIncomingBinaryChunk(event.data);
            }
        };
    }

    function getOpenChannelsForPeer(peerId) {
        const pool = (stripeChannels.get(peerId) || []).filter((c) => c.readyState === 'open');
        if (pool.length > 0) return pool;
        const primary = dataChannels.get(peerId);
        return primary && primary.readyState === 'open' ? [primary] : [];
    }

    function pickLowestBufferedChannel(channels) {
        let best = channels[0];
        let minBuf = best.bufferedAmount;
        for (let i = 1; i < channels.length; i++) {
            const ch = channels[i];
            if (ch.bufferedAmount < minBuf) {
                minBuf = ch.bufferedAmount;
                best = ch;
            }
        }
        return best;
    }

    function getTotalBufferedAmount(peerId) {
        const channels = getOpenChannelsForPeer(peerId);
        let sum = 0;
        for (let i = 0; i < channels.length; i++) {
            sum += channels[i].bufferedAmount || 0;
        }
        return sum;
    }

    function attachOfflineDataChannel(pc, dc) {
        const offlinePeer = {
            id: 'OFFLINE-LAN-NODE',
            name: 'Offline LAN Peer',
            os: 'Direct Wi-Fi WebRTC',
            type: 'laptop',
            paired: true
        };
        peerConnections.set(offlinePeer.id, pc);
        setupDataChannel(offlinePeer, dc, true);
        dc.addEventListener('open', () => {
            window.convoyDiscovery.registerOfflinePeer(offlinePeer);
        });
    }

    // =========================================================================
    // 4. BATCH SIGNALING & PAIRED AUTO-ACCEPT
    // =========================================================================
    function handleSignalingTransferCtrl(msg) {
        const sender = msg.sender || {};
        const peer = { id: sender.nodeId, name: sender.deviceName || 'Peer' };

        if (msg.ctrl === 'BATCH_OFFER') {
            if (incomingState && incomingState.batchId === msg.batchId) return;

            const manifest = msg.manifest || [];
            const firstFile = manifest[0] || { name: 'file', size: 0, type: 'application/octet-stream' };

            incomingState = {
                batchId: msg.batchId,
                peer,
                senderName: peer.name,
                manifest,
                fileIndex: 0,
                currentFileMeta: firstFile,
                currentFileBytes: 0,
                nextExpectedSeq: 0,
                reorderBuffer: new Map(),
                ramChunks: [],
                ramBufferedBytes: 0,
                diskBlobSegments: [],
                receivedBatchBytes: msg.startByteOffset || 0,
                lastAckedBytes: 0,
                totalBatchBytes: msg.totalBatchBytes || firstFile.size,
                startTime: performance.now(),
                firstByteTime: null,
                speedSamples: [],
                transportLabel: 'WebRTC Direct'
            };

            checkAvailableDiskSpace(incomingState.totalBatchBytes);
            triggerHapticPing(40);

            const settings = window.convoyStorage.getSettings();
            const pairedRooms = window.convoyStorage.getPairedRooms();
            const isSenderPaired =
                Boolean(sender.paired) ||
                (sender.pairPin && pairedRooms.includes(String(sender.pairPin)));

            // Auto-accept if user selected 'all', OR 'paired' for a paired device, OR if it's a tiny clipboard text snippet from a paired peer
            const shouldAutoAccept =
                settings.autoAccept === 'all' ||
                (settings.autoAccept === 'paired' && isSenderPaired);

            if (shouldAutoAccept) {
                acceptIncomingTransfer();
            } else {
                setTabTitleProgress('Incoming File!');
                const modal = document.getElementById('incomingModal');
                const senderEl = document.getElementById('incomingSenderName');
                const summaryEl = document.getElementById('incomingFileSummary');
                if (senderEl) senderEl.textContent = `${incomingState.senderName} wants to send:`;
                if (summaryEl) {
                    const sizeFormatted = window.convoyDragDrop.formatBytes(incomingState.totalBatchBytes);
                    if (manifest.length === 1 && firstFile.isTextSnippet) {
                        summaryEl.textContent = `Clipboard Text / Link (${sizeFormatted})`;
                    } else {
                        summaryEl.textContent = manifest.length === 1
                            ? `${firstFile.name} (${sizeFormatted})`
                            : `${manifest.length} files (${sizeFormatted} total) • ${firstFile.name} + ${manifest.length - 1} more`;
                    }
                }
                if (modal) modal.classList.remove('hidden');
            }
        } else if (msg.ctrl === 'BATCH_ACCEPT') {
            if (!outgoingState || outgoingState.accepted) return;
            if (offerRetryTimer) clearInterval(offerRetryTimer);

            outgoingState.accepted = true;
            outgoingState.startTime = performance.now();

            const titleEl = document.getElementById('transferModalTitle');
            if (titleEl) titleEl.textContent = `Sending to ${outgoingState.peer.name}...`;

            startDecoupledUiLoop(true);

            const dc = dataChannels.get(outgoingState.peer.id);
            if (dc && dc.readyState === 'open') {
                outgoingState.transportLabel = 'WebRTC Direct';
                beginCurrentFileTransfer();
            } else {
                webrtcWatchdogTimer = setTimeout(() => {
                    if (!outgoingState) return;
                    const checkDc = dataChannels.get(outgoingState.peer.id);
                    if (!checkDc || checkDc.readyState !== 'open') {
                        startWebRtcConnection(outgoingState.peer);
                    }
                }, 2200);
            }
        } else if (msg.ctrl === 'BATCH_DECLINE') {
            clearTimers();
            outgoingState = null;
            closeTransferModal();
            window.convoyApp.showToast(`${peer.name} declined the file transfer`, 'error');
            window.convoyDiscovery.announcePresence(true);
        } else if (msg.ctrl === 'TRANSFER_CANCEL') {
            clearTimers();
            outgoingState = null;
            incomingState = null;
            document.getElementById('incomingModal')?.classList.add('hidden');
            closeTransferModal();
            window.convoyApp.showToast(`${peer.name} canceled the transfer`, 'info');
            window.convoyDiscovery.announcePresence(true);
        } else if (msg.ctrl === 'BATCH_FRAME') {
            handleBatchControlFrame(msg.frame);
        }
    }

    function sendBatchControlFrame(peerId, frameObj) {
        const dc = dataChannels.get(peerId);
        if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify(frameObj));
        } else {
            window.convoyDiscovery.sendDirectSignal(peerId, {
                type: 'TRANSFER_CTRL',
                ctrl: 'BATCH_FRAME',
                sender: window.convoyStorage.getSettings(),
                frame: frameObj
            });
        }
    }

    function acceptIncomingTransfer() {
        const incModal = document.getElementById('incomingModal');
        if (incModal) incModal.classList.add('hidden');
        if (!incomingState) return;

        requestScreenWakeLock();
        incomingState.startTime = performance.now();

        const totalFiles = incomingState.manifest.length;
        const label = totalFiles > 1
            ? `(1/${totalFiles}) ${incomingState.currentFileMeta.name}`
            : incomingState.currentFileMeta.name;

        openTransferModalUI(
            `Receiving from ${incomingState.senderName}...`,
            label,
            incomingState.receivedBatchBytes,
            incomingState.totalBatchBytes
        );
        startDecoupledUiLoop(false);

        const acceptPacket = {
            type: 'TRANSFER_CTRL',
            ctrl: 'BATCH_ACCEPT',
            batchId: incomingState.batchId,
            sender: window.convoyStorage.getSettings()
        };

        const dc = dataChannels.get(incomingState.peer.id);
        if (dc && dc.readyState === 'open') {
            try {
                dc.send(JSON.stringify({ dcCtrl: 'BATCH_ACCEPT_DIRECT', packet: acceptPacket }));
            } catch (_) {}
        }
        window.convoyDiscovery.sendDirectSignal(incomingState.peer.id, acceptPacket);
    }

    function declineIncomingTransfer() {
        const incModal = document.getElementById('incomingModal');
        if (incModal) incModal.classList.add('hidden');
        setTabTitleProgress(null);
        if (incomingState) {
            window.convoyDiscovery.sendDirectSignal(incomingState.peer.id, {
                type: 'TRANSFER_CTRL',
                ctrl: 'BATCH_DECLINE',
                sender: window.convoyStorage.getSettings()
            });
        }
        incomingState = null;
        window.convoyDiscovery.announcePresence(true);
    }

    // =========================================================================
    // 5. 4-CHANNEL STRIPED STREAMING + 32 MB BLOB COMPACTION + INSTANT TEXT
    // =========================================================================
    function handleBatchControlFrame(frame) {
        if (!frame) return;

        if (frame.dcCtrl === 'BATCH_ACCEPT_DIRECT') {
            handleSignalingTransferCtrl(frame.packet);
            return;
        }

        if (frame.dcCtrl === 'FILE_START') {
            if (!incomingState) return;
            incomingState.fileIndex = frame.fileIndex;
            incomingState.currentFileMeta = {
                name: frame.fileName,
                size: frame.fileSize,
                type: frame.fileType,
                isTextSnippet: Boolean(frame.isTextSnippet)
            };
            incomingState.currentFileBytes = 0;
            incomingState.nextExpectedSeq = 0;
            incomingState.reorderBuffer.clear();
            incomingState.ramChunks = [];
            incomingState.ramBufferedBytes = 0;
            incomingState.diskBlobSegments = [];
            incomingState.transportLabel = 'WebRTC Direct';

            const totalFiles = incomingState.manifest.length;
            const fnEl = document.getElementById('transferFilename');
            if (fnEl) {
                fnEl.textContent = totalFiles > 1
                    ? `(${frame.fileIndex + 1}/${totalFiles}) ${frame.fileName}`
                    : frame.fileName;
            }

            if (frame.fileSize === 0) {
                saveCompletedIncomingFile();
            }
        } else if (frame.dcCtrl === 'REQUEST_RESUME_OFFSET') {
            if (!incomingState) return;
            const safeOffset = incomingState.nextExpectedSeq * WEBRTC_CHUNK_SIZE;
            sendBatchControlFrame(incomingState.peer.id, {
                dcCtrl: 'FILE_RESUME_SYNC',
                fileIndex: incomingState.fileIndex,
                byteOffset: safeOffset,
                seq: incomingState.nextExpectedSeq
            });
        } else if (frame.dcCtrl === 'FILE_RESUME_SYNC') {
            if (!outgoingState) return;
            outgoingState.fileIndex = frame.fileIndex;
            outgoingState.currentFile = outgoingState.files[frame.fileIndex];
            outgoingState.fileByteOffset = frame.byteOffset || 0;
            outgoingState.chunkSeq = frame.seq || Math.floor(outgoingState.fileByteOffset / WEBRTC_CHUNK_SIZE);
            outgoingState.prefetchedMacro = null;
            outgoingState.waitingForNextFileAck = false;
            prefetchNextMacroBlock(outgoingState.currentFile, outgoingState.fileByteOffset);
            pumpWebRtcMacroChunks();
        } else if (frame.dcCtrl === 'PROGRESS_ACK') {
            if (!outgoingState) return;
            outgoingState.confirmedBatchBytes = Math.max(
                outgoingState.confirmedBatchBytes,
                frame.receivedBatchBytes || 0
            );
        } else if (frame.dcCtrl === 'NEXT_FILE_READY') {
            if (!outgoingState) return;
            outgoingState.waitingForNextFileAck = false;
            outgoingState.completedFilesBytes += outgoingState.currentFile.size;
            outgoingState.confirmedBatchBytes = outgoingState.completedFilesBytes;

            if (outgoingState.fileIndex + 1 < outgoingState.files.length) {
                outgoingState.fileIndex++;
                outgoingState.currentFile = outgoingState.files[outgoingState.fileIndex];
                outgoingState.fileByteOffset = 0;
                outgoingState.chunkSeq = 0;
                outgoingState.prefetchedMacro = null;
                prefetchNextMacroBlock(outgoingState.currentFile, 0);
                beginCurrentFileTransfer();
            } else {
                sendBatchControlFrame(outgoingState.peer.id, { dcCtrl: 'BATCH_COMPLETE_ACK' });
                finishOutgoingBatch();
            }
        } else if (frame.dcCtrl === 'BATCH_COMPLETE_ACK') {
            finishIncomingBatch();
        }
    }

    function beginCurrentFileTransfer() {
        if (!outgoingState || outgoingState.paused) return;

        const file = outgoingState.currentFile;
        const totalFiles = outgoingState.files.length;
        const fnEl = document.getElementById('transferFilename');
        if (fnEl) {
            fnEl.textContent = totalFiles > 1
                ? `(${outgoingState.fileIndex + 1}/${totalFiles}) ${file.name}`
                : file.name;
        }

        outgoingState.waitingForNextFileAck = false;
        outgoingState.chunkSeq = Math.floor(outgoingState.fileByteOffset / WEBRTC_CHUNK_SIZE);

        sendBatchControlFrame(outgoingState.peer.id, {
            dcCtrl: 'FILE_START',
            fileIndex: outgoingState.fileIndex,
            fileName: file.relativePath || file.name,
            fileSize: file.size,
            fileType: file.type || 'application/octet-stream',
            isTextSnippet: Boolean(file.isTextSnippet)
        });

        if (file.size === 0) {
            outgoingState.waitingForNextFileAck = true;
            return;
        }

        pumpWebRtcMacroChunks();
    }

    async function pumpWebRtcMacroChunks() {
        if (!outgoingState || outgoingState.paused || outgoingState.pumping || outgoingState.waitingForNextFileAck) {
            return;
        }

        const peerId = outgoingState.peer.id;
        const openChannels = getOpenChannelsForPeer(peerId);
        if (openChannels.length === 0) return;

        outgoingState.pumping = true;
        const file = outgoingState.currentFile;

        try {
            while (
                outgoingState &&
                !outgoingState.paused &&
                outgoingState.currentFile === file &&
                outgoingState.fileByteOffset < file.size
            ) {
                const channels = getOpenChannelsForPeer(peerId);
                if (channels.length === 0) {
                    outgoingState.pumping = false;
                    return;
                }

                const targetDc = pickLowestBufferedChannel(channels);
                if (targetDc.bufferedAmount >= WEBRTC_MAX_BUFFER) {
                    prefetchNextMacroBlock(file, outgoingState.fileByteOffset);
                    outgoingState.pumping = false;
                    return;
                }

                let macroBuffer = null;
                const currentOffset = outgoingState.fileByteOffset;

                if (outgoingState.prefetchedMacro && outgoingState.prefetchedMacro.offset === currentOffset) {
                    const prefetched = outgoingState.prefetchedMacro;
                    outgoingState.prefetchedMacro = null;
                    macroBuffer = await prefetched.promise;
                } else {
                    const macroEnd = Math.min(file.size, currentOffset + MACRO_READ_SIZE);
                    macroBuffer = await file.slice(currentOffset, macroEnd).arrayBuffer();
                }

                if (!outgoingState || outgoingState.paused || outgoingState.currentFile !== file) {
                    break;
                }

                const nextMacroOffset = currentOffset + macroBuffer.byteLength;
                if (nextMacroOffset < file.size) {
                    prefetchNextMacroBlock(file, nextMacroOffset);
                }

                let innerOffset = 0;
                const macroLen = macroBuffer.byteLength;

                while (innerOffset < macroLen) {
                    if (!outgoingState || outgoingState.paused || outgoingState.currentFile !== file) {
                        break;
                    }

                    const activeChannels = getOpenChannelsForPeer(peerId);
                    if (activeChannels.length === 0) {
                        outgoingState.pumping = false;
                        return;
                    }

                    const bestDc = pickLowestBufferedChannel(activeChannels);
                    if (bestDc.bufferedAmount >= WEBRTC_MAX_BUFFER) {
                        outgoingState.pumping = false;
                        return;
                    }

                    if (!outgoingState.firstByteTime) {
                        const now = performance.now();
                        outgoingState.firstByteTime = now;
                        outgoingState.startTime = now;
                        outgoingState.speedSamples = [{ time: now, bytes: outgoingState.completedFilesBytes }];
                    }

                    const chunkLen = Math.min(WEBRTC_CHUNK_SIZE, macroLen - innerOffset);
                    const payloadView = new Uint8Array(macroBuffer, innerOffset, chunkLen);

                    const framedPacket = new Uint8Array(STRIPE_HEADER_SIZE + chunkLen);
                    framedPacket[0] = MAGIC_B0;
                    framedPacket[1] = MAGIC_B1;
                    framedPacket[2] = MAGIC_B2;
                    framedPacket[3] = MAGIC_B3;

                    const seq = outgoingState.chunkSeq++;
                    framedPacket[4] = seq & 0xff;
                    framedPacket[5] = (seq >>> 8) & 0xff;
                    framedPacket[6] = (seq >>> 16) & 0xff;
                    framedPacket[7] = (seq >>> 24) & 0xff;
                    framedPacket.set(payloadView, STRIPE_HEADER_SIZE);

                    bestDc.send(framedPacket);

                    innerOffset += chunkLen;
                    outgoingState.fileByteOffset += chunkLen;
                }
            }

            if (outgoingState && outgoingState.currentFile === file && outgoingState.fileByteOffset >= file.size) {
                outgoingState.waitingForNextFileAck = true;
            }
        } catch (_) {}

        if (outgoingState) outgoingState.pumping = false;
    }

    function handleIncomingRawBinaryPacket(arrayBuffer) {
        handleIncomingBinaryChunk(arrayBuffer);
    }

    function handleIncomingBinaryChunk(arrayBuffer) {
        if (!incomingState || !arrayBuffer) return;

        if (!incomingState.firstByteTime) {
            const now = performance.now();
            incomingState.firstByteTime = now;
            incomingState.startTime = now;
            incomingState.speedSamples = [{ time: now, bytes: incomingState.receivedBatchBytes }];
        }

        const u8 = new Uint8Array(arrayBuffer);
        const isStripedFrame =
            u8.byteLength > STRIPE_HEADER_SIZE &&
            u8[0] === MAGIC_B0 &&
            u8[1] === MAGIC_B1 &&
            u8[2] === MAGIC_B2 &&
            u8[3] === MAGIC_B3;

        if (isStripedFrame) {
            const seq = (u8[4]) | (u8[5] << 8) | (u8[6] << 16) | ((u8[7] << 24) >>> 0);
            const payloadView = new Uint8Array(arrayBuffer, STRIPE_HEADER_SIZE);

            if (seq === incomingState.nextExpectedSeq) {
                appendOrderedPayloadChunk(payloadView);
                incomingState.nextExpectedSeq++;

                while (incomingState.reorderBuffer.has(incomingState.nextExpectedSeq)) {
                    const bufferedView = incomingState.reorderBuffer.get(incomingState.nextExpectedSeq);
                    incomingState.reorderBuffer.delete(incomingState.nextExpectedSeq);
                    appendOrderedPayloadChunk(bufferedView);
                    incomingState.nextExpectedSeq++;
                }
            } else if (seq > incomingState.nextExpectedSeq) {
                incomingState.reorderBuffer.set(seq, payloadView);
            }
        } else {
            appendOrderedPayloadChunk(u8);
            incomingState.nextExpectedSeq++;
        }

        if (incomingState.receivedBatchBytes - incomingState.lastAckedBytes >= ACK_INTERVAL_BYTES) {
            incomingState.lastAckedBytes = incomingState.receivedBatchBytes;
            sendBatchControlFrame(incomingState.peer.id, {
                dcCtrl: 'PROGRESS_ACK',
                receivedBatchBytes: incomingState.receivedBatchBytes
            });
        }

        if (incomingState && incomingState.currentFileBytes >= incomingState.currentFileMeta.size) {
            saveCompletedIncomingFile();
        }
    }

    function appendOrderedPayloadChunk(uint8Chunk) {
        incomingState.ramChunks.push(uint8Chunk);
        incomingState.ramBufferedBytes += uint8Chunk.byteLength;
        incomingState.currentFileBytes += uint8Chunk.byteLength;
        incomingState.receivedBatchBytes += uint8Chunk.byteLength;

        if (incomingState.ramBufferedBytes >= RAM_COMPACT_THRESHOLD) {
            const segmentBlob = new Blob(incomingState.ramChunks);
            incomingState.diskBlobSegments.push(segmentBlob);
            incomingState.ramChunks = [];
            incomingState.ramBufferedBytes = 0;
        }
    }

    async function saveCompletedIncomingFile() {
        if (!incomingState) return;

        const meta = incomingState.currentFileMeta;
        const senderName = incomingState.senderName;
        const peerId = incomingState.peer.id;
        const allParts = [...incomingState.diskBlobSegments, ...incomingState.ramChunks];
        const blob = new Blob(allParts, {
            type: meta.type || 'application/octet-stream'
        });

        // Clear memory immediately
        incomingState.ramChunks = [];
        incomingState.diskBlobSegments = [];
        incomingState.reorderBuffer.clear();
        incomingState.ramBufferedBytes = 0;

        const isClipboardSnippet =
            Boolean(meta.isTextSnippet) ||
            (meta.name.startsWith('clipboard_') && meta.name.endsWith('.txt') && meta.size <= 524288);

        if (isClipboardSnippet) {
            try {
                const textContent = await blob.text();
                lastReceivedTextSnippet = {
                    text: textContent,
                    fileName: meta.name || 'clipboard.txt',
                    senderName
                };
                setTimeout(() => showIncomingTextSnippetModal(lastReceivedTextSnippet), 220);
            } catch (_) {}
        } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = meta.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 15000);
        }

        sendBatchControlFrame(peerId, {
            dcCtrl: 'PROGRESS_ACK',
            receivedBatchBytes: incomingState.receivedBatchBytes
        });

        setTimeout(() => {
            if (incomingState) {
                sendBatchControlFrame(peerId, { dcCtrl: 'NEXT_FILE_READY' });
            }
        }, 200);
    }

    // =========================================================================
    // INSTANT RECEIVED TEXT / LINK POPUP HANDLERS
    // =========================================================================
    function showIncomingTextSnippetModal(snippetObj) {
        closeTransferModal();
        const modal = document.getElementById('incomingTextModal');
        const titleEl = document.getElementById('incomingTextModalTitle');
        const contentEl = document.getElementById('incomingTextContent');
        const openUrlBtn = document.getElementById('incomingTextOpenUrlBtn');

        if (!modal || !contentEl) return;
        if (titleEl) titleEl.textContent = `Text from ${snippetObj.senderName}`;
        contentEl.value = snippetObj.text;

        const trimmed = (snippetObj.text || '').trim();
        const isUrl = /^https?:\/\/[^\s]+$/i.test(trimmed);
        if (openUrlBtn) {
            openUrlBtn.classList.toggle('hidden', !isUrl);
        }
        modal.classList.remove('hidden');
    }

    function closeIncomingTextModal() {
        const modal = document.getElementById('incomingTextModal');
        if (modal) modal.classList.add('hidden');
    }

    function copyReceivedText() {
        const text = lastReceivedTextSnippet.text || '';
        if (!text) return;
        navigator.clipboard?.writeText(text);
        window.convoyApp.showToast('Copied text to clipboard!', 'success');
    }

    function openReceivedTextUrl() {
        const url = (lastReceivedTextSnippet.text || '').trim();
        if (/^https?:\/\//i.test(url)) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }

    function saveReceivedTextAsFile() {
        const blob = new Blob([lastReceivedTextSnippet.text || ''], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = lastReceivedTextSnippet.fileName || 'clipboard.txt';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        closeIncomingTextModal();
    }

    // =========================================================================
    // 6. FIRST-BYTE ACCURATE SPEED METER & LOCKSTEP PROGRESS BAR
    // =========================================================================
    function computeRollingSpeedMBps(state, currentBytes) {
        if (!state.firstByteTime) return '0.00';

        const now = performance.now();
        if (!state.speedSamples || state.speedSamples.length === 0) {
            state.speedSamples = [{ time: state.firstByteTime, bytes: 0 }];
        }
        state.speedSamples.push({ time: now, bytes: currentBytes });

        while (state.speedSamples.length > 2 && now - state.speedSamples[0].time > 1400) {
            state.speedSamples.shift();
        }

        const oldest = state.speedSamples[0];
        const deltaSec = Math.max(0.08, (now - oldest.time) / 1000);
        const deltaBytes = Math.max(0, currentBytes - oldest.bytes);
        return ((deltaBytes / (1024 * 1024)) / deltaSec).toFixed(2);
    }

    function startDecoupledUiLoop(isSending) {
        if (uiUpdateTimer) clearInterval(uiUpdateTimer);
        uiUpdateTimer = setInterval(() => {
            const state = isSending ? outgoingState : incomingState;
            if (!state) return;

            const totalBytes = state.totalBatchBytes;
            let doneBytes = 0;

            if (isSending) {
                const buffered = getTotalBufferedAmount(state.peer.id);
                const wireDrained = Math.max(0, state.completedFilesBytes + state.fileByteOffset - buffered);
                doneBytes = Math.max(state.confirmedBatchBytes, wireDrained);
                doneBytes = Math.min(totalBytes * 0.99, doneBytes);
            } else {
                doneBytes = state.receivedBatchBytes;
            }

            const pct = totalBytes > 0 ? Math.min(99, Math.round((doneBytes / totalBytes) * 100)) : 99;
            const mbPerSec = computeRollingSpeedMBps(state, doneBytes);

            const totalChunks = Math.max(1, Math.ceil(totalBytes / WEBRTC_CHUNK_SIZE));
            const currentChunk = Math.min(totalChunks, Math.ceil(doneBytes / WEBRTC_CHUNK_SIZE));
            const channelCount = isSending ? getOpenChannelsForPeer(state.peer.id).length : PARALLEL_STRIPE_COUNT;
            const label = state.reconnecting
                ? 'Reconnecting Wi-Fi...'
                : `${mbPerSec} MB/s • ${channelCount > 1 ? `${channelCount}x ` : ''}WebRTC Direct`;

            setTabTitleProgress(`${pct}% • ${mbPerSec} MB/s`);
            updateModalMetrics(pct, currentChunk, totalChunks, doneBytes, totalBytes, label);
        }, 100);
    }

    async function finishOutgoingBatch() {
        clearTimers();
        releaseScreenWakeLock();
        setTabTitleProgress(null);
        if (!outgoingState) return;

        const totalBytes = outgoingState.totalBatchBytes;
        const totalChunks = Math.max(1, Math.ceil(totalBytes / WEBRTC_CHUNK_SIZE));
        const activeStart = outgoingState.firstByteTime || outgoingState.startTime;
        const elapsedSec = Math.max(0.08, (performance.now() - activeStart) / 1000);
        const avgSpeed = ((totalBytes / (1024 * 1024)) / elapsedSec).toFixed(2);

        updateModalMetrics(100, totalChunks, totalChunks, totalBytes, totalBytes, `${avgSpeed} MB/s • 100% Complete`);
        markTransferModalComplete(`Delivered ${outgoingState.files.length} item(s) to ${outgoingState.peer.name}`);
        triggerHapticPing([35, 50, 35]);
        window.convoyApp.showToast(`Sent ${outgoingState.files.length} item(s) to ${outgoingState.peer.name}!`, 'success');

        outgoingState = null;
        window.convoyDiscovery.announcePresence(true);
    }

    function finishIncomingBatch() {
        clearTimers();
        releaseScreenWakeLock();
        setTabTitleProgress(null);
        if (!incomingState) return;

        const totalBytes = incomingState.totalBatchBytes;
        const totalChunks = Math.max(1, Math.ceil(totalBytes / WEBRTC_CHUNK_SIZE));
        const activeStart = incomingState.firstByteTime || incomingState.startTime;
        const elapsedSec = Math.max(0.08, (performance.now() - activeStart) / 1000);
        const avgSpeed = ((totalBytes / (1024 * 1024)) / elapsedSec).toFixed(2);

        updateModalMetrics(100, totalChunks, totalChunks, totalBytes, totalBytes, `${avgSpeed} MB/s • 100% Complete`);
        markTransferModalComplete(`Received ${incomingState.manifest.length} item(s)`);
        triggerHapticPing([35, 50, 35]);
        window.convoyApp.showToast(`Received ${incomingState.manifest.length} item(s)!`, 'success');

        incomingState = null;
        window.convoyDiscovery.announcePresence(true);
    }

    async function togglePauseTransfer() {
        if (!outgoingState) return;
        const pauseBtn = document.getElementById('pauseResumeBtn');
        const speedEl = document.getElementById('transferSpeed');

        if (!outgoingState.paused) {
            outgoingState.paused = true;
            outgoingState.pumping = false;
            await window.convoyStorage.saveCheckpoint({
                id: outgoingState.batchId,
                fileName: outgoingState.currentFile.name,
                deviceName: outgoingState.peer.name,
                peer: outgoingState.peer,
                byteOffset: outgoingState.fileByteOffset,
                totalBytes: outgoingState.totalBatchBytes
            });
            if (pauseBtn) pauseBtn.textContent = 'Resume';
            if (speedEl) speedEl.textContent = 'Paused — Checkpoint saved';
        } else {
            outgoingState.paused = false;
            if (pauseBtn) pauseBtn.textContent = 'Pause';
            pumpWebRtcMacroChunks();
        }
    }

    async function resumeFromLedger(checkpointId) {
        const list = await window.convoyStorage.getCheckpoints();
        const item = list.find((c) => c.id === checkpointId);
        if (!item) return;
        initiateWebRtcTransfer(item.peer, item.byteOffset);
    }

    function openTransferModalUI(titleText, fileName, doneBytes, totalBytes) {
        const modal = document.getElementById('transferModal');
        const titleEl = document.getElementById('transferModalTitle');
        const fnEl = document.getElementById('transferFilename');
        const doneBtn = document.getElementById('transferDoneBtn');
        const pauseBtn = document.getElementById('pauseResumeBtn');
        const iconUse = document.getElementById('transferStatusIconUse');

        if (!modal) return;
        modal.classList.remove('hidden');
        if (titleEl) titleEl.textContent = titleText;
        if (fnEl) fnEl.textContent = fileName;
        if (iconUse) iconUse.setAttribute('href', '#icon-cloud-up');
        if (doneBtn) doneBtn.classList.add('hidden');
        if (pauseBtn) {
            pauseBtn.classList.remove('hidden');
            pauseBtn.textContent = 'Pause';
        }

        const totalChunks = Math.max(1, Math.ceil(totalBytes / WEBRTC_CHUNK_SIZE));
        const curChunk = Math.ceil(doneBytes / WEBRTC_CHUNK_SIZE);
        const pct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0;
        updateModalMetrics(pct, curChunk, totalChunks, doneBytes, totalBytes, 'Waiting for receiver...');
    }

    function updateModalMetrics(pct, curChunk, totalChunks, doneBytes, totalBytes, speedLabel) {
        const pctEl = document.getElementById('transferPercent');
        const chunkEl = document.getElementById('transferChunkCounter');
        const sizeEl = document.getElementById('transferSize');
        const barEl = document.getElementById('transferProgressBar');
        const speedEl = document.getElementById('transferSpeed');

        if (pctEl) pctEl.textContent = `${pct}%`;
        if (chunkEl) chunkEl.textContent = `${curChunk} / ${totalChunks} Chunks`;
        if (sizeEl) {
            sizeEl.textContent = `${window.convoyDragDrop.formatBytes(doneBytes)} / ${window.convoyDragDrop.formatBytes(totalBytes)}`;
        }
        if (barEl) barEl.style.width = `${pct}%`;
        if (speedEl) speedEl.textContent = speedLabel;
    }

    function markTransferModalComplete(titleText) {
        const titleEl = document.getElementById('transferModalTitle');
        const barEl = document.getElementById('transferProgressBar');
        const pctEl = document.getElementById('transferPercent');
        const doneBtn = document.getElementById('transferDoneBtn');
        const pauseBtn = document.getElementById('pauseResumeBtn');
        const iconUse = document.getElementById('transferStatusIconUse');

        if (titleEl) titleEl.textContent = titleText;
        if (barEl) barEl.style.width = '100%';
        if (pctEl) pctEl.textContent = '100%';
        if (iconUse) iconUse.setAttribute('href', '#icon-check');
        if (doneBtn) doneBtn.classList.remove('hidden');
        if (pauseBtn) pauseBtn.classList.add('hidden');
    }

    function clearTimers() {
        if (uiUpdateTimer) clearInterval(uiUpdateTimer);
        if (offerRetryTimer) clearInterval(offerRetryTimer);
        if (webrtcWatchdogTimer) clearTimeout(webrtcWatchdogTimer);
        if (reconnectTimer) clearTimeout(reconnectTimer);
    }

    function closeTransferModal() {
        clearTimers();
        releaseScreenWakeLock();
        setTabTitleProgress(null);
        const modal = document.getElementById('transferModal');
        if (modal) modal.classList.add('hidden');
        window.convoyDiscovery.announcePresence(true);
    }

    function cancelTransfer() {
        clearTimers();
        releaseScreenWakeLock();
        setTabTitleProgress(null);

        const targetPeerId = outgoingState?.peer?.id || incomingState?.peer?.id;
        if (targetPeerId) {
            window.convoyDiscovery.sendDirectSignal(targetPeerId, {
                type: 'TRANSFER_CTRL',
                ctrl: 'TRANSFER_CANCEL',
                sender: window.convoyStorage.getSettings()
            });
        }

        outgoingState = null;
        incomingState = null;
        closeTransferModal();
        window.convoyApp.showToast('Transfer canceled', 'info');
    }

    window.convoyTransfer = {
        init,
        isPeerActive,
        prewarmPeerConnection,
        initiateWebRtcTransfer,
        handleIncomingWebRtcSignal,
        handleSignalingTransferCtrl,
        handleIncomingRawBinaryPacket,
        attachOfflineDataChannel,
        acceptIncomingTransfer,
        declineIncomingTransfer,
        togglePauseTransfer,
        resumeFromLedger,
        closeTransferModal,
        cancelTransfer,
        closeIncomingTextModal,
        copyReceivedText,
        openReceivedTextUrl,
        saveReceivedTextAsFile
    };
})();