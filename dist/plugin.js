// HFS Wake-on-LAN Plugin
// WoL core based on agnat/node_wake_on_lan

exports.version = 1.4;
exports.description = "Wake-on-LAN dashboard — wake and monitor network devices. Authenticated users only.";
exports.apiRequired = 8.65;
exports.author = "Feuerswut";
exports.repo = "Feuerswut/hfs-wake-on-lan";
exports.depend = [{ repo: 'Feuerswut/hfs-tailwind', version: 1000 }]

exports.config = {
    basePath: {
        type: 'string',
        defaultValue: '/~/wake-on-lan',
        label: 'Base Path',
        helperText: 'URL where the dashboard is served. API lives at <basePath>/api/...'
    },
    allowedUsers: {
        type: 'array',
        defaultValue: [],
        label: 'Allowed Users',
        helperText: 'HFS usernames allowed to access the panel. Empty = all authenticated users.',
        fields: {
            username: {
                type: 'string',
                label: 'Username'
            }
        }
    },
    redirectUrl: {
        type: 'string',
        defaultValue: '',
        label: 'Redirect URL on 403/401',
        helperText: 'If set, unauthorized users are redirected here instead of receiving a 403/401.'
    },
    devices: {
        type: 'array',
        defaultValue: [],
        label: 'Devices',
        helperText: 'Devices available in the Wake-on-LAN dashboard.',
        fields: () => ({
            id: {
                label: 'ID',
                type: 'string',
                $width: 0.6,
                $hideUnder: '1500',
            },
            name: {
                label: 'Name',
                type: 'string',
                $width: 0.8,
                helperText: 'Your device\'s name, e.g. "My Workstation"'
            },
            ip: {
                label: 'IP Address (optional)',
                type: 'string',
                $width: 1.0,
                $hideUnder: 'sm',
                helperText: 'Target IP (IPv4 or IPv6) for directed broadcast/ping.'
            },
            mac: {
                label: 'MAC Address (required)',
                type: 'string',
                $width: 1.2,
                helperText: 'e.g. AA:BB:CC:DD:EE:FF'
            },
            port: {
                label: 'WoL Port',
                type: 'number',
                defaultValue: 9,
                $width: 0.4,
                $hideUnder: 500,
                helperText: 'UDP port for the magic packet (usually 7 or 9)'
            },
            pingPort: {
                label: 'Ping Port',
                type: 'number',
                $width: 0.4,
                $hideUnder: 700,
                helperText: 'TCP port to probe for online check (e.g. 80, 22, 445).'
            },
            password: {
                label: 'SecureOn',
                type: 'string',
                $hideUnder: true,
                helperText: '6-byte hex SecureOn password, e.g. AABBCCDDEEFF (optional)'
            }
        })
    }
};

exports.configDialog = {
    maxWidth: 1000
};

exports.changelog = [
    { version: 1.3, message: "IPv6 support, payload size cap, input validation" },
    { version: 1.2, message: "ICMP ping via OS ping command (primary); TCP port probe is secondary/optional badge" },
    { version: 1.1, message: "Add/remove devices via dashboard (persisted in plugin config); ping only shown when IP is set; online status fixed" },
    { version: 1.0, message: "Initial release" }
];

// ── Dependencies ──────────────────────────────────────────────────────────
const dgram  = require('dgram');
const net    = require('net');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { Buffer } = require('buffer');

const allocBuf = Buffer.alloc
    ? n => Buffer.alloc(n)
    : n => new Buffer(n); // eslint-disable-line no-buffer-constructor

const MAX_DEVICES  = 50;
const MAX_NAME_LEN = 50;

// ── Helpers ───────────────────────────────────────────────────────────────

function generateUUID() {
    return crypto.randomUUID
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
}

// Accept IPv4 or IPv6; returns the trimmed string or null.
// Uses Node's net module — authoritative, no regex edge cases.
function parseIP(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (net.isIPv4(s) || net.isIPv6(s)) return s;
    return null;
}

// ── WoL core (agnat/node_wake_on_lan) ────────────────────────────────────
const MAC_BYTES = 6;

function createMagicPacket(mac) {
    const clean = mac.replace(/[:\-]/g, '');
    if (clean.length !== 2 * MAC_BYTES || !/^[0-9A-Fa-f]{12}$/.test(clean)) {
        throw new Error(`Malformed MAC address: '${mac}'`);
    }
    const macBuf = allocBuf(MAC_BYTES);
    for (let i = 0; i < MAC_BYTES; i++) {
        macBuf[i] = parseInt(clean.substring(2 * i, 2 * i + 2), 16);
    }
    const NUM_MACS = 16;
    const pkt = allocBuf((1 + NUM_MACS) * MAC_BYTES);
    for (let i = 0; i < MAC_BYTES; i++) pkt[i] = 0xff;
    for (let i = 0; i < NUM_MACS; i++) macBuf.copy(pkt, (i + 1) * MAC_BYTES);
    return pkt;
}

function wake(mac, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    opts = opts || {};

    const address    = opts.address     || '255.255.255.255';
    const numPackets = opts.num_packets || 3;
    const interval   = opts.interval    || 100;
    const port       = opts.port        || 9;
    const password   = opts.password;

    let pkt = createMagicPacket(mac);

    if (password) {
        const pwdClean = password.replace(/[:\-]/g, '');
        if (/^[0-9A-Fa-f]{12}$/.test(pwdClean)) {
            const pwdBuf = allocBuf(MAC_BYTES);
            for (let i = 0; i < MAC_BYTES; i++) {
                pwdBuf[i] = parseInt(pwdClean.substring(2 * i, 2 * i + 2), 16);
            }
            pkt = Buffer.concat([pkt, pwdBuf]);
        }
    }

    const socket = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4');
    let i = 0;
    let timerId;

    function postWrite(err) {
        if (err || i === numPackets) {
            try { socket.close(); } catch (ex) { err = err || ex; }
            if (timerId) clearTimeout(timerId);
            if (callback) callback(err);
        }
    }

    socket.on('error', postWrite);
    socket.once('listening', () => socket.setBroadcast(true));

    function send() {
        i++;
        socket.send(pkt, 0, pkt.length, port, address, postWrite);
        if (i < numPackets) timerId = setTimeout(send, interval);
        else timerId = undefined;
    }

    send();
}

// ── ICMP ping via OS ping command ─────────────────────────────────────────
// _spawn is assigned in exports.init once api.require() is available.
let _spawn = null;

function icmpPing(ip, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        if (!_spawn) return reject(new Error('spawn not initialised'));

        const safeIp = parseIP(ip);
        if (!safeIp) return reject(new Error('Invalid IP address'));

        const isV6        = net.isIPv6(safeIp);
        const timeoutSecs = String(Math.max(1, Math.ceil(timeoutMs / 1000)));

        // IP is a plain array element — never shell-interpolated. shell: false (default).
        let args;
        if (process.platform === 'win32') {
            args = ['-n', '1', '-w', String(timeoutMs), safeIp];
        } else if (isV6) {
            // Modern Linux 'ping' supports -6; avoids reliance on 'ping6' which is
            // absent on most distros since ~2018.
            args = ['-6', '-c', '1', '-W', timeoutSecs, safeIp];
        } else {
            args = ['-c', '1', '-W', timeoutSecs, safeIp];
        }

        const proc = _spawn('ping', args, { shell: false });

        let finished = false;
        const finish = ok => { if (!finished) { finished = true; resolve(ok); } };
        proc.on('close', code => finish(code === 0));
        proc.on('error', err  => { if (!finished) { finished = true; reject(err); } });
        setTimeout(() => {
            if (!finished) { finished = true; try { proc.kill(); } catch (_) {} resolve(false); }
        }, timeoutMs + 1000);
    });
}

// ── TCP port probe ────────────────────────────────────────────────────────
function probePort(host, port, timeoutMs = 1500) {
    return new Promise(resolve => {
        if (!parseIP(host)) return resolve(false);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return resolve(false);

        const s = new net.Socket();
        let done = false;
        const finish = ok => { if (!done) { done = true; s.destroy(); resolve(ok); } };
        s.setTimeout(timeoutMs);
        s.once('connect', () => finish(true));
        s.once('timeout', () => finish(false));
        s.once('error',   () => finish(false));
        s.connect(port, host);
    });
}

// ── Ping a device ─────────────────────────────────────────────────────────
// ICMP is the primary online signal; TCP port probe is optional/secondary.
// Either being reachable counts as online.
async function pingDevice(ip, customPort) {
    const safeIp = parseIP(ip);
    if (!safeIp) throw new Error('Invalid IP address');

    const [icmpOnline, tcpResult] = await Promise.all([
        icmpPing(safeIp).catch(() => false),
        customPort
            ? probePort(safeIp, customPort)
                .then(open => ({ port: customPort, open }))
                .catch(() => ({ port: customPort, open: false }))
            : Promise.resolve(null),
    ]);

    const ports  = tcpResult ? [tcpResult] : [];
    const online = icmpOnline || ports.some(p => p.open);
    return { online, ports };
}

// ── Static file helper ────────────────────────────────────────────────────
function serveStatic(ctx, filePath) {
    try {
        const full     = filePath || path.join(__dirname, 'public', 'index.html');
        const resolved = path.resolve(full);

        // Prevent directory traversal — resolved path must stay inside plugin dir
        if (!resolved.startsWith(path.resolve(__dirname) + path.sep) &&
             resolved !== path.resolve(__dirname)) {
            ctx.status = 403; ctx.type = 'text/plain'; ctx.body = 'Forbidden'; ctx.stop(); return;
        }

        if (!fs.existsSync(resolved)) {
            ctx.status = 404; ctx.type = 'text/plain'; ctx.body = 'Not found'; ctx.stop(); return;
        }

        const types = {
            '.html': 'text/html; charset=utf-8', '.css': 'text/css',
            '.js':   'application/javascript',   '.json': 'application/json',
            '.png':  'image/png',                 '.svg':  'image/svg+xml',
            '.jpg':  'image/jpeg',                '.jpeg': 'image/jpeg',
        };
        ctx.type = types[path.extname(resolved)] || 'text/plain';
        ctx.set('Cache-Control', 'no-cache');
        ctx.body = ctx.type.startsWith('image/') ? fs.createReadStream(resolved) : fs.readFileSync(resolved, 'utf8');
        ctx.stop();
    } catch (err) {
        ctx.status = 500; ctx.type = 'text/plain'; ctx.body = 'Error: ' + err.message; ctx.stop();
    }
}

// ── Body reader ───────────────────────────────────────────────────────────
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => {
            data += c;
            if (data.length > 10_000) { req.destroy(); reject(new Error('Payload too large')); }
        });
        req.on('end',   () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
        req.on('error', reject);
    });
}

// ── JSON helpers ──────────────────────────────────────────────────────────
function jsonOk(ctx, payload)      { ctx.type = 'application/json'; ctx.set('Cache-Control', 'no-cache'); ctx.body = JSON.stringify(payload); ctx.stop(); }
function jsonErr(ctx, status, msg) { ctx.status = status; ctx.type = 'application/json'; ctx.body = JSON.stringify({ success: false, error: msg }); ctx.stop(); }

// ── Plugin init ───────────────────────────────────────────────────────────
exports.init = async api => {

    const { getCurrentUsername } = api.require('./auth');
    _spawn = api.require('child_process').spawn;
    return { middleware };

    async function middleware(ctx) {
        const base = (api.getConfig('basePath') || '/~/wake-on-lan').replace(/\/+$/, '');
        const url  = ctx.req.url.split('?')[0];

        if (url !== base && !url.startsWith(base + '/')) return;

        // ── Auth ──────────────────────────────────────────────────────────
        const username = getCurrentUsername(ctx);
        if (!username) return deny(ctx, api, 401, 'Authentication required');
        const allowed = (api.getConfig('allowedUsers') || []).map(u => u.username).filter(Boolean);
        if (allowed.length > 0 && !allowed.includes(username)) return deny(ctx, api, 403, 'Access denied');

        const sub = url.slice(base.length);

        // ── GET /api/tailwind.js ──────────────────────────────────────────
        if (sub === '/api/tailwind.js') {
            ctx.type = 'application/javascript';
            ctx.set('Cache-Control', 'public, max-age=86400');
            ctx.body = fs.createReadStream(api.customApiCall('tailwind')[0].path);
            ctx.stop();
            return;
        }

        // ── GET /api/devices ──────────────────────────────────────────────
        if (sub === '/api/devices' && ctx.req.method === 'GET') {
            return jsonOk(ctx, { success: true, devices: api.getConfig('devices') || [] });
        }

        // ── POST /api/devices ─────────────────────────────────────────────
        if (sub === '/api/devices' && ctx.req.method === 'POST') {
            try {
                const { name, ip, mac, port, pingPort, password } = await readBody(ctx.req);

                // Validate name on raw input — before any transformation
                const rawName = String(name || '').trim();
                if (!rawName)                       return jsonErr(ctx, 400, 'name is required');
                if (rawName.length > MAX_NAME_LEN)  return jsonErr(ctx, 400, `name must be ${MAX_NAME_LEN} characters or fewer`);

                if (!mac) return jsonErr(ctx, 400, 'mac is required');
                const cleanMac = String(mac).replace(/[:\-]/g, '');
                if (!/^[0-9A-Fa-f]{12}$/.test(cleanMac)) return jsonErr(ctx, 400, 'Invalid MAC address');

                const currentDevices = api.getConfig('devices') || [];
                if (currentDevices.length >= MAX_DEVICES) return jsonErr(ctx, 400, `Device limit of ${MAX_DEVICES} reached`);

                const safeIp  = ip ? parseIP(String(ip).trim()) : null;
                const wolPort = port     ? parseInt(port)     : 9;
                const tcpPort = pingPort ? parseInt(pingPort) : undefined;

                if (port     && (!Number.isInteger(wolPort) || wolPort < 1 || wolPort > 65535))
                    return jsonErr(ctx, 400, 'Invalid WoL port');
                if (pingPort && (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535))
                    return jsonErr(ctx, 400, 'Invalid ping port');

                const device = {
                    id:   generateUUID(),
                    name: rawName,          // plain text; frontend escapes for HTML
                    ip:   safeIp || '',
                    mac:  String(mac).trim(),
                    port: wolPort,
                    ...(tcpPort  ? { pingPort: tcpPort }               : {}),
                    ...(password ? { password: String(password).trim() } : {}),
                };

                const devices = [...currentDevices, device];
                await api.setConfig('devices', devices);
                return jsonOk(ctx, { success: true, devices });
            } catch (err) {
                return jsonErr(ctx, 500, err.message);
            }
        }

        // ── DELETE /api/devices/:id ───────────────────────────────────────
        // Primary: UUID. Fallback: integer index for pre-v1.3 devices with no id.
        const deleteMatch = sub.match(/^\/api\/devices\/(.+)$/);
        if (deleteMatch && ctx.req.method === 'DELETE') {
            try {
                const idParam = deleteMatch[1];
                const devices = [...(api.getConfig('devices') || [])];

                let idx = devices.findIndex(d => d.id === idParam);

                if (idx === -1 && /^\d+$/.test(idParam)) {
                    const intIdx = parseInt(idParam);
                    if (intIdx >= 0 && intIdx < devices.length && !devices[intIdx].id) {
                        idx = intIdx;
                    }
                }

                if (idx === -1) return jsonErr(ctx, 404, 'Device not found');
                devices.splice(idx, 1);
                await api.setConfig('devices', devices);
                return jsonOk(ctx, { success: true, devices });
            } catch (err) {
                return jsonErr(ctx, 500, err.message);
            }
        }

        // ── POST /api/wake ────────────────────────────────────────────────
        if (sub === '/api/wake' && ctx.req.method === 'POST') {
            try {
                const { mac, ip, port, password } = await readBody(ctx.req);
                if (!mac) return jsonErr(ctx, 400, 'mac is required');

                const targetIp = (ip && parseIP(String(ip))) || '255.255.255.255';
                const wolPort  = (port && Number.isInteger(parseInt(port))) ? parseInt(port) : 9;

                await new Promise((resolve, reject) =>
                    wake(mac, { address: targetIp, port: wolPort, password }, err => err ? reject(err) : resolve())
                );
                return jsonOk(ctx, { success: true, message: `Magic packet sent to ${mac}` });
            } catch (err) {
                return jsonErr(ctx, 400, err.message);
            }
        }

        // ── POST /api/ping ────────────────────────────────────────────────
        if (sub === '/api/ping' && ctx.req.method === 'POST') {
            try {
                const { ip, port } = await readBody(ctx.req);
                if (!ip) return jsonErr(ctx, 400, 'ip is required');
                const tcpPort = port ? parseInt(port) : undefined;
                const result  = await pingDevice(String(ip), tcpPort);
                return jsonOk(ctx, { success: true, ...result });
            } catch (err) {
                return jsonErr(ctx, 500, err.message);
            }
        }

        // ── Static files ──────────────────────────────────────────────────
        if (sub === '' || sub === '/') return serveStatic(ctx);

        if (sub.startsWith('/') && !sub.startsWith('/api/')) {
            const rel        = sub.slice(1);
            const fromPublic = path.join(__dirname, 'public', rel);
            const fromRoot   = path.join(__dirname, rel);
            const filePath   = fs.existsSync(fromPublic) ? fromPublic : fromRoot;
            return serveStatic(ctx, filePath);
        }
    }
};

function deny(ctx, api, status, message) {
    const redirect = api.getConfig('redirectUrl');
    if (redirect) {
        ctx.status = 302;
        ctx.set('Location', redirect);
        ctx.body = '';
    } else {
        ctx.status = status;
        ctx.type   = 'application/json';
        ctx.body   = JSON.stringify({ error: message });
    }
    ctx.stop();
}
