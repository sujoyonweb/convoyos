/**
 * convoyOS v0.0.1 - Main Application Controller
 */
(function () {
    let shakeModeEnabled = true;

    document.addEventListener('DOMContentLoaded', () => {
        applySettingsToHeader();
        window.convoyDragDrop.init();
        window.convoyDiscovery.init();
        window.convoyTransfer.init();
        window.convoyStorage.renderLedgerUI();
        setupNetworkStatusWatcher();
        registerServiceWorker();
    });

    function applySettingsToHeader() {
        const settings = window.convoyStorage.getSettings();
        const nameEl = document.getElementById('headerNodeName');
        const badgeEl = document.getElementById('nodeInitialsBadge');
        const inputName = document.getElementById('settingDeviceName');
        const selectAccept = document.getElementById('settingAutoAccept');
        const selectChunk = document.getElementById('settingChunkSize');

        if (nameEl) nameEl.textContent = settings.deviceName;
        if (badgeEl) {
            const words = settings.deviceName.trim().split(/\s+/);
            const initials = words.length > 1
                ? (words[0][0] + words[1][0]).toUpperCase()
                : settings.deviceName.slice(0, 2).toUpperCase();
            badgeEl.textContent = initials;
        }

        if (inputName) inputName.value = settings.deviceName;
        if (selectAccept) selectAccept.value = settings.autoAccept;
        if (selectChunk) selectChunk.value = String(settings.chunkSize);
    }

    function switchHubTab(tabName) {
        const tabs = ['nearby', 'share', 'offline'];
        const titles = {
            nearby: 'Nearby & Paired Nodes',
            share: 'P2P Link & QR Stream',
            offline: '100% Offline LAN & Host'
        };

        tabs.forEach(t => {
            const btn = document.getElementById('tabBtn' + t.charAt(0).toUpperCase() + t.slice(1));
            const panel = document.getElementById('tabPanel' + t.charAt(0).toUpperCase() + t.slice(1));
            if (btn) btn.classList.toggle('active', t === tabName);
            if (panel) panel.classList.toggle('hidden', t !== tabName);
        });

        const heading = document.getElementById('hubPanelTitle');
        if (heading && titles[tabName]) {
            heading.textContent = titles[tabName];
        }
    }

    function toggleShakeMode() {
        shakeModeEnabled = !shakeModeEnabled;
        const headerBtn = document.getElementById('shakeHeaderBtn');
        const actionBtn = document.getElementById('shakeActionBtn');
        if (headerBtn) headerBtn.classList.toggle('active', shakeModeEnabled);
        if (actionBtn) actionBtn.classList.toggle('shake-active', shakeModeEnabled);

        showToast(
            shakeModeEnabled
                ? 'Shake-to-Send gesture armed! Shake devices together to auto-transfer.'
                : 'Shake-to-Send gesture paused',
            'info'
        );
    }

    function isShakeModeEnabled() {
        return shakeModeEnabled;
    }

    function triggerInstantShake() {
        window.convoyDiscovery.broadcastShakeSignal();
        const staged = window.convoyDragDrop.getStagedFiles();
        if (staged.length === 0) {
            showToast('Shake handshake broadcast sent! Stage a file on the left to auto-send on shake.', 'info');
            return;
        }
        const targetPeer = window.convoyDiscovery.getFirstAvailablePeer();
        if (targetPeer) {
            showToast(`Shake Handshake matched with ${targetPeer.name}! Starting zero-tap stream...`, 'success');
            window.convoyTransfer.startTransferToDevice(targetPeer);
        }
    }

    function openSettingsModal() {
        applySettingsToHeader();
        const modal = document.getElementById('settingsModal');
        if (modal) modal.classList.remove('hidden');
    }

    function closeSettingsModal() {
        const modal = document.getElementById('settingsModal');
        if (modal) modal.classList.add('hidden');
    }

    function saveSettings() {
        const nameVal = document.getElementById('settingDeviceName')?.value.trim() || 'convoyOS Node';
        const acceptVal = document.getElementById('settingAutoAccept')?.value || 'paired';
        const chunkVal = Number(document.getElementById('settingChunkSize')?.value || 65536);

        window.convoyStorage.saveSettings({
            deviceName: nameVal,
            autoAccept: acceptVal,
            chunkSize: chunkVal
        });

        applySettingsToHeader();
        closeSettingsModal();
        showToast('Saved convoyOS node preferences', 'success');
    }

    function setupNetworkStatusWatcher() {
        const dot = document.getElementById('networkStatusDot');
        const label = document.getElementById('networkModeLabel');
        const subnetEl = document.getElementById('subnetStatValue');

        function updateOnlineStatus() {
            const online = navigator.onLine;
            if (dot) dot.classList.toggle('offline', !online);
            if (label) label.textContent = online ? 'Mesh Ready' : 'Offline LAN Mode';
            if (subnetEl) subnetEl.textContent = online ? 'LAN Subnet #48A' : 'Ad-Hoc Offline QR';
        }

        window.addEventListener('online', updateOnlineStatus);
        window.addEventListener('offline', updateOnlineStatus);
        updateOnlineStatus();
    }

    function showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const toast = document.createElement('div');
        let borderColor = 'var(--border-subtle)';
        let iconColor = '#60a5fa';
        let iconHref = '#icon-bolt';

        if (type === 'success') {
            borderColor = 'var(--accent-emerald-border)';
            iconColor = '#34d399';
            iconHref = '#icon-check';
        } else if (type === 'error') {
            borderColor = 'var(--accent-red-border)';
            iconColor = '#f87171';
            iconHref = '#icon-close';
        }

        toast.className = 'toast-item';
        toast.style.borderColor = borderColor;
        toast.innerHTML = `
            <svg class="icon" style="color:${iconColor}; font-size:14px"><use href="${iconHref}"></use></svg>
            <span>${message}</span>
        `;

        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(8px)';
            toast.style.transition = 'all 0.25s ease';
            setTimeout(() => toast.remove(), 260);
        }, 3200);
    }

    function registerServiceWorker() {
        if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
            navigator.serviceWorker.register('./sw.js').catch(() => {});
        }
    }

    window.convoyApp = {
        switchHubTab,
        toggleShakeMode,
        isShakeModeEnabled,
        triggerInstantShake,
        openSettingsModal,
        closeSettingsModal,
        saveSettings,
        showToast
    };
})();