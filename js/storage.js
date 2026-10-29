/**
 * convoyOS v0.0.1 - Node Preferences, Paired Rooms & IndexedDB Chunk Ledger
 * Fixes: Uses per-tab sessionStorage for nodeId so multiple tabs on the same PC can transfer files via Global Link.
 */
(function () {
    const DB_NAME = 'convoyOS_DB';
    const DB_VERSION = 1;
    const STORE_LEDGER = 'chunk_ledger';
    const SETTINGS_KEY = 'convoy_node_settings_v2';
    const PAIRED_ROOMS_KEY = 'convoy_paired_rooms_v2';
    const TAB_NODE_ID_KEY = 'convoy_tab_node_id_v2';

    let dbInstance = null;

    function getOrCreateTabNodeId() {
        try {
            let tabId = sessionStorage.getItem(TAB_NODE_ID_KEY);
            if (!tabId) {
                tabId = 'NODE-' + Math.random().toString(36).substring(2, 8).toUpperCase();
                sessionStorage.setItem(TAB_NODE_ID_KEY, tabId);
            }
            return tabId;
        } catch (_) {
            return 'NODE-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        }
    }

    const defaultSettings = {
        nodeId: getOrCreateTabNodeId(),
        pairPin: String(Math.floor(100000 + Math.random() * 900000)),
        deviceName: detectDefaultDeviceName(),
        deviceType: detectDeviceType(),
        osName: detectOsName(),
        autoAccept: 'paired',
        lanIpOverride: ''
    };

    function detectDefaultDeviceName() {
        const ua = navigator.userAgent || '';
        const suffix = Math.floor(10 + Math.random() * 89);
        if (/iPad/i.test(ua)) return `iPad (${suffix})`;
        if (/iPhone/i.test(ua)) return `iPhone (${suffix})`;
        if (/Android/i.test(ua)) return `Android (${suffix})`;
        if (/Macintosh/i.test(ua)) return `Mac (${suffix})`;
        if (/Windows/i.test(ua)) return `Windows PC (${suffix})`;
        if (/Linux/i.test(ua)) return `Linux PC (${suffix})`;
        return `Node (${suffix})`;
    }

    function detectDeviceType() {
        const ua = navigator.userAgent || '';
        if (/iPad|Tablet/i.test(ua)) return 'tablet';
        if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
        return 'laptop';
    }

    function detectOsName() {
        const ua = navigator.userAgent || '';
        if (/Windows/i.test(ua)) return 'Windows';
        if (/Macintosh|Mac OS/i.test(ua)) return 'macOS';
        if (/Android/i.test(ua)) return 'Android';
        if (/iPhone|iPad|iOS/i.test(ua)) return 'iOS';
        if (/Linux/i.test(ua)) return 'Linux';
        return 'WebRTC Peer';
    }

    function getSettings() {
        const tabNodeId = getOrCreateTabNodeId();
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) {
                const initial = { ...defaultSettings, nodeId: tabNodeId };
                localStorage.setItem(SETTINGS_KEY, JSON.stringify(initial));
                return initial;
            }
            const parsed = JSON.parse(raw);
            return { ...defaultSettings, ...parsed, nodeId: tabNodeId };
        } catch (_) {
            return { ...defaultSettings, nodeId: tabNodeId };
        }
    }

    function saveSettings(newSettings) {
        const merged = { ...getSettings(), ...newSettings, nodeId: getOrCreateTabNodeId() };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
        return merged;
    }

    function getPairedRooms() {
        try {
            const raw = localStorage.getItem(PAIRED_ROOMS_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (_) {
            return [];
        }
    }

    function addPairedRoom(pinCode) {
        const cleanPin = String(pinCode).replace(/\D/g, '');
        if (!cleanPin) return getPairedRooms();
        const rooms = getPairedRooms();
        if (!rooms.includes(cleanPin)) {
            rooms.push(cleanPin);
            localStorage.setItem(PAIRED_ROOMS_KEY, JSON.stringify(rooms));
        }
        return rooms;
    }

    function computeFileFingerprint(file) {
        const input = `${file.name || 'file'}:${file.size || 0}:${file.lastModified || 0}`;
        let hash = 2166136261;
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return 'FID-' + (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
    }

    function openDB() {
        return new Promise((resolve) => {
            if (dbInstance) return resolve(dbInstance);
            if (!window.indexedDB) return resolve(null);

            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_LEDGER)) {
                    db.createObjectStore(STORE_LEDGER, { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => {
                dbInstance = e.target.result;
                resolve(dbInstance);
            };
            req.onerror = () => resolve(null);
        });
    }

    async function saveCheckpoint(checkpoint) {
        const db = await openDB();
        if (!db) return false;
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_LEDGER, 'readwrite');
            tx.objectStore(STORE_LEDGER).put({ ...checkpoint, updatedAt: Date.now() });
            tx.oncomplete = () => {
                renderLedgerUI();
                resolve(true);
            };
            tx.onerror = () => resolve(false);
        });
    }

    async function getCheckpoints() {
        const db = await openDB();
        if (!db) return [];
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_LEDGER, 'readonly');
            const req = tx.objectStore(STORE_LEDGER).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }

    async function deleteCheckpoint(id) {
        const db = await openDB();
        if (!db) return;
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_LEDGER, 'readwrite');
            tx.objectStore(STORE_LEDGER).delete(id);
            tx.oncomplete = () => {
                renderLedgerUI();
                resolve(true);
            };
        });
    }

    async function clearAllCheckpoints() {
        const db = await openDB();
        if (!db) return;
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_LEDGER, 'readwrite');
            tx.objectStore(STORE_LEDGER).clear();
            tx.oncomplete = () => {
                renderLedgerUI();
                window.convoyApp?.showToast('Cleared paused transfer history', 'info');
                resolve(true);
            };
        });
    }

    async function renderLedgerUI() {
        const card = document.getElementById('resumeLedgerCard');
        const listEl = document.getElementById('resumeLedgerList');
        if (!card || !listEl) return;

        const items = await getCheckpoints();
        if (!items || items.length === 0) {
            card.classList.add('hidden');
            listEl.innerHTML = '';
            return;
        }

        card.classList.remove('hidden');
        listEl.innerHTML = '';

        items.forEach((item) => {
            const pct = Math.min(99, Math.round((item.byteOffset / item.totalBytes) * 100));
            const row = document.createElement('div');
            row.className = 'ledger-item';
            row.innerHTML = `
                <div style="min-width:0; flex:1">
                    <div style="font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">
                        ${item.fileName} <span style="font-family:var(--font-mono); font-size:10px; color:#fbbf24">(${pct}%)</span>
                    </div>
                    <div style="font-size:10px; color:var(--text-secondary); font-family:var(--font-mono)">
                        Peer: ${item.deviceName}
                    </div>
                </div>
                <div style="display:flex; gap:6px">
                    <button type="button" class="btn-primary-sm" onclick="window.convoyTransfer.resumeFromLedger('${item.id}')">
                        <svg class="icon"><use href="#icon-play"></use></svg> Resume
                    </button>
                    <button type="button" class="file-remove-btn" onclick="window.convoyStorage.deleteCheckpoint('${item.id}')">
                        <svg class="icon"><use href="#icon-close"></use></svg>
                    </button>
                </div>
            `;
            listEl.appendChild(row);
        });
    }

    window.convoyStorage = {
        getSettings,
        saveSettings,
        getPairedRooms,
        addPairedRoom,
        computeFileFingerprint,
        saveCheckpoint,
        getCheckpoints,
        deleteCheckpoint,
        clearAllCheckpoints,
        renderLedgerUI
    };
})();