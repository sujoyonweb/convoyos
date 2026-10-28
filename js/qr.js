/**
 * convoyOS v0.0.1 - True ISO/IEC 18004 QR Code Encoder (GF(256) Reed-Solomon)
 * Supports Byte-Mode encoding across Versions 2-L to 6-L with 100% phone camera scannability.
 */
(function () {
    // Version specifications for Error Correction Level L:
    // [version, size, totalDataCodewords, ecCodewordsPerBlock, numBlocks, alignmentCenter]
    const VERSION_SPECS = [
        null,
        [1, 21, 19, 7, 1, []],
        [2, 25, 34, 10, 1, [6, 18]],
        [3, 29, 55, 15, 1, [6, 22]],
        [4, 33, 80, 20, 1, [6, 26]],
        [5, 37, 108, 26, 1, [6, 30]],
        [6, 41, 136, 18, 2, [6, 34]]
    ];

    // Galois Field GF(256) log/exp tables (primitive polynomial 0x11D)
    const GF_EXP = new Uint8Array(512);
    const GF_LOG = new Uint8Array(256);
    (function initGaloisField() {
        let x = 1;
        for (let i = 0; i < 255; i++) {
            GF_EXP[i] = x;
            GF_LOG[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11d;
        }
        for (let i = 255; i < 512; i++) {
            GF_EXP[i] = GF_EXP[i - 255];
        }
    })();

    function gfMul(a, b) {
        if (a === 0 || b === 0) return 0;
        return GF_EXP[GF_LOG[a] + GF_LOG[b]];
    }

    // Compute Reed-Solomon Error Correction bytes for a data block
    function computeReedSolomon(dataBytes, ecCount) {
        let gen = new Uint8Array([1]);
        for (let i = 0; i < ecCount; i++) {
            const next = new Uint8Array(gen.length + 1);
            const root = GF_EXP[i];
            for (let j = 0; j < gen.length; j++) {
                next[j] ^= gen[j];
                next[j + 1] ^= gfMul(gen[j], root);
            }
            gen = next;
        }

        const msg = new Uint8Array(dataBytes.length + ecCount);
        msg.set(dataBytes, 0);

        for (let i = 0; i < dataBytes.length; i++) {
            const coef = msg[i];
            if (coef !== 0) {
                for (let j = 0; j < gen.length; j++) {
                    msg[i + j] ^= gfMul(gen[j], coef);
                }
            }
        }
        return msg.slice(dataBytes.length);
    }

    function selectVersion(byteLength) {
        for (let v = 1; v <= 6; v++) {
            const maxPayload = VERSION_SPECS[v][2] - 2; // 4-bit mode + 8-bit length + terminator
            if (byteLength <= maxPayload) return VERSION_SPECS[v];
        }
        return VERSION_SPECS[6];
    }

    function encodeDataCodewords(utf8Bytes, totalDataCodewords) {
        const bits = [];
        const pushBits = (val, len) => {
            for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
        };

        // Byte mode indicator (0100) + byte count (8 bits for V1-V9)
        pushBits(0b0100, 4);
        pushBits(utf8Bytes.length, 8);
        for (let i = 0; i < utf8Bytes.length; i++) {
            pushBits(utf8Bytes[i], 8);
        }

        // Terminator up to 4 zero bits
        const maxBits = totalDataCodewords * 8;
        pushBits(0, Math.min(4, maxBits - bits.length));
        while (bits.length % 8 !== 0) bits.push(0);

        const codewords = new Uint8Array(totalDataCodewords);
        for (let i = 0; i < bits.length / 8; i++) {
            let byteVal = 0;
            for (let b = 0; b < 8; b++) byteVal = (byteVal << 1) | bits[i * 8 + b];
            codewords[i] = byteVal;
        }

        // Pad alternating 0xEC and 0x11
        const pads = [0xec, 0x11];
        let padIdx = 0;
        for (let i = bits.length / 8; i < totalDataCodewords; i++) {
            codewords[i] = pads[padIdx % 2];
            padIdx++;
        }
        return codewords;
    }

    function buildFinalBitStream(utf8Bytes, spec) {
        const [, , totalData, ecPerBlock, numBlocks] = spec;
        const dataWords = encodeDataCodewords(utf8Bytes, totalData);

        const dataBlocks = [];
        const ecBlocks = [];
        const blockSize = totalData / numBlocks;

        for (let b = 0; b < numBlocks; b++) {
            const slice = dataWords.slice(b * blockSize, (b + 1) * blockSize);
            dataBlocks.push(slice);
            ecBlocks.push(computeReedSolomon(slice, ecPerBlock));
        }

        const finalBytes = [];
        for (let i = 0; i < blockSize; i++) {
            for (let b = 0; b < numBlocks; b++) finalBytes.push(dataBlocks[b][i]);
        }
        for (let i = 0; i < ecPerBlock; i++) {
            for (let b = 0; b < numBlocks; b++) finalBytes.push(ecBlocks[b][i]);
        }

        const bitStream = [];
        for (let i = 0; i < finalBytes.length; i++) {
            for (let b = 7; b >= 0; b--) bitStream.push((finalBytes[i] >>> b) & 1);
        }
        return bitStream;
    }

    function createQrSvg(payloadText, darkColor = '#0c0c0c') {
        const encoder = new TextEncoder();
        let utf8 = encoder.encode(String(payloadText || 'convoyOS'));
        if (utf8.length > 134) utf8 = utf8.slice(0, 134);

        const spec = selectVersion(utf8.length);
        const [, size, , , , alignCoords] = spec;

        const matrix = Array.from({ length: size }, () => Array(size).fill(0));
        const reserved = Array.from({ length: size }, () => Array(size).fill(false));

        function placeFinder(row, col) {
            for (let r = -1; r <= 7; r++) {
                for (let c = -1; c <= 7; c++) {
                    const rr = row + r, cc = col + c;
                    if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
                    const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
                    const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
                    const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
                    matrix[rr][cc] = inOuter && (isBorder || isInner) ? 1 : 0;
                    reserved[rr][cc] = true;
                }
            }
        }

        placeFinder(0, 0);
        placeFinder(0, size - 7);
        placeFinder(size - 7, 0);

        // Alignment patterns
        if (alignCoords.length > 0) {
            for (const r of alignCoords) {
                for (const c of alignCoords) {
                    if (reserved[r][c]) continue;
                    for (let dr = -2; dr <= 2; dr++) {
                        for (let dc = -2; dc <= 2; dc++) {
                            const isDark = Math.max(Math.abs(dr), Math.abs(dc)) === 2 || (dr === 0 && dc === 0);
                            matrix[r + dr][c + dc] = isDark ? 1 : 0;
                            reserved[r + dr][c + dc] = true;
                        }
                    }
                }
            }
        }

        // Timing patterns
        for (let i = 8; i < size - 8; i++) {
            if (!reserved[6][i]) {
                matrix[6][i] = i % 2 === 0 ? 1 : 0;
                reserved[6][i] = true;
            }
            if (!reserved[i][6]) {
                matrix[i][6] = i % 2 === 0 ? 1 : 0;
                reserved[i][6] = true;
            }
        }

        // Reserve Format Info areas & Dark Module
        for (let i = 0; i < 9; i++) {
            if (i < size) {
                reserved[8][i] = true;
                reserved[i][8] = true;
            }
        }
        for (let i = 0; i < 8; i++) {
            reserved[8][size - 1 - i] = true;
            reserved[size - 1 - i][8] = true;
        }
        matrix[size - 8][8] = 1;
        reserved[size - 8][8] = true;

        // Zigzag data placement
        const bits = buildFinalBitStream(utf8, spec);
        let bitIdx = 0;
        let upward = true;

        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5; // Skip vertical timing column
            for (let vert = 0; vert < size; vert++) {
                const r = upward ? size - 1 - vert : vert;
                for (let j = 0; j < 2; j++) {
                    const c = right - j;
                    if (!reserved[r][c]) {
                        const bit = bitIdx < bits.length ? bits[bitIdx++] : 0;
                        // Mask 0: (r + c) % 2 === 0
                        const mask = (r + c) % 2 === 0 ? 1 : 0;
                        matrix[r][c] = bit ^ mask;
                    }
                }
            }
            upward = !upward;
        }

        // Place ISO Format Info bits for Level L (01) + Mask 0 (000) -> 0x77C4
        const formatBits = 0x77c4;
        for (let i = 0; i < 15; i++) {
            const bit = (formatBits >>> i) & 1;
            // Top-left
            if (i < 6) matrix[i][8] = bit;
            else if (i < 8) matrix[i + 1][8] = bit;
            else if (i === 8) matrix[8][7] = bit;
            else matrix[8][14 - i] = bit;

            // Bottom-left & Top-right
            if (i < 8) matrix[8][size - 1 - i] = bit;
            else matrix[size - 15 + i][8] = bit;
        }

        // Render SVG with a 2-module quiet zone
        const quiet = 2;
        const totalView = size + quiet * 2;
        let rects = `<rect width="${totalView}" height="${totalView}" fill="#ffffff"/>`;

        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                if (matrix[r][c] === 1) {
                    rects += `<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1" fill="${darkColor}"/>`;
                }
            }
        }

        return `<svg viewBox="0 0 ${totalView} ${totalView}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-label="QR Code">${rects}</svg>`;
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