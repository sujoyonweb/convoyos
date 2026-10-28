/**
 * convoyOS v0.0.1 - Universal File, Folder & Clipboard Staging Engine
 */
(function () {
    let stagedFiles = [];

    function init() {
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        const folderInput = document.getElementById('folderInput');

        if (!dropZone) return;

        ['dragenter', 'dragover'].forEach(evt => {
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.add('dropzone-active');
            });
        });

        ['dragleave', 'drop'].forEach(evt => {
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
                for (let i = 0; i < items.length; i++) {
                    const entry = items[i].webkitGetAsEntry();
                    if (entry) {
                        await traverseFileTree(entry, '', extracted);
                    }
                }
                if (extracted.length > 0) {
                    addFilesToQueue(extracted);
                    return;
                }
            }
            if (e.dataTransfer?.files?.length) {
                addFilesToQueue(e.dataTransfer.files);
            }
        });

        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                if (e.target.files?.length) {
                    addFilesToQueue(e.target.files);
                    fileInput.value = '';
                }
            });
        }

        if (folderInput) {
            folderInput.addEventListener('change', (e) => {
                if (e.target.files?.length) {
                    addFilesToQueue(e.target.files);
                    folderInput.value = '';
                }
            });
        }

        // Global Ctrl+V Clipboard Listener
        window.addEventListener('paste', (e) => {
            const activeTag = document.activeElement?.tagName;
            if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

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
                        if (text && text.trim().length > 0 && pastedFiles.length === 0) {
                            const snippetFile = new File(
                                [text],
                                `clipboard_${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}.txt`,
                                { type: 'text/plain' }
                            );
                            addFilesToQueue([snippetFile]);
                        }
                    });
                }
            }
            if (pastedFiles.length > 0) {
                addFilesToQueue(pastedFiles);
            }
        });
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
            const dirReader = entry.createReader();
            return new Promise((resolve) => {
                dirReader.readEntries(async (entries) => {
                    for (let i = 0; i < entries.length; i++) {
                        await traverseFileTree(entries[i], path + entry.name + '/', outList);
                    }
                    resolve();
                }, () => resolve());
            });
        }
    }

    async function pasteFromClipboard() {
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                const text = await navigator.clipboard.readText();
                if (text && text.trim()) {
                    const snippetFile = new File(
                        [text],
                        `clipboard_note_${Date.now().toString().slice(-4)}.txt`,
                        { type: 'text/plain' }
                    );
                    addFilesToQueue([snippetFile]);
                    return;
                }
            }
            window.convoyApp.showToast('Press Ctrl+V (or Cmd+V) to paste files, screenshots, or text!', 'info');
        } catch (err) {
            window.convoyApp.showToast('Press Ctrl+V anywhere on the page to paste from clipboard', 'info');
        }
    }

    function addFilesToQueue(fileList) {
        if (!fileList || fileList.length === 0) return;
        let added = 0;
        for (let i = 0; i < fileList.length; i++) {
            const f = fileList[i];
            f.convoyId = window.convoyStorage.computeFileFingerprint(f);
            stagedFiles.push(f);
            added++;
        }
        updateStagedUI();
        if (window.convoyTransfer) {
            window.convoyTransfer.refreshShareLinkToken();
        }
        window.convoyApp.showToast(`Staged ${added} item(s) for P2P streaming`, 'success');
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
            return;
        }

        prompt.classList.add('hidden');
        container.classList.remove('hidden');
        countEl.textContent = stagedFiles.length;

        const totalBytes = stagedFiles.reduce((acc, f) => acc + (f.size || 0), 0);
        if (totalBytesEl) {
            totalBytesEl.textContent = `• ${formatBytes(totalBytes)}`;
        }

        listEl.innerHTML = '';
        stagedFiles.forEach((file, index) => {
            const displayName = file.relativePath || file.name;
            const item = document.createElement('div');
            item.className = 'file-item-card';
            item.innerHTML = `
                <div class="file-item-left">
                    <div class="file-icon-badge">
                        <svg class="icon"><use href="#icon-file"></use></svg>
                    </div>
                    <div class="file-meta-wrap">
                        <h4 class="file-item-name" title="${displayName}">${displayName}</h4>
                        <p class="file-item-sub">${formatBytes(file.size)} • ${file.convoyId}</p>
                    </div>
                </div>
                <button type="button" class="file-remove-btn" onclick="window.convoyDragDrop.removeStagedFile(${index})" title="Remove">
                    <svg class="icon"><use href="#icon-close"></use></svg>
                </button>
            `;
            listEl.appendChild(item);
        });
    }

    function removeStagedFile(index) {
        stagedFiles.splice(index, 1);
        updateStagedUI();
        window.convoyApp.showToast('Removed file from queue', 'info');
    }

    function clearStagedFiles() {
        stagedFiles = [];
        updateStagedUI();
        window.convoyApp.showToast('Staging queue cleared', 'info');
    }

    function getStagedFiles() {
        return stagedFiles;
    }

    window.convoyDragDrop = {
        init,
        pasteFromClipboard,
        addFilesToQueue,
        removeStagedFile,
        clearStagedFiles,
        getStagedFiles,
        formatBytes
    };
})();