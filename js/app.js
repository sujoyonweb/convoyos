/**
 * convoyOS v0.0.1 - Main UI Controller
 */
(function () {
    document.addEventListener('DOMContentLoaded', () => {
        applySettingsToHeader();
        window.convoyDragDrop.init();
        window.convoyDiscovery.init();
        window.convoyTransfer.init();
        window.convoyStorage.renderLedgerUI();
        registerServiceWorker();
    });

    function computeCleanInitials(nameStr) {
        const cleaned = String(nameStr || 'Node')
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            .trim();
        const words = cleaned.split(/\s+/).filter(Boolean);
        if (words.length >= 2) {
            return (words[0][0] + words[1][0]).toUpperCase();
        }
        return (words[0] || 'CV').slice(0, 2).toUpperCase();
    }

    function applySettingsToHeader() {
        const settings = window.convoyStorage.getSettings();
        const nameEl = document.getElementById('headerNodeName');
        const badgeEl = document.getElementById('nodeInitialsBadge');
        const inputName = document.getElementById('settingDeviceName');
        const selectAccept = document.getElementById('settingAutoAccept');
        const inputLanIp = document.getElementById('settingLanIp');

        if (nameEl) nameEl.textContent = settings.deviceName;
        if (badgeEl) {
            badgeEl.textContent = computeCleanInitials(settings.deviceName);
        }

        if (inputName) inputName.value = settings.deviceName;
        if (selectAccept) selectAccept.value = settings.autoAccept;
        if (inputLanIp) inputLanIp.value = settings.lanIpOverride || '';
    }

    function switchHubTab(tabName) {
        const tabs = ['nearby', 'pair', 'global'];
        const titles = {
            nearby: 'Nearby Devices',
            pair: 'Pair & Connect',
            global: 'Global Direct Link'
        };

        tabs.forEach((t) => {
            const suffix = t.charAt(0).toUpperCase() + t.slice(1);
            const btn = document.getElementById('tabBtn' + suffix);
            const panel = document.getElementById('tabPanel' + suffix);
            if (btn) btn.classList.toggle('active', t === tabName);
            if (panel) panel.classList.toggle('hidden', t !== tabName);
        });

        const heading = document.getElementById('hubPanelTitle');
        if (heading && titles[tabName]) {
            heading.textContent = titles[tabName];
        }

        if (tabName === 'pair') {
            window.convoyDiscovery.renderPairTabQR();
        } else if (tabName === 'global') {
            window.convoyDiscovery.renderGlobalShareTab();
        }
    }

    function setNetworkBadge(isOnline, statusText) {
        const dot = document.getElementById('networkStatusDot');
        const label = document.getElementById('networkModeLabel');
        if (dot) dot.classList.toggle('offline', !isOnline);
        if (label) label.textContent = statusText;
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
        const lanIpVal = document.getElementById('settingLanIp')?.value.trim() || '';

        window.convoyStorage.saveSettings({
            deviceName: nameVal,
            autoAccept: acceptVal,
            lanIpOverride: lanIpVal
        });

        applySettingsToHeader();
        window.convoyDiscovery.renderPairTabQR();
        window.convoyDiscovery.renderGlobalShareTab();
        window.convoyDiscovery.refreshPeers();
        closeSettingsModal();
        showToast('Preferences saved', 'success');
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
            <svg class="icon" style="color:${iconColor}; font-size:14px; flex-shrink:0"><use href="${iconHref}"></use></svg>
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
        setNetworkBadge,
        openSettingsModal,
        closeSettingsModal,
        saveSettings,
        showToast
    };
})();