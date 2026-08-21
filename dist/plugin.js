// HFS Wake-on-LAN Plugin
// WoL core based on agnat/node_wake_on_lan

exports.version = 2.1;
exports.description = "Wake-on-LAN dashboard — wake and monitor network devices. Authenticated users only.";
exports.apiRequired = 13;
exports.author = "feuerswut";
exports.repo = "feuerswut/hfs-wake-on-lan";
exports.depend = [{ repo: "feuerswut/hfs-shared" }]

exports.config = {
    pathAlias: {
        type: 'string',
        defaultValue: '/~/wake-on-lan',
        label: 'Path alias (redirect)',
        helperText: 'Old URL that should redirect here. Leave empty for none.'
    },
    useCustomFrontend: {
        type: 'boolean',
        defaultValue: false,
        label: 'Use custom frontend',
        helperText: "Serve dashboard files from this plugin's storage/custom-frontend folder instead of the built-in ones."
    },
    allowedUsers: {
        type: 'array',
        defaultValue: [],
        label: 'Allowed Users',
        helperText: 'HFS usernames allowed to access the panel. Empty = all authenticated users.',
        fields: {
            username: {
                type: 'username',
                label: 'Username'
            }
        }
    },
    wol_enableLogging: {
        type: 'boolean', label: 'Enable Logging', defaultValue: true,
        helperText: 'Log wake requests and device add/remove.',
    },
    wol_verboseLogging: {
        type: 'boolean', label: 'Verbose Logging', defaultValue: false,
        helperText: 'Log every event immediately instead of batching.',
        showIf: v => v.wol_enableLogging,
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
    { version: 2.1, message: "The dashboard's body content -- device list, add-device form, buttons -- now carries Tailwind utility classes alongside its existing Sass ones, loaded through the /api/tailwind.js passthrough already in this file. The header stays pure Sass, untouched. Nothing about this is required: with the plugin providing that runtime not installed, the fetch 404s quietly and the page renders exactly as before on its own stylesheet." },
    { version: 2.0, message: "Breaking: the Base Path setting is gone. The dashboard now always lives at the fixed URL HFS assigns to a plugin's public folder (/~/plugins/hfs-wake-on-lan/), and an optional Path alias redirects an older URL there — an existing Base Path is carried over into it automatically on first start. New 'Use custom frontend' option serves the dashboard from storage/custom-frontend instead of the shipped files. The dashboard itself was rebuilt from an inline-everything HTML page into TypeScript and Sass sources compiled into dist/public." },
    { version: 1.7, message: "Now requires hfs-shared. Default dashboard path moved to /~/plugins/hfs-wake-on-lan (old default path redirects to whatever basePath is currently configured). Wake/add/remove device events are now logged, batched, with an Enable/Verbose Logging switch." },
    { version: 1.6, message: "Magic packets now sent to all relevant broadcast addresses (e.g. /24 = *.255) in parallel." },
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
const { redirectAlias } = require('./backend/path-alias');

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

// ── Broadcast address helpers ─────────────────────────────────────────────
/**
 * Given an IPv4 address string, return all broadcast addresses that should
 * receive the magic packet.
 *
 * Strategy (all sent in parallel):
 *  1. 255.255.255.255          — limited broadcast, always included
 *  2. Classful directed broadcast — derived from the device IP using the
 *     default classful mask (A/B/C).  Examples:
 *       10.x.x.x   → 10.255.255.255   (Class A, mask /8)
 *       172.x.x.x  → 172.y.255.255    (Class B, mask /16)
 *       192.x.x.x  → 192.168.z.255    (Class C, mask /24)
 *  3. Subnet .255 address      — last octet forced to 255, catches common
 *     /24 subnets without requiring subnet-mask knowledge.
 *     (Identical to the classful result for Class C, so de-duplicated.)
 *
 * Only unique addresses are returned; IPv6 addresses are passed through
 * unchanged (WoL over IPv6 uses the all-nodes multicast, so we keep the
 * address as-is and let the caller decide).
 */
function getBroadcastAddresses(ip) {
    if (!ip || !net.isIPv4(ip)) {
        // IPv6 or absent — return only the limited broadcast / original address.
        return ip ? [ip] : ['255.255.255.255'];
    }

    const octets = ip.split('.').map(Number);
    const [o1, o2, o3] = octets;

    const addresses = new Set();

    // 1. Limited broadcast — always
    addresses.add('255.255.255.255');

    // 2. Classful directed broadcast
    //    Class A: first octet 1–126   → <o1>.255.255.255
    //    Class B: first octet 128–191 → <o1>.<o2>.255.255
    //    Class C: first octet 192–223 → <o1>.<o2>.<o3>.255
    if (o1 >= 1 && o1 <= 126) {
        // Class A
        addresses.add(`${o1}.255.255.255`);
    } else if (o1 >= 128 && o1 <= 191) {
        // Class B
        addresses.add(`${o1}.${o2}.255.255`);
    } else if (o1 >= 192 && o1 <= 223) {
        // Class C
        addresses.add(`${o1}.${o2}.${o3}.255`);
    }
    // Class D/E (224+) — multicast/reserved, no directed broadcast.

    // 3. Subnet .255 — covers typical /24 slices within larger networks.
    //    (e.g. 10.1.2.x → 10.1.2.255, even though Class A broadcast is 10.255.255.255)
    addresses.add(`${o1}.${o2}.${o3}.255`);

    return [...addresses];
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

/**
 * Send magic packets to all broadcast addresses derived from the device IP
 * (plus 255.255.255.255) in parallel.  Resolves when every send attempt has
 * completed (errors per-address are collected but not fatal — at least one
 * address must succeed, otherwise the returned promise rejects).
 */
function wakeAll(mac, opts) {
    opts = opts || {};
    const ip       = opts.address && opts.address !== '255.255.255.255' ? opts.address : null;
    const targets  = getBroadcastAddresses(ip);

    const sends = targets.map(addr =>
        new Promise((resolve, reject) =>
            wake(mac, { ...opts, address: addr }, err => err ? reject(err) : resolve(addr))
        ).then(
            addr  => ({ addr, ok: true }),
            err   => ({ addr, ok: false, err: err.message })
        )
    );

    return Promise.all(sends).then(results => {
        const succeeded = results.filter(r => r.ok).map(r => r.addr);
        const failed    = results.filter(r => !r.ok);
        if (succeeded.length === 0) {
            throw new Error('All broadcast targets failed: ' + failed.map(f => `${f.addr} (${f.err})`).join('; '));
        }
        return { succeeded, failed };
    });
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

// ── Custom-frontend override ──────────────────────────────────────────────
// The shipped dashboard needs no code here: HFS serves a plugin's public
// folder by itself. This only covers the opt-in replacement living in the
// plugin's storage folder, and only for files that are actually there —
// anything missing falls through to the shipped copy.
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8', '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript',   '.json': 'application/json',
    '.svg':  'image/svg+xml',            '.png':  'image/png',
    '.jpg':  'image/jpeg',               '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',               '.ico':  'image/x-icon',
    '.woff2': 'font/woff2',              '.woff': 'font/woff',
};

/**
 * Serve <storageDir>/custom-frontend/<rel> if it exists.
 * @returns {boolean} true when the file was sent, false to fall through.
 */
function serveCustomFrontend(ctx, api, rel) {
    if (!api.getConfig('useCustomFrontend')) return false;

    const root = path.resolve(api.storageDir, 'custom-frontend');
    const resolved = path.resolve(root, rel || 'index.html');
    // Keep '..' in a request from reaching outside the override folder.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;

    let stats;
    try { stats = fs.statSync(resolved); } catch { return false; }
    if (!stats.isFile()) return false;

    ctx.status = 200;
    ctx.type = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    ctx.set('Cache-Control', 'no-cache');
    ctx.body = fs.createReadStream(resolved);
    ctx.stop();
    return true;
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

    // One-time move of the retired 'basePath' setting into its replacement, so
    // a URL somebody had configured keeps working as a redirect.
    const oldBasePath = api.getConfig('basePath')
    if (oldBasePath && !api.getConfig('pathAlias')) api.setConfig('pathAlias', oldBasePath)

    // Where HFS publishes this plugin's public folder. Not configurable.
    const CANONICAL = `/~/plugins/${api.id}`;

    const { getCurrentUsername } = api.require('./auth');
    _spawn = api.require('child_process').spawn;

    const shared = api.customApiCall('hfsShared')[0];
    shared.requireVersion('^1.0.0');
    const rawLogger = shared.createLogger(api, { tag: 'hfs-wake-on-lan' });
    function log(msg) {
        if (!api.getConfig('wol_enableLogging')) return;
        if (api.getConfig('wol_verboseLogging')) rawLogger.logNow(msg);
        else rawLogger.log(msg);
    }

    return { unload() { rawLogger.unload(); }, middleware };

    async function middleware(ctx) {
        const url = ctx.path;

        // A request on the alias never gets further than this.
        if (redirectAlias(ctx, api, CANONICAL, url)) return;

        if (url !== CANONICAL && !url.startsWith(CANONICAL + '/')) return;

        // ── Auth ──────────────────────────────────────────────────────────
        // Runs before HFS's own public-folder serving, so it covers the page
        // and its assets and not only the API.
        const username = getCurrentUsername(ctx);
        if (!username) return deny(ctx, api, 401, 'Authentication required');
        const allowed = (api.getConfig('allowedUsers') || []).map(u => u.username).filter(Boolean);
        if (allowed.length > 0 && !allowed.includes(username)) return deny(ctx, api, 403, 'Access denied');

        const sub = url.slice(CANONICAL.length);

        // ── GET /api/tailwind.js ──────────────────────────────────────────
        // The shipped dashboard brings its own stylesheet; this stays for a
        // custom frontend that wants Tailwind, and 404s when the plugin
        // providing it is not installed.
        if (sub === '/api/tailwind.js') {
            const tailwind = api.customApiCall('tailwind')[0];
            if (!tailwind) return jsonErr(ctx, 404, 'Tailwind is not available');
            ctx.type = 'application/javascript';
            ctx.set('Cache-Control', 'public, max-age=86400');
            ctx.body = fs.createReadStream(tailwind.path);
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
                log(`device added: ${rawName} (${username})`);
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
                const removed = devices[idx];
                devices.splice(idx, 1);
                await api.setConfig('devices', devices);
                log(`device removed: ${removed.name || idParam} (${username})`);
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

                const targetIp = (ip && parseIP(String(ip))) || null;
                const wolPort  = (port && Number.isInteger(parseInt(port))) ? parseInt(port) : 9;

                const { succeeded, failed } = await wakeAll(mac, {
                    address:  targetIp || '255.255.255.255',
                    port:     wolPort,
                    password: password || undefined,
                });

                log(`wake ${mac} by ${username}: ${succeeded.length} succeeded, ${failed.length} failed`);
                return jsonOk(ctx, {
                    success:   true,
                    message:   `Magic packet sent to ${mac}`,
                    broadcast: { succeeded, failed: failed.map(f => ({ addr: f.addr, error: f.err })) },
                });
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

        if (sub.startsWith('/api/')) return; // unknown API route, not ours to answer

        // ── Dashboard files ───────────────────────────────────────────────
        const rel = sub.replace(/^\/+/, '');

        // Canonical page lives at the trailing-slash root. HFS's own
        // automatic serving 405s on that exact path (no literal file is
        // named ''), so it's served here explicitly; both the bare path and
        // an explicit /index.html redirect there instead of serving content
        // directly, so the page only ever "lives" at one canonical URL.
        if (url === CANONICAL || url === `${CANONICAL}/index.html`) {
            ctx.status = 302;
            ctx.set('Location', `${CANONICAL}/${ctx.querystring ? '?' + ctx.querystring : ''}`);
            ctx.body = '';
            ctx.stop();
            return;
        }
        if (url === `${CANONICAL}/`) {
            if (serveCustomFrontend(ctx, api, 'index.html')) return;
            try {
                ctx.type = 'text/html; charset=utf-8';
                ctx.body = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
            } catch {
                ctx.status = 404;
            }
            ctx.stop();
            return;
        }

        // Any other asset under the folder: the override wins where it has a
        // file; everything else is left to HFS, which serves this plugin's
        // public folder on its own.
        if (serveCustomFrontend(ctx, api, rel)) return;
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
