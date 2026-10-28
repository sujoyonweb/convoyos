/**
 * convoyOS v0.0.1 - IndexedDB Resumable Chunk Ledger & Node Storage
 */
(function () {
    const DB_NAME = 'convoyOS_DB';
    const DB_VERSION = 1;
    const STORE_LEDGER = 'chunk_ledger';
    const SETTINGS_KEY = 'convoy_node_settings_v1';
    const PAIRED_KEY = 'convoy_paired_devices_v1';

    let dbInstance = null;

    const defaultSettings = {
        nodeId: 'NODE-' + Math.random().toString(36).substring(2, 7).toUpperCase(),
        deviceName: detectDefaultDeviceName(),
        autoAccept: 'paired',
        chunkSize: 65536 // 64 KB default
    };

    function detectDefaultDeviceName() {
        const ua = navigator.userAgent || '';
        if (/iPad/i.test(ua)) return 'iPad Pro Node';
        if (/iPhone/i.test(ua)) return 'iPhone 16 Node';
        if (/Android/i.test(ua)) return 'Android Mesh Node';
        if (/Macintosh/i.test(ua)) return 'M3 Max Studio';
        if (/Windows/i.test(ua)) return 'Windows 11 Workstation';
        if (/Linux/i.test(ua)) return 'Linux Mesh Node';
        return 'convoyOS Node';
    }

    function openDB() {
        return new Promise((resolve, reject) => {
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

    function getSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) {
                localStorage.setItem(SETTINGS_KEY, JSON.stringify(defaultSettings));
                return { ...defaultSettings };
            }
            return { ...defaultSettings, ...JSON.parse(raw) };
        } catch (err) {
            return { ...defaultSettings };
        }
    }

    function saveSettings(newSettings) {
        const merged = { ...getSettings(), ...newSettings };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
        return merged;
    }

    function getPairedDevices() {
        try {
            const raw = localStorage.getItem(PAIRED_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (err) {
            return [];
        }
    }

    function addPairedDevice(device) {
        const list = getPairedDevices();
        const exists = list.findIndex(d => d.id === device.id || d.name === device.name);
        if (exists >= 0) {
            list[exists] = { ...list[exists], ...device, paired: true };
        } else {
            list.push({ ...device, paired: true, pairedAt: Date.now() });
        }
        localStorage.setItem(PAIRED_KEY, JSON.stringify(list));
        return list;
    }

    // Fast <2ms File Fingerprinting
    function computeFileFingerprint(file) {
        const name = file.name || 'unnamed';
        const size = file.size || 0;
        const mtime = file.lastModified || 0;
        let hash = 2166136261;
        const input = `${name}:${size}:${mtime}`;
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return 'FID-' + (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
    }

    async function saveCheckpoint(checkpoint) {
        const db = await openDB();
        if (!db) return;
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_LEDGER, 'readwrite');
            tx.objectStore(STORE_LEDGER).put({
                ...checkpoint,
                updatedAt: Date.now()
            });
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
                if (window.convoyApp) {
                    window.convoyApp.showToast('Cleared resumable chunk ledger', 'info');
                }
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

        items.forEach(item => {
            const pct = Math.min(99, Math.round((item.chunkIndex / item.totalChunks) * 100));
            const row = document.createElement('div');
            row.className = 'ledger-item';
            row.innerHTML = `
                <div style="min-width:0; flex:1">
                    <div style="font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">
                        ${item.fileName} <span style="font-family:var(--font-mono); font-size:10px; color:#fbbf24">(${pct}% • Chunk ${item.chunkIndex}/${item.totalChunks})</span>
                    </div>
                    <div style="font-size:10px; color:var(--text-secondary); font-family:var(--font-mono)">
                        Target: ${item.deviceName} • ID: ${item.id}
                    </div>
                </div>
                <div style="display:flex; gap:6px; shrink:0">
                    <button type="button" class="btn-primary-sm" onclick="window.convoyTransfer.resumeCheckpoint('${item.id}')">
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
        getPairedDevices,
        addPairedDevice,
        computeFileFingerprint,
        saveCheckpoint,
        getCheckpoints,
        deleteCheckpoint,
        clearAllCheckpoints,
        renderLedgerUI
    };
})();