// HFS Wake-on-LAN Plugin
// WoL core based on agnat/node_wake_on_lan

exports.version = 1.2;
exports.description = "Wake-on-LAN dashboard — wake and monitor network devices. Authenticated users only.";
exports.apiRequired = 8.65;
exports.author = "Feuerswut";
exports.repo = "Feuerswut/hfs-wake-on-lan";

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
                helperText: 'Target IP for directed broadcast, e.g. 192.168.1.10'
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
                helperText: 'TCP port to probe for online check (e.g. 80, 22, 445). Required to detect online status.'
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
}

exports.changelog = [
    { version: 1.2, message: "ICMP ping via OS ping command (primary); TCP port probe is secondary/optional badge" },
    { version: 1.1, message: "Add/remove devices via dashboard (persisted in plugin config); ping only shown when IP is set; online status fixed" },
    { version: 1.0, message: "Initial release" }
];

// ── Dependencies ──────────────────────────────────────────────────────────
const dgram  = require('dgram');
const net    = require('net');
const path   = require('path');
const fs     = require('fs');
const { Buffer } = require('buffer');

const allocBuf = Buffer.alloc
    ? n => Buffer.alloc(n)
    : n => new Buffer(n); // eslint-disable-line no-buffer-constructor

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

// ── IP validation ─────────────────────────────────────────────────────────
// Must pass before the IP is used in spawn() or any network call.
function parseIPv4(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s)) return null;
    if (s.split('.').some(n => parseInt(n, 10) > 255)) return null;
    return s; // validated, trimmed string safe to pass to spawn/net
}

// ── ICMP ping via OS ping command ─────────────────────────────────────────
// _spawn is assigned in exports.init once api.require() is available.
let _spawn = null;

function icmpPing(ip, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        if (!_spawn) return reject(new Error('spawn not initialised'));
        const safeIp = parseIPv4(ip);
        if (!safeIp) return reject(new Error('Invalid IP address'));

        // IP is an element of an args array — never part of a shell string.
        // shell: false (the default) means no shell is spawned at all.
        const timeoutSecs = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
        const proc = _spawn('ping', ['-c', '1', '-W', timeoutSecs, safeIp], { shell: false });

        let finished = false;
        const finish = ok => { if (!finished) { finished = true; resolve(ok); } };
        proc.on('close', code => finish(code === 0));
        proc.on('error', err  => { if (!finished) { finished = true; reject(err); } });
        // Hard timeout — kill the process if it somehow hangs past our window
        setTimeout(() => {
            if (!finished) { finished = true; try { proc.kill(); } catch (_) {} resolve(false); }
        }, timeoutMs + 1000);
    });
}

// ── TCP port probe ────────────────────────────────────────────────────────
function probePort(host, port, timeoutMs = 1500) {
    return new Promise(resolve => {
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
// Strategy:
//   1. ICMP ping — works on any live host regardless of open ports.
//   2. If a pingPort is configured, also probe that TCP port in parallel.
//      The TCP result appears as a port badge; ICMP is the primary online signal.
//      Either one being reachable counts as online.
async function pingDevice(ip, customPort) {
    const safeIp = parseIPv4(ip);
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
        const full = filePath || path.join(__dirname, 'public', 'index.html');
        if (!fs.existsSync(full)) {
            ctx.status = 404; ctx.type = 'text/plain'; ctx.body = 'Not found'; ctx.stop(); return;
        }
        const types = {
            '.html': 'text/html; charset=utf-8', '.css': 'text/css',
            '.js':   'application/javascript',   '.json': 'application/json',
            '.png':  'image/png',                 '.svg':  'image/svg+xml',
            '.jpg':  'image/jpeg',                '.jpeg': 'image/jpeg',
        };
        ctx.type = types[path.extname(full)] || 'text/plain';
        ctx.set('Cache-Control', 'no-cache');
        ctx.body = ctx.type.startsWith('image/') ? fs.createReadStream(full) : fs.readFileSync(full, 'utf8');
        ctx.stop();
    } catch (err) {
        ctx.status = 500; ctx.type = 'text/plain'; ctx.body = 'Error: ' + err.message; ctx.stop();
    }
}

// ── Body reader ───────────────────────────────────────────────────────────
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => { data += c; });
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
        req.on('error', reject);
    });
}

// ── JSON helpers ──────────────────────────────────────────────────────────
function jsonOk(ctx, payload)  { ctx.type = 'application/json'; ctx.set('Cache-Control','no-cache'); ctx.body = JSON.stringify(payload); ctx.stop(); }
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

        // ── Auth check ────────────────────────────────────────────────────
        const username = getCurrentUsername(ctx);
        if (!username) return deny(ctx, api, 401, 'Authentication required');
        const allowed = (api.getConfig('allowedUsers') || []).map(u => u.username).filter(Boolean);
        if (allowed.length > 0 && !allowed.includes(username)) return deny(ctx, api, 403, 'Access denied');

        const sub = url.slice(base.length);

        // ── API routes ────────────────────────────────────────────────────

        // GET /api/devices
        if (sub === '/api/devices' && ctx.req.method === 'GET') {
            return jsonOk(ctx, { success: true, devices: api.getConfig('devices') || [] });
        }

        // POST /api/devices — add device, persisted in plugin config
        if (sub === '/api/devices' && ctx.req.method === 'POST') {
            try {
                const { name, ip, mac, port, pingPort, password } = await readBody(ctx.req);
                if (!name || !mac) return jsonErr(ctx, 400, 'name and mac are required');
                const clean = mac.replace(/[:\-]/g, '');
                if (!/^[0-9A-Fa-f]{12}$/.test(clean)) return jsonErr(ctx, 400, 'Invalid MAC address');

                const devices = [...(api.getConfig('devices') || [])];
                const device = {
                    name: String(name).trim(),
                    ip: ip ? String(ip).trim() : '',
                    mac: String(mac).trim(),
                    port: port ? parseInt(port) : 9,
                    ...(pingPort ? { pingPort: parseInt(pingPort) } : {}),
                    ...(password ? { password: String(password).trim() } : {}),
                };
                devices.push(device);
                await api.setConfig('devices', devices);
                return jsonOk(ctx, { success: true, devices });
            } catch (err) {
                return jsonErr(ctx, 500, err.message);
            }
        }

        // DELETE /api/devices/:index — remove device by index, persisted in plugin config
        const deleteMatch = sub.match(/^\/api\/devices\/(\d+)$/);
        if (deleteMatch && ctx.req.method === 'DELETE') {
            try {
                const idx = parseInt(deleteMatch[1]);
                const devices = [...(api.getConfig('devices') || [])];
                if (idx < 0 || idx >= devices.length) return jsonErr(ctx, 404, 'Device not found');
                devices.splice(idx, 1);
                await api.setConfig('devices', devices);
                return jsonOk(ctx, { success: true, devices });
            } catch (err) {
                return jsonErr(ctx, 500, err.message);
            }
        }

        // POST /api/wake
        if (sub === '/api/wake' && ctx.req.method === 'POST') {
            try {
                const { mac, ip, port, password } = await readBody(ctx.req);
                if (!mac) return jsonErr(ctx, 400, 'mac is required');
                await new Promise((resolve, reject) =>
                    wake(mac, { address: ip || '255.255.255.255', port: port || 9, password }, err => err ? reject(err) : resolve())
                );
                return jsonOk(ctx, { success: true, message: `Magic packet sent to ${mac}` });
            } catch (err) {
                return jsonErr(ctx, 400, err.message);
            }
        }

        // POST /api/ping
        if (sub === '/api/ping' && ctx.req.method === 'POST') {
            try {
                const { ip, port } = await readBody(ctx.req);
                if (!ip) return jsonErr(ctx, 400, 'ip is required');
                const result = await pingDevice(ip, port ? parseInt(port) : undefined);
                return jsonOk(ctx, { success: true, ...result });
            } catch (err) {
                return jsonErr(ctx, 500, err.message);
            }
        }

        // ── Static file serving ───────────────────────────────────────────
        if (sub === '' || sub === '/') return serveStatic(ctx);

        if (sub.startsWith('/') && !sub.startsWith('/api/')) {
            const rel = sub.slice(1);
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
