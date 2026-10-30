/**
 * convoyOS v0.0.1 - Phase 2 File, Folder Auto-Zip, Thumbnail & Clipboard Staging Module
 */
(function () {
    let stagedFiles = [];

    // Precomputed CRC32 Lookup Table for fast zero-compression PKZIP folder bundling
    const CRC32_TABLE = new Uint32Array(256);
    (function initCrc32Table() {
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            CRC32_TABLE[i] = c >>> 0;
        }
    })();

    function init() {
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        const folderInput = document.getElementById('folderInput');

        if (!dropZone) return;

        ['dragenter', 'dragover'].forEach((evt) => {
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.add('dropzone-active');
            });
        });

        ['dragleave', 'drop'].forEach((evt) => {
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove('dropzone-active');
            });
        });

        dropZone.addEventListener('drop', async (e) => {
            const items = e.dataTransfer?.items;
            if (items && items.length > 0 && items[0].webkitGetAsEntry) {
                const extracted = [];
                let hasDirectory = false;
                let rootDirName = 'Folder';

                for (let i = 0; i < items.length; i++) {
                    const entry = items[i].webkitGetAsEntry();
                    if (entry) {
                        if (entry.isDirectory) {
                            hasDirectory = true;
                            rootDirName = entry.name || rootDirName;
                        }
                        await traverseFileTree(entry, '', extracted);
                    }
                }
                if (extracted.length > 0) {
                    if (hasDirectory) {
                        await bundleAndStageFolderZip(extracted, rootDirName);
                    } else {
                        addFilesToQueue(extracted);
                    }
                    return;
                }
            }
            if (e.dataTransfer?.files?.length) {
                addFilesToQueue(e.dataTransfer.files);
            }
        });

        fileInput?.addEventListener('change', (e) => {
            if (e.target.files?.length) {
                addFilesToQueue(e.target.files);
                fileInput.value = '';
            }
        });

        folderInput?.addEventListener('change', async (e) => {
            if (e.target.files?.length) {
                const rawFiles = Array.from(e.target.files);
                folderInput.value = '';
                const firstPath = rawFiles[0]?.webkitRelativePath || '';
                const rootName = firstPath.includes('/') ? firstPath.split('/')[0] : 'Folder';
                rawFiles.forEach((f) => {
                    if (f.webkitRelativePath) f.relativePath = f.webkitRelativePath;
                });
                await bundleAndStageFolderZip(rawFiles, rootName);
            }
        });

        // Global Ctrl+V Clipboard Paste
        window.addEventListener('paste', (e) => {
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            const items = e.clipboardData?.items;
            if (!items) return;

            const pastedFiles = [];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.kind === 'file') {
                    const blob = item.getAsFile();
                    if (blob) pastedFiles.push(blob);
                } else if (item.kind === 'string' && item.type === 'text/plain') {
                    item.getAsString((text) => {
                        if (text && text.trim() && pastedFiles.length === 0) {
                            stageTextSnippet(text.trim());
                        }
                    });
                }
            }
            if (pastedFiles.length > 0) addFilesToQueue(pastedFiles);
        });

        // Listen for files/text shared from Android OS Share Sheet via Service Worker
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                const data = event.data;
                if (!data || data.type !== 'CONVOY_OS_SHARE_TARGET') return;
                if (data.files && data.files.length > 0) {
                    addFilesToQueue(data.files);
                }
                if (data.text && data.text.trim()) {
                    stageTextSnippet(data.text.trim());
                }
            });

            if (window.location.search.includes('share-target=1')) {
                history.replaceState(null, '', window.location.pathname);
                navigator.serviceWorker.ready.then((reg) => {
                    reg.active?.postMessage({ type: 'CLAIM_SHARED_ITEMS' });
                });
            }
        }
    }

    async function traverseFileTree(entry, path, outList) {
        if (entry.isFile) {
            return new Promise((resolve) => {
                entry.file((file) => {
                    file.relativePath = path + file.name;
                    outList.push(file);
                    resolve();
                }, () => resolve());
            });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            return new Promise((resolve) => {
                const readBatch = () => {
                    reader.readEntries(async (entries) => {
                        if (!entries || entries.length === 0) {
                            resolve();
                            return;
                        }
                        for (let i = 0; i < entries.length; i++) {
                            await traverseFileTree(entries[i], path + entry.name + '/', outList);
                        }
                        readBatch();
                    }, () => resolve());
                };
                readBatch();
            });
        }
    }

    // =========================================================================
    // ZERO-COMPRESSION (STORE MODE) ON-THE-FLY FOLDER .ZIP BUNDLER
    // =========================================================================
    async function computeFileCrc32(file) {
        let crc = 0xffffffff;
        const chunkSize = 2097152; // 2 MB slice
        let offset = 0;
        while (offset < file.size) {
            const slice = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
            const u8 = new Uint8Array(slice);
            for (let i = 0; i < u8.length; i++) {
                crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ u8[i]) & 0xff];
            }
            offset += chunkSize;
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    async function bundleAndStageFolderZip(filesList, folderName) {
        if (!filesList || filesList.length === 0) return;
        window.convoyApp.showToast(`Packaging folder "${folderName}" (${filesList.length} files)...`, 'info');

        try {
            const encoder = new TextEncoder();
            const blobParts = [];
            const centralDirectoryParts = [];
            let currentOffset = 0;
            let centralDirSize = 0;

            const now = new Date();
            const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
            const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

            for (let i = 0; i < filesList.length; i++) {
                const f = filesList[i];
                const relPath = (f.relativePath || f.webkitRelativePath || f.name).replace(/^\/+/, '');
                const nameBytes = encoder.encode(relPath);
                const crc = await computeFileCrc32(f);
                const size = f.size >>> 0;

                // 1. 30-byte Local File Header + UTF-8 path
                const lfh = new Uint8Array(30 + nameBytes.length);
                const lfhView = new DataView(lfh.buffer);
                lfhView.setUint32(0, 0x04034b50, true);     // PK\x03\x04
                lfhView.setUint16(4, 20, true);             // Version 2.0
                lfhView.setUint16(6, 0x0800, true);         // Bit 11: UTF-8 filename
                lfhView.setUint16(8, 0, true);              // Method 0: STORE (0% CPU compression)
                lfhView.setUint16(10, dosTime, true);
                lfhView.setUint16(12, dosDate, true);
                lfhView.setUint32(14, crc, true);
                lfhView.setUint32(18, size, true);
                lfhView.setUint32(22, size, true);
                lfhView.setUint16(26, nameBytes.length, true);
                lfhView.setUint16(28, 0, true);
                lfh.set(nameBytes, 30);

                // 2. 46-byte Central Directory Header + UTF-8 path
                const cdh = new Uint8Array(46 + nameBytes.length);
                const cdhView = new DataView(cdh.buffer);
                cdhView.setUint32(0, 0x02014b50, true);     // PK\x01\x02
                cdhView.setUint16(4, 20, true);
                cdhView.setUint16(6, 20, true);
                cdhView.setUint16(8, 0x0800, true);         // UTF-8 flag
                cdhView.setUint16(10, 0, true);             // Method 0: STORE
                cdhView.setUint16(12, dosTime, true);
                cdhView.setUint16(14, dosDate, true);
                cdhView.setUint32(16, crc, true);
                cdhView.setUint32(20, size, true);
                cdhView.setUint32(24, size, true);
                cdhView.setUint16(28, nameBytes.length, true);
                cdhView.setUint16(30, 0, true);
                cdhView.setUint16(32, 0, true);
                cdhView.setUint16(34, 0, true);
                cdhView.setUint16(36, 0, true);
                cdhView.setUint32(38, 0, true);
                cdhView.setUint32(42, currentOffset, true);
                cdh.set(nameBytes, 46);

                blobParts.push(lfh, f); // References original disk File directly without copying RAM
                centralDirectoryParts.push(cdh);

                currentOffset += lfh.byteLength + size;
                centralDirSize += cdh.byteLength;
            }

            // 3. 22-byte End of Central Directory Record (EOCD)
            const eocd = new Uint8Array(22);
            const eocdView = new DataView(eocd.buffer);
            eocdView.setUint32(0, 0x06054b50, true);        // PK\x05\x06
            eocdView.setUint16(4, 0, true);
            eocdView.setUint16(6, 0, true);
            eocdView.setUint16(8, filesList.length, true);
            eocdView.setUint16(10, filesList.length, true);
            eocdView.setUint32(12, centralDirSize, true);
            eocdView.setUint32(16, currentOffset, true);
            eocdView.setUint16(20, 0, true);

            const zipFileName = `${folderName.replace(/\.zip$/i, '')}.zip`;
            const zipFile = new File([...blobParts, ...centralDirectoryParts, eocd], zipFileName, {
                type: 'application/zip'
            });
            zipFile.isFolderZip = true;
            zipFile.folderFileCount = filesList.length;

            addFilesToQueue([zipFile]);
        } catch (_) {
            addFilesToQueue(filesList);
        }
    }

    // =========================================================================
    // INSTANT CLIPBOARD TEXT & LINK STAGING
    // =========================================================================
    function stageTextSnippet(text) {
        const clean = String(text || '').trim();
        if (!clean) return;
        const previewLabel = clean.length > 28 ? clean.slice(0, 28) + '...' : clean;
        const snippetFile = new File(
            [clean],
            `clipboard_${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}.txt`,
            { type: 'text/plain' }
        );
        snippetFile.isTextSnippet = true;
        snippetFile.snippetPreview = previewLabel;
        addFilesToQueue([snippetFile]);
    }

    async function pasteFromClipboard() {
        try {
            if (navigator.clipboard?.readText) {
                const text = await navigator.clipboard.readText();
                if (text && text.trim()) {
                    stageTextSnippet(text.trim());
                    return;
                }
            }
        } catch (_) {}

        // If browser blocked direct clipboard read or clipboard was empty, open clean input modal
        const modal = document.getElementById('clipboardInputModal');
        const textarea = document.getElementById('clipboardManualTextarea');
        if (modal) {
            modal.classList.remove('hidden');
            if (textarea) {
                textarea.value = '';
                setTimeout(() => textarea.focus(), 60);
            }
        }
    }

    function closeClipboardModal() {
        const modal = document.getElementById('clipboardInputModal');
        if (modal) modal.classList.add('hidden');
    }

    function stageManualClipboardText() {
        const textarea = document.getElementById('clipboardManualTextarea');
        const val = textarea?.value?.trim() || '';
        if (!val) {
            window.convoyApp.showToast('Please paste or type some text first', 'error');
            return;
        }
        closeClipboardModal();
        stageTextSnippet(val);
    }

    // =========================================================================
    // QUEUE MANAGEMENT & ZERO-COST LOCAL IMAGE THUMBNAILS
    // =========================================================================
    function addFilesToQueue(fileList) {
        if (!fileList || fileList.length === 0) return;
        for (let i = 0; i < fileList.length; i++) {
            const f = fileList[i];
            f.convoyId = window.convoyStorage.computeFileFingerprint(f);
            if (f.type && f.type.startsWith('image/') && !f._thumbUrl) {
                try {
                    f._thumbUrl = URL.createObjectURL(f);
                } catch (_) {}
            }
            stagedFiles.push(f);
        }
        updateStagedUI();
        window.convoyDiscovery?.onFilesStaged?.();
        window.convoyApp.showToast(`Staged ${fileList.length} item(s)`, 'success');
    }

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&')
            .replace(/</g, '<')
            .replace(/>/g, '>')
            .replace(/"/g, '"');
    }

    function updateStagedUI() {
        const prompt = document.getElementById('dropZonePrompt');
        const container = document.getElementById('stagedFilesContainer');
        const countEl = document.getElementById('stagedCount');
        const totalBytesEl = document.getElementById('stagedTotalBytes');
        const listEl = document.getElementById('fileListScroll');

        if (!prompt || !container || !listEl) return;

        if (stagedFiles.length === 0) {
            prompt.classList.remove('hidden');
            container.classList.add('hidden');
            window.convoyDiscovery?.updateGlobalShareBadge?.();
            return;
        }

        prompt.classList.add('hidden');
        container.classList.remove('hidden');
        countEl.textContent = stagedFiles.length;

        const totalBytes = stagedFiles.reduce((acc, f) => acc + (f.size || 0), 0);
        if (totalBytesEl) totalBytesEl.textContent = `• ${formatBytes(totalBytes)}`;

        listEl.innerHTML = '';
        stagedFiles.forEach((file, index) => {
            const rawTitle = file.isTextSnippet
                ? `Text: "${file.snippetPreview || file.name}"`
                : (file.relativePath || file.name);
            const displayName = escapeHtml(rawTitle);
            const subLabel = file.isFolderZip
                ? `${formatBytes(file.size)} • Folder ZIP (${file.folderFileCount} files)`
                : (file.isTextSnippet ? `${formatBytes(file.size)} • Instant Clipboard Snippet` : formatBytes(file.size));

            let badgeInnerHtml = `<svg class="icon"><use href="${file.isFolderZip ? '#icon-folder' : (file.isTextSnippet ? '#icon-clipboard' : '#icon-file')}"></use></svg>`;
            if (file._thumbUrl) {
                badgeInnerHtml = `<img src="${file._thumbUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block">`;
            }

            const item = document.createElement('div');
            item.className = 'file-item-card';
            item.innerHTML = `
                <div class="file-item-left">
                    <div class="file-icon-badge" style="overflow:hidden">
                        ${badgeInnerHtml}
                    </div>
                    <div class="file-meta-wrap">
                        <h4 class="file-item-name" title="${displayName}">${displayName}</h4>
                        <p class="file-item-sub">${subLabel}</p>
                    </div>
                </div>
                <button type="button" class="file-remove-btn" onclick="window.convoyDragDrop.removeStagedFile(${index})" title="Remove">
                    <svg class="icon"><use href="#icon-close"></use></svg>
                </button>
            `;
            listEl.appendChild(item);
        });

        window.convoyDiscovery?.updateGlobalShareBadge?.();
    }

    function removeStagedFile(index) {
        const removed = stagedFiles[index];
        if (removed && removed._thumbUrl) {
            try { URL.revokeObjectURL(removed._thumbUrl); } catch (_) {}
        }
        stagedFiles.splice(index, 1);
        updateStagedUI();
    }

    function clearStagedFiles() {
        stagedFiles.forEach((f) => {
            if (f._thumbUrl) {
                try { URL.revokeObjectURL(f._thumbUrl); } catch (_) {}
            }
        });
        stagedFiles = [];
        updateStagedUI();
    }

    function getStagedFiles() {
        return stagedFiles;
    }

    window.convoyDragDrop = {
        init,
        pasteFromClipboard,
        closeClipboardModal,
        stageManualClipboardText,
        addFilesToQueue,
        removeStagedFile,
        clearStagedFiles,
        getStagedFiles,
        formatBytes
    };
})();