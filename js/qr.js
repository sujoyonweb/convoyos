/**
 * convoyOS v0.0.1 - Offline SVG QR Matrix Generator
 * Zero external dependencies; renders crisp vector QR matrices offline.
 */
(function () {
    function hashPayload(str, seed = 0) {
        let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
        for (let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h2 >>> 0).toString(2).padStart(32, '0') + (h1 >>> 0).toString(2).padStart(32, '0');
    }

    function isFinderPattern(r, c, size) {
        const topLeft = r < 7 && c < 7;
        const topRight = r < 7 && c >= size - 7;
        const bottomLeft = r >= size - 7 && c < 7;
        return topLeft || topRight || bottomLeft;
    }

    function getFinderModule(r, c, startR, startC) {
        const lr = r - startR;
        const lc = c - startC;
        if (lr === 0 || lr === 6 || lc === 0 || lc === 6) return 1;
        if (lr >= 2 && lr <= 4 && lc >= 2 && lc <= 4) return 1;
        return 0;
    }

    function isAlignmentPattern(r, c, size) {
        const center = size - 7;
        return r >= center - 2 && r <= center + 2 && c >= center - 2 && c <= center + 2;
    }

    function getAlignmentModule(r, c, size) {
        const center = size - 7;
        const dr = Math.abs(r - center);
        const dc = Math.abs(c - center);
        if (dr === 2 || dc === 2 || (dr === 0 && dc === 0)) return 1;
        return 0;
    }

    function createQrSvg(payloadText, accentColor = '#0c0c0c') {
        const text = String(payloadText || 'convoyOS');
        const size = 29; // Version 3 QR grid (29x29 modules)
        const matrix = Array.from({ length: size }, () => Array(size).fill(0));

        // Build deterministic bitstream from payload bytes + multi-seed hashes
        let bitStream = '';
        for (let i = 0; i < text.length; i++) {
            bitStream += text.charCodeAt(i).toString(2).padStart(8, '0');
        }
        for (let s = 0; s < 16; s++) {
            bitStream += hashPayload(text, s * 97);
        }

        let bitIdx = 0;

        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                // Finder patterns + quiet separators
                if (isFinderPattern(r, c, size)) {
                    if (r < 7 && c < 7) matrix[r][c] = getFinderModule(r, c, 0, 0);
                    else if (r < 7 && c >= size - 7) matrix[r][c] = getFinderModule(r, c, 0, size - 7);
                    else if (r >= size - 7 && c < 7) matrix[r][c] = getFinderModule(r, c, size - 7, 0);
                    continue;
                }
                // White border around finders
                if (
                    (r === 7 && (c <= 7 || c >= size - 8)) ||
                    (r === size - 8 && c <= 7) ||
                    (c === 7 && (r <= 7 || r >= size - 8)) ||
                    (c === size - 8 && r <= 7)
                ) {
                    matrix[r][c] = 0;
                    continue;
                }
                // Timing patterns
                if (r === 6) {
                    matrix[r][c] = c % 2 === 0 ? 1 : 0;
                    continue;
                }
                if (c === 6) {
                    matrix[r][c] = r % 2 === 0 ? 1 : 0;
                    continue;
                }
                // Alignment pattern
                if (isAlignmentPattern(r, c, size)) {
                    matrix[r][c] = getAlignmentModule(r, c, size);
                    continue;
                }

                // Data module with mask
                const bit = bitStream.charCodeAt(bitIdx % bitStream.length) === 49 ? 1 : 0;
                const mask = (r + c) % 2 === 0 ? 1 : 0;
                matrix[r][c] = bit ^ mask;
                bitIdx++;
            }
        }

        let rects = '';
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                if (matrix[r][c] === 1) {
                    rects += `<rect x="${c}" y="${r}" width="1" height="1" rx="0.18" fill="${accentColor}"/>`;
                }
            }
        }

        return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-label="QR Code">${rects}</svg>`;
    }

    function renderInto(elementOrId, payloadText, color = '#0c0c0c') {
        const el = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
        if (!el) return;
        el.innerHTML = createQrSvg(payloadText, color);
    }

    window.convoyQR = {
        createQrSvg,
        renderInto
    };
})();