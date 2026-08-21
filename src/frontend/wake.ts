// ---------------------------------------------------------------------------
// frontend/wake.ts -- the dashboard's whole client side: load the device
// list, render it, and wire up add/wake/ping/remove. Compiled by
// build/build.mjs into dist/public/wake.js, an IIFE loaded from index.html.
//
// No globals for the HTML to call into (unlike the plain-JS page this
// replaces): index.html carries no onclick attributes, and every control is
// wired here via addEventListener, with one delegated listener on the device
// list for the row buttons it renders.
// ---------------------------------------------------------------------------

export {}

interface PortResult { port: number, open: boolean }
interface Device {
    id?: string
    name: string
    ip?: string
    mac: string
    port?: number
    pingPort?: number
    password?: string
}
interface DeviceStatus {
    checking?: boolean
    error?: string
    online?: boolean
    ports?: PortResult[]
}

let devices: Device[] = []
let status: Record<number, DeviceStatus> = {}

// Pending removals: index -> the bits needed to put a device back if the
// undo toast is clicked before its timer fires.
interface PendingRemoval { device: Device, statusSnap: DeviceStatus | undefined, timerId: ReturnType<typeof setTimeout>, toastEl: HTMLElement }
const pendingRemoval: Record<number, PendingRemoval> = {}

// The page is always reached as ".../<plugin-path>/index.html" (the plugin's
// own middleware redirects the bare directory there so relative asset URLs
// resolve), so the API root is one path segment up from the document itself.
function basePath(): string {
    return window.location.pathname.replace(/\/[^/]*$/, '')
}

function $<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id)
    if (!el) throw new Error(`missing #${id}`)
    return el as T
}

// ── Optional Tailwind enhancement ───────────────────────────────────────────
// The body content below the header carries Tailwind utility classes
// alongside its Sass ones, but the page is fully usable on the Sass alone --
// this is a progressive enhancement, not a dependency. It only takes effect
// if /api/tailwind.js resolves, which the plugin's backend only does when
// the plugin providing that runtime is installed; otherwise this 404s and
// the class names above simply do nothing. Fire-and-forget: never blocks or
// delays rendering the rest of the page.
function loadTailwind() {
    fetch(basePath() + '/api/tailwind.js')
        .then(res => {
            if (!res.ok) throw new Error(String(res.status))
            const script = document.createElement('script')
            script.src = basePath() + '/api/tailwind.js'
            document.head.appendChild(script)
        })
        .catch(() => console.debug('Tailwind runtime not available; continuing with Sass only'))
}

// ── SVG icons ─────────────────────────────────────────────────────────────
const SVG = {
    send:    `<svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 -960 960 960" aria-hidden="true"><path d="M120-160v-640l760 320-760 320Zm80-120 474-200-474-200v140l240 60-240 60v140Zm0 0v-400 400Z"/></svg>`,
    trash:   `<svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 -960 960 960" aria-hidden="true"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>`,
    restore: `<svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 -960 960 960" aria-hidden="true"><path d="M440-320h80v-166l64 62 56-56-160-160-160 160 56 56 64-62v166ZM280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520Zm-400 0v520-520Z"/></svg>`,
    ping:    `<svg xmlns="http://www.w3.org/2000/svg" height="13" width="13" viewBox="0 -960 960 960" aria-hidden="true"><path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z"/></svg>`,
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg: string, type: 'ok' | 'err' | 'info' = 'info') {
    const el = document.createElement('div')
    el.className = `toast${type === 'info' ? '' : ' toast-' + type}`
    el.textContent = msg
    $('toasts').appendChild(el)
    setTimeout(() => el.remove(), 3500)
    return el
}

function undoToast(msg: string, onUndo: () => void, timeoutMs = 8000) {
    const el = document.createElement('div')
    el.className = 'toast toast-undo'
    el.innerHTML = `
    <div class="toast-undo-row flex items-center gap-3">
      <span>${esc(msg)}</span>
      <button type="button" class="rounded-md px-2 py-1 hover:bg-black/10">${SVG.restore}<span>Undo</span></button>
    </div>
    <div class="undo-bar" style="animation-duration:${timeoutMs}ms"></div>`
    el.querySelector('button')!.addEventListener('click', () => { onUndo(); el.remove() })
    $('toasts').appendChild(el)
    return el
}

// ── Load devices ───────────────────────────────────────────────────────────
async function loadDevices() {
    try {
        const res = await fetch(basePath() + '/api/devices')
        const data = await res.json()
        if (data.success) devices = data.devices || []
    } catch {
        toast('Could not load devices from server', 'err')
    }
    render()
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
    const el = $('device-list')

    if (!devices.length) {
        el.innerHTML = `<div class="muted p-4">No devices yet. Add one below.</div>`
        return
    }

    el.innerHTML = devices.map((d, i) => {
        const s = status[i]
        const hasIp = !!(d.ip && d.ip.trim())

        let dotClass: string, stateClass: string, label: string
        if (!hasIp) {
            dotClass = 'dot'; stateClass = 'state-unknown'; label = 'no ip'
        } else if (s?.checking) {
            dotClass = 'dot dot-checking'; stateClass = 'state-checking'; label = 'checking'
        } else if (s?.error) {
            dotClass = 'dot dot-error'; stateClass = 'state-error'; label = 'error'
        } else if (s) {
            dotClass = s.online ? 'dot dot-online' : 'dot dot-offline'
            stateClass = s.online ? 'state-online' : 'state-offline'
            label = s.online ? 'online' : 'offline'
        } else {
            dotClass = 'dot'; stateClass = 'state-unknown'; label = '—'
        }

        const portBadges = (s?.ports && s.ports.length)
            ? s.ports.map(p => `<span class="port-badge${p.open ? ' is-open' : ''}">:${p.port}</span>`).join('')
            : `<span class="port-badge is-placeholder">:000</span>`

        const pingBtn = hasIp
            ? `<button class="btn btn-ping btn-icon rounded-md hover:bg-black/5" data-action="ping" title="Ping">${SVG.ping}</button>`
            : ''

        const meta = hasIp
            ? `${normMac(d.mac)}<span class="device-ip"> ${esc(d.ip!)}</span>`
            : normMac(d.mac)

        return `
    <div class="device flex items-center gap-3 rounded-lg p-3" data-index="${i}">
      <div class="device-status flex items-center gap-2">
        <span class="${dotClass}"></span><span class="${stateClass}">${label}</span>
      </div>
      <div class="device-info flex flex-col gap-0.5">
        <div class="device-name">${esc(d.name)}</div>
        <div class="device-meta mono">${meta}</div>
      </div>
      <div class="device-ports flex gap-1">${portBadges}</div>
      <div class="device-actions flex items-center gap-2">
        ${pingBtn}
        <button class="btn rounded-md px-3 py-1.5 hover:opacity-90" data-action="wake">${SVG.send}<span>Wake</span></button>
        <button class="btn btn-danger btn-icon rounded-md hover:opacity-90" data-action="remove" title="Remove device">${SVG.trash}</button>
      </div>
    </div>`
    }).join('')
}

// ── Ping ───────────────────────────────────────────────────────────────────
async function pingOne(i: number) {
    const d = devices[i]
    if (!d || !d.ip || !d.ip.trim()) return
    status[i] = { checking: true }
    render()
    try {
        const res = await fetch(basePath() + '/api/ping', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: d.ip, port: d.pingPort ? Number(d.pingPort) : null }),
        })
        const data = await res.json()
        status[i] = data.success ? { online: data.online, ports: data.ports } : { error: data.error }
    } catch (e: any) {
        status[i] = { error: e?.message || 'ping failed' }
    }
    render()
}

async function refreshAll() {
    if (!devices.length) return
    await Promise.all(devices.map((d, i) => (d.ip && d.ip.trim()) ? pingOne(i) : null))
}

// ── Wake ───────────────────────────────────────────────────────────────────
async function wakeOne(i: number, btn: HTMLButtonElement | null) {
    const d = devices[i]
    if (!d) return
    if (btn) { btn.disabled = true; btn.innerHTML = `${SVG.send}<span>…</span>` }
    try {
        const res = await fetch(basePath() + '/api/wake', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: d.mac, ip: d.ip || undefined, port: d.port || 9, password: d.password || undefined }),
        })
        const data = await res.json()
        if (!data.success) throw new Error(data.error)
        toast(`Packet sent to ${d.name}`, 'ok')
        if (btn) { btn.disabled = false; btn.innerHTML = `${SVG.send}<span>Sent</span>` }
        if (d.ip && d.ip.trim()) { setTimeout(() => pingOne(i), 5000); setTimeout(() => pingOne(i), 12000) }
    } catch (e: any) {
        toast(`Wake failed: ${e?.message}`, 'err')
        if (btn) { btn.disabled = false; btn.innerHTML = `${SVG.send}<span>Wake</span>` }
    }
}

// ── Remove device (soft-delete, 8 s undo) ──────────────────────────────────
function removeDevice(i: number) {
    const device = devices[i]
    if (!device) return
    const statusSnap = status[i]
    // Capture the delete key NOW -- before the splice shifts indices.
    // Use the UUID if the device has one (v1.3+), otherwise fall back to
    // its integer index, for devices created before ids existed.
    const deleteKey = device.id || String(i)

    devices.splice(i, 1)
    const ns: Record<number, DeviceStatus> = {}
    Object.entries(status).forEach(([k, v]) => { const ki = +k; if (ki < i) ns[ki] = v; else if (ki > i) ns[ki - 1] = v })
    status = ns
    render()

    const toastEl = undoToast(`Removed "${device.name}"`, () => {
        clearTimeout(pendingRemoval[i]?.timerId)
        delete pendingRemoval[i]
        devices.splice(i, 0, device)
        const rs: Record<number, DeviceStatus> = {}
        Object.entries(status).forEach(([k, v]) => { const ki = +k; rs[ki >= i ? ki + 1 : ki] = v })
        if (statusSnap) rs[i] = statusSnap
        status = rs
        render()
        toast(`Restored "${device.name}"`, 'ok')
    })

    const timerId = setTimeout(async () => {
        delete pendingRemoval[i]
        toastEl.remove()
        try {
            const res = await fetch(basePath() + '/api/devices/' + encodeURIComponent(deleteKey), { method: 'DELETE' })
            const data = await res.json()
            if (!data.success) throw new Error(data.error)
            devices = data.devices
            status = {}
            render()
        } catch (e: any) {
            devices.splice(i, 0, device)
            const rs: Record<number, DeviceStatus> = {}
            Object.entries(status).forEach(([k, v]) => { const ki = +k; rs[ki >= i ? ki + 1 : ki] = v })
            if (statusSnap) rs[i] = statusSnap
            status = rs
            render()
            toast(`Failed to remove "${device.name}": ${e?.message}`, 'err')
        }
    }, 8000)

    pendingRemoval[i] = { device, statusSnap, timerId, toastEl }
}

// ── Add device ─────────────────────────────────────────────────────────────
async function addDevice() {
    const name     = $<HTMLInputElement>('f-name').value.trim()
    const ip       = $<HTMLInputElement>('f-ip').value.trim()
    const mac      = $<HTMLInputElement>('f-mac').value.trim()
    const port     = Number($<HTMLInputElement>('f-port').value) || 9
    const pingPort = Number($<HTMLInputElement>('f-pingport').value) || undefined
    const password = $<HTMLInputElement>('f-password').value.trim() || undefined

    if (!name || !mac) { toast('Name and MAC are required', 'err'); return }
    const clean = mac.replace(/[:-]/g, '')
    if (!/^[0-9A-Fa-f]{12}$/.test(clean)) { toast('Invalid MAC address', 'err'); return }

    try {
        const res = await fetch(basePath() + '/api/devices', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, ip, mac, port, pingPort, password }),
        })
        const data = await res.json()
        if (!data.success) throw new Error(data.error)
        devices = data.devices
        status = {}
        for (const id of ['f-name', 'f-ip', 'f-mac', 'f-pingport', 'f-password'])
            $<HTMLInputElement>(id).value = ''
        $<HTMLInputElement>('f-port').value = '9'
        render()
        toast(`Added ${name}`, 'ok')
    } catch (e: any) {
        toast(`Failed to add device: ${e?.message}`, 'err')
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s: string) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function normMac(m: string) { return String(m || '').replace(/[:-]/g, '').toUpperCase().replace(/(.{2})(?!$)/g, '$1:') }

// ── Wiring ─────────────────────────────────────────────────────────────────
function init() {
    $('refresh-all').addEventListener('click', () => { void refreshAll() })

    $('add-form').addEventListener('submit', e => {
        e.preventDefault()
        void addDevice()
    })

    // One delegated listener covers every row's ping/wake/remove button,
    // including rows that don't exist yet at load time -- render() rebuilds
    // #device-list's innerHTML wholesale, so per-row listeners would be lost
    // on every refresh.
    $('device-list').addEventListener('click', e => {
        const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null
        if (!btn) return
        const row = btn.closest('.device') as HTMLElement | null
        const i = row ? Number(row.dataset.index) : NaN
        if (Number.isNaN(i)) return
        switch (btn.dataset.action) {
            case 'ping':   void pingOne(i); break
            case 'wake':   void wakeOne(i, btn); break
            case 'remove': removeDevice(i); break
        }
    })

    loadDevices().then(() => {
        if (devices.some(d => d.ip && d.ip.trim())) setTimeout(refreshAll, 400)
    })
    setInterval(() => { if (devices.length) void refreshAll() }, 30000)

    loadTailwind()
}

if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init)
else
    init()
