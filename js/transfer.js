/**
 * convoyOS v0.0.1 - High-Speed WebRTC + Firewall-Proof Hybrid File Transfer Engine
 */
(function () {
    const CHUNK_SIZE = 65536;               // 64 KB WebRTC binary chunk
    const WS_CHUNK_SIZE = 24576;            // 24 KB WebSocket fallback chunk
    const MAX_BUFFERED_AMOUNT = 4194304;    // 4 MB max WebRTC buffer
    const LOW_THRESHOLD_AMOUNT = 1048576;   // 1 MB refill threshold

    const ICE_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ]
    };

    let peerConnections = new Map();
    let dataChannels = new Map();
    let pendingIceCandidates = new Map();

    let outgoingState = null;
    let incomingState = null;
    let uiUpdateTimer = null;
    let offerRetryTimer = null;

    function init() {}

    function bufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i += 8192) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(len, i + 8192)));
        }
        return btoa(binary);
    }

    function base64ToBuffer(base64) {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    // =========================================================================
    // 1. INITIATE TRANSFER (Instant Popup Offer + Parallel WebRTC Setup)
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

        if (offerRetryTimer) clearInterval(offerRetryTimer);

        const file = files[0];
        outgoingState = {
            id: (file.convoyId || 'FID') + '-' + Date.now().toString(36),
            peer,
            files,
            fileIndex: 0,
            currentFile: file,
            byteOffset: resumeOffset,
            totalBytes: file.size,
            startTime: performance.now(),
            paused: false,
            accepted: false,
            pumping: false,
            transport: 'Connecting...'
        };

        openTransferModalUI(`Waiting for ${peer.name} to accept...`, file.name, resumeOffset, file.size);

        const offerPacket = {
            type: 'TRANSFER_CTRL',
            ctrl: 'FILE_OFFER',
            id: outgoingState.id,
            sender: window.convoyStorage.getSettings(),
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type || 'application/octet-stream',
            startByteOffset: resumeOffset
        };

        // Send FILE_OFFER immediately and retry up to 3 times if receiver hasn't answered yet
        window.convoyDiscovery.sendDirectSignal(peer.id, offerPacket);
        let retries = 0;
        offerRetryTimer = setInterval(() => {
            if (!outgoingState || outgoingState.accepted || retries >= 3) {
                clearInterval(offerRetryTimer);
                return;
            }
            retries++;
            window.convoyDiscovery.sendDirectSignal(peer.id, offerPacket);
        }, 2000);

        // Negotiate WebRTC DataChannel in parallel
        startWebRtcOffer(peer);
    }

    async function startWebRtcOffer(peer) {
        try {
            if (peerConnections.has(peer.id)) {
                peerConnections.get(peer.id).close();
            }
            pendingIceCandidates.set(peer.id, []);

            const pc = new RTCPeerConnection(ICE_CONFIG);
            peerConnections.set(peer.id, pc);

            pc.onicecandidate = (e) => {
                if (e.candidate) {
                    window.convoyDiscovery.sendDirectSignal(peer.id, {
                        type: 'WEBRTC_SIGNAL',
                        sender: window.convoyStorage.getSettings(),
                        signal: { type: 'candidate', candidate: e.candidate }
                    });
                }
            };

            const dc = pc.createDataChannel('convoy_file_stream', { ordered: true });
            setupDataChannel(peer, dc);

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            window.convoyDiscovery.sendDirectSignal(peer.id, {
                type: 'WEBRTC_SIGNAL',
                sender: window.convoyStorage.getSettings(),
                signal: { type: 'sdp', sdp: pc.localDescription }
            });
        } catch (_) {}
    }

    // =========================================================================
    // 2. WEBRTC SIGNALING WITH ICE CANDIDATE QUEUE
    // =========================================================================
    async function handleIncomingWebRtcSignal(packet) {
        const sender = packet.sender;
        const sig = packet.signal;
        if (!sender || !sig) return;
        const peerId = sender.nodeId;

        try {
            if (sig.type === 'sdp' && sig.sdp.type === 'offer') {
                if (peerConnections.has(peerId)) {
                    peerConnections.get(peerId).close();
                }
                if (!pendingIceCandidates.has(peerId)) {
                    pendingIceCandidates.set(peerId, []);
                }

                const pc = new RTCPeerConnection(ICE_CONFIG);
                peerConnections.set(peerId, pc);

                pc.onicecandidate = (e) => {
                    if (e.candidate) {
                        window.convoyDiscovery.sendDirectSignal(peerId, {
                            type: 'WEBRTC_SIGNAL',
                            sender: window.convoyStorage.getSettings(),
                            signal: { type: 'candidate', candidate: e.candidate }
                        });
                    }
                };

                pc.ondatachannel = (e) => {
                    setupDataChannel({ id: peerId, name: sender.deviceName }, e.channel);
                };

                await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
                await flushIceQueue(peerId, pc);

                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                window.convoyDiscovery.sendDirectSignal(peerId, {
                    type: 'WEBRTC_SIGNAL',
                    sender: window.convoyStorage.getSettings(),
                    signal: { type: 'sdp', sdp: pc.localDescription }
                });
            } else if (sig.type === 'sdp' && sig.sdp.type === 'answer') {
                const pc = peerConnections.get(peerId);
                if (pc && pc.signalingState === 'have-local-offer') {
                    await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
                    await flushIceQueue(peerId, pc);
                }
            } else if (sig.type === 'candidate' && sig.candidate) {
                const pc = peerConnections.get(peerId);
                if (pc && pc.remoteDescription && pc.remoteDescription.type) {
                    await pc.addIceCandidate(new RTCIceCandidate(sig.candidate));
                } else {
                    if (!pendingIceCandidates.has(peerId)) pendingIceCandidates.set(peerId, []);
                    pendingIceCandidates.get(peerId).push(sig.candidate);
                }
            }
        } catch (_) {}
    }

    async function flushIceQueue(peerId, pc) {
        const queue = pendingIceCandidates.get(peerId) || [];
        pendingIceCandidates.set(peerId, []);
        for (const cand of queue) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch (_) {}
        }
    }

    function setupDataChannel(peer, dc) {
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = LOW_THRESHOLD_AMOUNT;
        dataChannels.set(peer.id, dc);

        dc.onopen = () => {
            if (outgoingState && outgoingState.peer.id === peer.id && outgoingState.accepted) {
                outgoingState.transport = 'WebRTC Direct';
                if (!outgoingState.pumping) {
                    pumpFileChunks();
                }
            }
        };

        dc.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                handleIncomingBinaryChunk(peer, event.data);
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
    // 3. RECEIVER POPUP & HYBRID CHUNK STREAMING
    // =========================================================================
    function handleSignalingTransferCtrl(msg) {
        const sender = msg.sender || {};
        const peer = { id: sender.nodeId, name: sender.deviceName || 'Peer' };

        if (msg.ctrl === 'FILE_OFFER') {
            // Ignore duplicate retries for the same offer ID
            if (incomingState && incomingState.id === msg.id) return;

            incomingState = {
                id: msg.id,
                peer,
                senderName: peer.name,
                fileName: msg.fileName,
                fileSize: msg.fileSize,
                fileType: msg.fileType,
                receivedBytes: msg.startByteOffset || 0,
                chunks: [],
                startTime: performance.now(),
                transport: 'Direct P2P'
            };

            const settings = window.convoyStorage.getSettings();
            if (settings.autoAccept === 'all') {
                acceptIncomingTransfer();
            } else {
                // Always display the Incoming File Transfer popup so user sees & confirms
                const modal = document.getElementById('incomingModal');
                const senderEl = document.getElementById('incomingSenderName');
                const summaryEl = document.getElementById('incomingFileSummary');
                if (senderEl) senderEl.textContent = `${incomingState.senderName} wants to send:`;
                if (summaryEl) {
                    summaryEl.textContent = `${msg.fileName} (${window.convoyDragDrop.formatBytes(msg.fileSize)})`;
                }
                if (modal) modal.classList.remove('hidden');
            }
        } else if (msg.ctrl === 'FILE_ACCEPT') {
            if (!outgoingState || outgoingState.accepted) return;
            if (offerRetryTimer) clearInterval(offerRetryTimer);

            outgoingState.accepted = true;
            outgoingState.startTime = performance.now();
            const titleEl = document.getElementById('transferModalTitle');
            if (titleEl) titleEl.textContent = `Sending to ${outgoingState.peer.name}...`;

            startDecoupledUiLoop(true);

            const dc = dataChannels.get(outgoingState.peer.id);
            if (dc && dc.readyState === 'open') {
                outgoingState.transport = 'WebRTC Direct';
                pumpFileChunks();
            } else {
                // Wait 800ms for WebRTC UDP; if blocked by firewall, stream immediately via WebSocket
                setTimeout(() => {
                    if (!outgoingState || outgoingState.pumping) return;
                    const readyDc = dataChannels.get(outgoingState.peer.id);
                    outgoingState.transport = (readyDc && readyDc.readyState === 'open')
                        ? 'WebRTC Direct'
                        : 'Fast Stream';
                    pumpFileChunks();
                }, 800);
            }
        } else if (msg.ctrl === 'FILE_DECLINE') {
            if (offerRetryTimer) clearInterval(offerRetryTimer);
            closeTransferModal();
            window.convoyApp.showToast(`${peer.name} declined the file transfer`, 'error');
        } else if (msg.ctrl === 'WS_CHUNK') {
            if (!incomingState || msg.id !== incomingState.id) return;
            const buf = base64ToBuffer(msg.data);
            handleIncomingBinaryChunk(peer, buf);
        } else if (msg.ctrl === 'FILE_COMPLETE_ACK') {
            finishOutgoingTransfer();
        }
    }

    function acceptIncomingTransfer() {
        const incModal = document.getElementById('incomingModal');
        if (incModal) incModal.classList.add('hidden');
        if (!incomingState) return;

        incomingState.startTime = performance.now();
        openTransferModalUI(
            `Receiving from ${incomingState.senderName}...`,
            incomingState.fileName,
            incomingState.receivedBytes,
            incomingState.fileSize
        );
        startDecoupledUiLoop(false);

        window.convoyDiscovery.sendDirectSignal(incomingState.peer.id, {
            type: 'TRANSFER_CTRL',
            ctrl: 'FILE_ACCEPT',
            id: incomingState.id,
            sender: window.convoyStorage.getSettings()
        });
    }

    function declineIncomingTransfer() {
        const incModal = document.getElementById('incomingModal');
        if (incModal) incModal.classList.add('hidden');
        if (incomingState) {
            window.convoyDiscovery.sendDirectSignal(incomingState.peer.id, {
                type: 'TRANSFER_CTRL',
                ctrl: 'FILE_DECLINE',
                sender: window.convoyStorage.getSettings()
            });
        }
        incomingState = null;
    }

    async function pumpFileChunks() {
        if (!outgoingState || outgoingState.paused || outgoingState.pumping) return;
        outgoingState.pumping = true;

        const { currentFile, peer } = outgoingState;

        while (outgoingState && !outgoingState.paused && outgoingState.byteOffset < currentFile.size) {
            const dc = dataChannels.get(peer.id);
            const useWebRtc = dc && dc.readyState === 'open';

            if (useWebRtc) {
                outgoingState.transport = 'WebRTC Direct';
                if (dc.bufferedAmount >= MAX_BUFFERED_AMOUNT) {
                    outgoingState.pumping = false;
                    dc.onbufferedamountlow = () => pumpFileChunks();
                    return;
                }
                const nextEnd = Math.min(currentFile.size, outgoingState.byteOffset + CHUNK_SIZE);
                const buffer = await currentFile.slice(outgoingState.byteOffset, nextEnd).arrayBuffer();
                if (!outgoingState || outgoingState.paused) break;
                dc.send(buffer);
                outgoingState.byteOffset = nextEnd;
            } else {
                outgoingState.transport = 'P2P Stream';
                const nextEnd = Math.min(currentFile.size, outgoingState.byteOffset + WS_CHUNK_SIZE);
                const buffer = await currentFile.slice(outgoingState.byteOffset, nextEnd).arrayBuffer();
                if (!outgoingState || outgoingState.paused) break;

                window.convoyDiscovery.sendDirectSignal(peer.id, {
                    type: 'TRANSFER_CTRL',
                    ctrl: 'WS_CHUNK',
                    id: outgoingState.id,
                    sender: window.convoyStorage.getSettings(),
                    data: bufferToBase64(buffer)
                });
                outgoingState.byteOffset = nextEnd;
                await new Promise((r) => setTimeout(r, 20));
            }
        }

        if (outgoingState) outgoingState.pumping = false;
    }

    function handleIncomingBinaryChunk(peer, arrayBuffer) {
        if (!incomingState) return;
        incomingState.chunks.push(arrayBuffer);
        incomingState.receivedBytes += arrayBuffer.byteLength;

        if (incomingState.receivedBytes >= incomingState.fileSize) {
            const blob = new Blob(incomingState.chunks, { type: incomingState.fileType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = incomingState.fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 8000);

            window.convoyDiscovery.sendDirectSignal(incomingState.peer.id, {
                type: 'TRANSFER_CTRL',
                ctrl: 'FILE_COMPLETE_ACK',
                id: incomingState.id,
                sender: window.convoyStorage.getSettings()
            });
            finishIncomingTransfer();
        }
    }

    // =========================================================================
    // 4. DECOUPLED 100MS UI PROGRESS UPDATER
    // =========================================================================
    function startDecoupledUiLoop(isSending) {
        if (uiUpdateTimer) clearInterval(uiUpdateTimer);
        uiUpdateTimer = setInterval(() => {
            const state = isSending ? outgoingState : incomingState;
            if (!state) return;

            const doneBytes = isSending ? state.byteOffset : state.receivedBytes;
            const totalBytes = isSending ? state.totalBytes : state.fileSize;
            const pct = totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 100;

            const elapsedSec = Math.max(0.1, (performance.now() - state.startTime) / 1000);
            const mbPerSec = ((doneBytes / (1024 * 1024)) / elapsedSec).toFixed(2);

            const totalChunks = Math.max(1, Math.ceil(totalBytes / CHUNK_SIZE));
            const currentChunk = Math.min(totalChunks, Math.ceil(doneBytes / CHUNK_SIZE));

            updateModalMetrics(
                pct,
                currentChunk,
                totalChunks,
                doneBytes,
                totalBytes,
                `${mbPerSec} MB/s • ${state.transport || 'Direct P2P'}`
            );
        }, 100);
    }

    async function finishOutgoingTransfer() {
        if (uiUpdateTimer) clearInterval(uiUpdateTimer);
        if (offerRetryTimer) clearInterval(offerRetryTimer);
        if (!outgoingState) return;

        await window.convoyStorage.deleteCheckpoint(outgoingState.id);

        if (outgoingState.fileIndex + 1 < outgoingState.files.length) {
            outgoingState.fileIndex++;
            const nextFile = outgoingState.files[outgoingState.fileIndex];
            outgoingState.id = (nextFile.convoyId || 'FID') + '-' + Date.now().toString(36);
            outgoingState.currentFile = nextFile;
            outgoingState.byteOffset = 0;
            outgoingState.totalBytes = nextFile.size;
            outgoingState.accepted = false;
            outgoingState.pumping = false;

            openTransferModalUI(`Sending to ${outgoingState.peer.name}...`, nextFile.name, 0, nextFile.size);
            window.convoyDiscovery.sendDirectSignal(outgoingState.peer.id, {
                type: 'TRANSFER_CTRL',
                ctrl: 'FILE_OFFER',
                id: outgoingState.id,
                sender: window.convoyStorage.getSettings(),
                fileName: nextFile.name,
                fileSize: nextFile.size,
                fileType: nextFile.type || 'application/octet-stream',
                startByteOffset: 0
            });
            return;
        }

        markTransferModalComplete(`Delivered to ${outgoingState.peer.name}`);
        window.convoyApp.showToast(`Sent ${outgoingState.files.length} file(s) to ${outgoingState.peer.name}!`, 'success');
        outgoingState = null;
    }

    function finishIncomingTransfer() {
        if (uiUpdateTimer) clearInterval(uiUpdateTimer);
        if (!incomingState) return;
        markTransferModalComplete(`Saved ${incomingState.fileName}`);
        window.convoyApp.showToast(`Received "${incomingState.fileName}"!`, 'success');
        incomingState = null;
    }

    async function togglePauseTransfer() {
        if (!outgoingState) return;
        const pauseBtn = document.getElementById('pauseResumeBtn');
        const speedEl = document.getElementById('transferSpeed');

        if (!outgoingState.paused) {
            outgoingState.paused = true;
            outgoingState.pumping = false;
            await window.convoyStorage.saveCheckpoint({
                id: outgoingState.id,
                fileName: outgoingState.currentFile.name,
                deviceName: outgoingState.peer.name,
                peer: outgoingState.peer,
                byteOffset: outgoingState.byteOffset,
                totalBytes: outgoingState.totalBytes
            });
            if (pauseBtn) pauseBtn.textContent = 'Resume';
            if (speedEl) speedEl.textContent = 'Paused — Checkpoint saved in IndexedDB';
        } else {
            outgoingState.paused = false;
            if (pauseBtn) pauseBtn.textContent = 'Pause';
            pumpFileChunks();
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

        const totalChunks = Math.max(1, Math.ceil(totalBytes / CHUNK_SIZE));
        const curChunk = Math.ceil(doneBytes / CHUNK_SIZE);
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
        const speedEl = document.getElementById('transferSpeed');
        const barEl = document.getElementById('transferProgressBar');
        const pctEl = document.getElementById('transferPercent');
        const doneBtn = document.getElementById('transferDoneBtn');
        const pauseBtn = document.getElementById('pauseResumeBtn');
        const iconUse = document.getElementById('transferStatusIconUse');

        if (titleEl) titleEl.textContent = titleText;
        if (speedEl) speedEl.textContent = '100% Complete • Direct P2P Verified';
        if (barEl) barEl.style.width = '100%';
        if (pctEl) pctEl.textContent = '100%';
        if (iconUse) iconUse.setAttribute('href', '#icon-check');
        if (doneBtn) doneBtn.classList.remove('hidden');
        if (pauseBtn) pauseBtn.classList.add('hidden');
    }

    function closeTransferModal() {
        if (uiUpdateTimer) clearInterval(uiUpdateTimer);
        if (offerRetryTimer) clearInterval(offerRetryTimer);
        const modal = document.getElementById('transferModal');
        if (modal) modal.classList.add('hidden');
    }

    function cancelTransfer() {
        if (uiUpdateTimer) clearInterval(uiUpdateTimer);
        if (offerRetryTimer) clearInterval(offerRetryTimer);
        outgoingState = null;
        incomingState = null;
        closeTransferModal();
        window.convoyApp.showToast('Transfer canceled', 'info');
    }

    window.convoyTransfer = {
        init,
        initiateWebRtcTransfer,
        handleIncomingWebRtcSignal,
        handleSignalingTransferCtrl,
        attachOfflineDataChannel,
        acceptIncomingTransfer,
        declineIncomingTransfer,
        togglePauseTransfer,
        resumeFromLedger,
        closeTransferModal,
        cancelTransfer
    };
})();