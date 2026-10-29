/**
 * convoyOS v0.0.1 - High-Speed Direct WebRTC Batch Streaming Engine
 * Fixes:
 * 1. Serializes RTCSessionDescription & RTCIceCandidate to plain JSON (fixes DataCloneError)
 * 2. Background WebRTC Pre-Warming on peer discovery (DataChannel is open BEFORE clicking Send)
 * 3. Zero-copy Uint8Array chunk views + 4 MB background disk prefetching (20-100+ MB/s on LAN)
 * 4. Kernel SCTP buffer + receiver PROGRESS_ACK lockstep progress bar synchronization
 */
(function () {
    const WEBRTC_CHUNK_SIZE = 65536;        // 64 KB WebRTC SCTP binary chunk
    const MACRO_READ_SIZE = 4194304;        // 4 MB disk read batch for zero I/O starvation
    const WEBRTC_MAX_BUFFER = 8388608;      // 8 MB WebRTC high-water mark for high-bandwidth Wi-Fi
    const WEBRTC_LOW_BUFFER = 2097152;      // 2 MB WebRTC low-water refill trigger
    const ACK_INTERVAL_BYTES = 262144;      // Receiver sends PROGRESS_ACK every 256 KB

    const ICE_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ]
    };

    let peerConnections = new Map();        // peerId -> RTCPeerConnection
    let peerSessionIds = new Map();         // peerId -> sessionId
    let dataChannels = new Map();           // peerId -> RTCDataChannel
    let pendingIceBySession = new Map();    // sessionId -> plain candidate objects[]
    let signalQueue = Promise.resolve();    // Serializes async WebRTC SDP/ICE operations

    let outgoingState = null;
    let incomingState = null;
    let uiUpdateTimer = null;
    let offerRetryTimer = null;
    let webrtcWatchdogTimer = null;

    function init() {}

    function isPeerActive(peerId) {
        const dc = dataChannels.get(peerId);
        if (dc && dc.readyState === 'open') return true;
        if (outgoingState && outgoingState.peer?.id === peerId) return true;
        if (incomingState && incomingState.peer?.id === peerId) return true;
        return false;
    }

    // Plain JSON serializers so BroadcastChannel/WebSocket never throw DataCloneError
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
    // 1. BACKGROUND WEBRTC PRE-WARMING (Opens DataChannel Before User Clicks)
    // =========================================================================
    function prewarmPeerConnection(peer) {
        if (!peer || !peer.id) return;
        const myId = window.convoyStorage.getSettings().nodeId;
        // Deterministic initiator: node with lexicographically smaller ID initiates background offer
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

        const manifest = files.map((f, idx) => ({
            index: idx,
            name: f.relativePath || f.name,
            size: f.size,
            type: f.type || 'application/octet-stream'
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
            completedFilesBytes: 0,
            confirmedBatchBytes: resumeOffset,
            totalBatchBytes,
            startTime: performance.now(),
            speedSamples: [{ time: performance.now(), bytes: resumeOffset }],
            paused: false,
            accepted: false,
            pumping: false,
            waitingForNextFileAck: false,
            prefetchedMacro: null,
            transportLabel: 'WebRTC Direct'
        };

        openTransferModalUI(
            `Waiting for ${peer.name} to accept...`,
            batchTitle,
            resumeOffset,
            totalBatchBytes
        );

        // Ensure WebRTC connection is open or connecting right now
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

        // Prefetch the first 4 MB block into RAM while waiting for user to tap Accept
        prefetchNextMacroBlock(files[0], resumeOffset);

        const offerPacket = {
            type: 'TRANSFER_CTRL',
            ctrl: 'BATCH_OFFER',
            batchId: outgoingState.batchId,
            sender: window.convoyStorage.getSettings(),
            manifest,
            totalBatchBytes,
            startByteOffset: resumeOffset
        };

        // If DataChannel is already open, send BATCH_OFFER directly over WebRTC + signaling
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
    // 3. STRICTLY ORDERED WEBRTC SIGNALING (Plain JSON, Zero DataCloneError)
    // =========================================================================
    async function startWebRtcConnection(peer) {
        try {
            if (peerConnections.has(peer.id)) {
                try { peerConnections.get(peer.id).close(); } catch (_) {}
            }

            const sessionId = 'W-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
            peerSessionIds.set(peer.id, sessionId);
            pendingIceBySession.set(sessionId, []);

            const pc = new RTCPeerConnection(ICE_CONFIG);
            peerConnections.set(peer.id, pc);

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

            const dc = pc.createDataChannel('convoy_fast_stream', { ordered: true });
            setupDataChannel(peer, dc);

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            // 1. Send plain-JSON SDP Offer FIRST
            window.convoyDiscovery.sendDirectSignal(peer.id, {
                type: 'WEBRTC_SIGNAL',
                sessionId,
                sender: window.convoyStorage.getSettings(),
                signal: { type: 'sdp', sdp: serializeSdp(pc.localDescription) }
            });

            // 2. Flush any local LAN candidates gathered during setLocalDescription
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
                    setupDataChannel({ id: peerId, name: sender.deviceName }, e.channel);
                };

                await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
                await flushSessionIceQueue(sessionId, pc);

                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                // 1. Send plain-JSON SDP Answer FIRST
                window.convoyDiscovery.sendDirectSignal(peerId, {
                    type: 'WEBRTC_SIGNAL',
                    sessionId,
                    sender: window.convoyStorage.getSettings(),
                    signal: { type: 'sdp', sdp: serializeSdp(pc.localDescription) }
                });

                // 2. Flush local LAN candidates gathered during setLocalDescription(answer)
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

    function setupDataChannel(peer, dc) {
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = WEBRTC_LOW_BUFFER;
        dataChannels.set(peer.id, dc);

        dc.onopen = () => {
            if (webrtcWatchdogTimer) clearTimeout(webrtcWatchdogTimer);
            if (outgoingState && outgoingState.peer.id === peer.id && outgoingState.accepted && !outgoingState.pumping) {
                outgoingState.transportLabel = 'WebRTC Direct';
                outgoingState.startTime = performance.now();
                outgoingState.speedSamples = [{ time: performance.now(), bytes: outgoingState.confirmedBatchBytes }];
                beginCurrentFileTransfer();
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

    function attachOfflineDataChannel(pc, dc) {
        const offlinePeer = {
            id: 'OFFLINE-LAN-NODE',
            name: 'Offline LAN Peer',
            os: 'Direct Wi-Fi WebRTC',
            type: 'laptop',
            paired: true
        };
        peerConnections.set(offlinePeer.id, pc);
        setupDataChannel(offlinePeer, dc);
        dc.addEventListener('open', () => {
            window.convoyDiscovery.registerOfflinePeer(offlinePeer);
        });
    }

    // =========================================================================
    // 4. BATCH SIGNALING & DIRECT WEBRTC EXECUTION
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
                currentFileChunks: [],
                receivedBatchBytes: msg.startByteOffset || 0,
                lastAckedBytes: 0,
                totalBatchBytes: msg.totalBatchBytes || firstFile.size,
                startTime: performance.now(),
                speedSamples: [{ time: performance.now(), bytes: msg.startByteOffset || 0 }],
                transportLabel: 'WebRTC Direct'
            };

            const settings = window.convoyStorage.getSettings();
            if (settings.autoAccept === 'all') {
                acceptIncomingTransfer();
            } else {
                const modal = document.getElementById('incomingModal');
                const senderEl = document.getElementById('incomingSenderName');
                const summaryEl = document.getElementById('incomingFileSummary');
                if (senderEl) senderEl.textContent = `${incomingState.senderName} wants to send:`;
                if (summaryEl) {
                    const sizeFormatted = window.convoyDragDrop.formatBytes(incomingState.totalBatchBytes);
                    summaryEl.textContent = manifest.length === 1
                        ? `${firstFile.name} (${sizeFormatted})`
                        : `${manifest.length} files (${sizeFormatted} total) • ${firstFile.name} + ${manifest.length - 1} more`;
                }
                if (modal) modal.classList.remove('hidden');
            }
        } else if (msg.ctrl === 'BATCH_ACCEPT') {
            if (!outgoingState || outgoingState.accepted) return;
            if (offerRetryTimer) clearInterval(offerRetryTimer);

            outgoingState.accepted = true;
            outgoingState.startTime = performance.now();
            outgoingState.speedSamples = [{ time: performance.now(), bytes: outgoingState.confirmedBatchBytes }];

            const titleEl = document.getElementById('transferModalTitle');
            if (titleEl) titleEl.textContent = `Sending to ${outgoingState.peer.name}...`;

            startDecoupledUiLoop(true);

            const dc = dataChannels.get(outgoingState.peer.id);
            if (dc && dc.readyState === 'open') {
                outgoingState.transportLabel = 'WebRTC Direct';
                beginCurrentFileTransfer();
            } else {
                // If WebRTC is still shaking hands, re-trigger connection if needed when watchdog fires
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

        incomingState.startTime = performance.now();
        incomingState.speedSamples = [{ time: performance.now(), bytes: incomingState.receivedBatchBytes }];

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
    // 5. ZERO-COPY WEBRTC STREAMING WITH 4 MB DISK PREFETCHING
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
                type: frame.fileType
            };
            incomingState.currentFileBytes = 0;
            incomingState.currentFileChunks = [];
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

        sendBatchControlFrame(outgoingState.peer.id, {
            dcCtrl: 'FILE_START',
            fileIndex: outgoingState.fileIndex,
            fileName: file.relativePath || file.name,
            fileSize: file.size,
            fileType: file.type || 'application/octet-stream'
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
        const dc = dataChannels.get(peerId);
        if (!dc || dc.readyState !== 'open') return;

        outgoingState.pumping = true;
        const file = outgoingState.currentFile;

        dc.onbufferedamountlow = () => {
            if (outgoingState && !outgoingState.paused && !outgoingState.waitingForNextFileAck) {
                pumpWebRtcMacroChunks();
            }
        };

        try {
            while (
                outgoingState &&
                !outgoingState.paused &&
                outgoingState.currentFile === file &&
                outgoingState.fileByteOffset < file.size
            ) {
                if (dc.bufferedAmount >= WEBRTC_MAX_BUFFER) {
                    // Prefetch next 4 MB from disk while waiting for Wi-Fi buffer to drain
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

                // Kick off background disk prefetch for the FOLLOWING 4 MB block immediately
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

                    const chunkLen = Math.min(WEBRTC_CHUNK_SIZE, macroLen - innerOffset);
                    // Zero-copy Uint8Array view into macroBuffer (0 memory allocation overhead)
                    const chunkView = new Uint8Array(macroBuffer, innerOffset, chunkLen);
                    dc.send(chunkView);

                    innerOffset += chunkLen;
                    outgoingState.fileByteOffset += chunkLen;

                    if (dc.bufferedAmount >= WEBRTC_MAX_BUFFER && outgoingState.fileByteOffset < file.size) {
                        outgoingState.pumping = false;
                        return; // dc.onbufferedamountlow resumes automatically
                    }
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

        incomingState.currentFileChunks.push(arrayBuffer);
        incomingState.currentFileBytes += arrayBuffer.byteLength;
        incomingState.receivedBatchBytes += arrayBuffer.byteLength;

        if (incomingState.receivedBatchBytes - incomingState.lastAckedBytes >= ACK_INTERVAL_BYTES) {
            incomingState.lastAckedBytes = incomingState.receivedBatchBytes;
            sendBatchControlFrame(incomingState.peer.id, {
                dcCtrl: 'PROGRESS_ACK',
                receivedBatchBytes: incomingState.receivedBatchBytes
            });
        }

        if (incomingState.currentFileBytes >= incomingState.currentFileMeta.size) {
            saveCompletedIncomingFile();
        }
    }

    function saveCompletedIncomingFile() {
        if (!incomingState) return;

        const blob = new Blob(incomingState.currentFileChunks, {
            type: incomingState.currentFileMeta.type
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = incomingState.currentFileMeta.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);

        incomingState.currentFileChunks = [];
        const peerId = incomingState.peer.id;

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
    // 6. ROLLING LIVE SPEED METER & LOCKSTEP PROGRESS BAR
    // =========================================================================
    function computeRollingSpeedMBps(state, currentBytes) {
        const now = performance.now();
        if (!state.speedSamples) {
            state.speedSamples = [{ time: now, bytes: currentBytes }];
        }
        state.speedSamples.push({ time: now, bytes: currentBytes });

        while (state.speedSamples.length > 2 && now - state.speedSamples[0].time > 1500) {
            state.speedSamples.shift();
        }

        const oldest = state.speedSamples[0];
        const deltaSec = Math.max(0.12, (now - oldest.time) / 1000);
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
                const dc = dataChannels.get(state.peer.id);
                const buffered = dc ? dc.bufferedAmount : 0;
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

            updateModalMetrics(
                pct,
                currentChunk,
                totalChunks,
                doneBytes,
                totalBytes,
                `${mbPerSec} MB/s • WebRTC Direct`
            );
        }, 100);
    }

    async function finishOutgoingBatch() {
        clearTimers();
        if (!outgoingState) return;

        const totalBytes = outgoingState.totalBatchBytes;
        const totalChunks = Math.max(1, Math.ceil(totalBytes / WEBRTC_CHUNK_SIZE));
        const elapsedSec = Math.max(0.1, (performance.now() - outgoingState.startTime) / 1000);
        const avgSpeed = ((totalBytes / (1024 * 1024)) / elapsedSec).toFixed(2);

        updateModalMetrics(100, totalChunks, totalChunks, totalBytes, totalBytes, `${avgSpeed} MB/s • 100% Complete`);
        markTransferModalComplete(`Delivered ${outgoingState.files.length} file(s) to ${outgoingState.peer.name}`);
        window.convoyApp.showToast(`Sent ${outgoingState.files.length} file(s) to ${outgoingState.peer.name}!`, 'success');

        outgoingState = null;
        window.convoyDiscovery.announcePresence(true);
    }

    function finishIncomingBatch() {
        clearTimers();
        if (!incomingState) return;

        const totalBytes = incomingState.totalBatchBytes;
        const totalChunks = Math.max(1, Math.ceil(totalBytes / WEBRTC_CHUNK_SIZE));
        const elapsedSec = Math.max(0.1, (performance.now() - incomingState.startTime) / 1000);
        const avgSpeed = ((totalBytes / (1024 * 1024)) / elapsedSec).toFixed(2);

        updateModalMetrics(100, totalChunks, totalChunks, totalBytes, totalBytes, `${avgSpeed} MB/s • 100% Complete`);
        markTransferModalComplete(`Saved ${incomingState.manifest.length} file(s)`);
        window.convoyApp.showToast(`Received ${incomingState.manifest.length} file(s)!`, 'success');

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
    }

    function closeTransferModal() {
        clearTimers();
        const modal = document.getElementById('transferModal');
        if (modal) modal.classList.add('hidden');
        window.convoyDiscovery.announcePresence(true);
    }

    function cancelTransfer() {
        clearTimers();

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
        cancelTransfer
    };
})();