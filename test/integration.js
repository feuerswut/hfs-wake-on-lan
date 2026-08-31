'use strict';
// Smoke test for the plugin's routing and access control: the alias redirect,
// the canonical path, the custom-frontend override, and the auth/redirectUrl
// wiring. WoL packet sending itself is untouched, pre-existing logic.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const PLUGIN_PATH = path.join(__dirname, '..', 'dist', 'plugin.js');

const PLUGIN_ID = 'hfs-wake-on-lan';
const CANONICAL = '/~/plugins/' + PLUGIN_ID;

const results = [];
function record(name, pass, reason) {
  results.push({ name, pass, reason });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${reason ? ' -- ' + reason : ''}`);
}

// Reproduces hfs-shared's auth.gate()/servePublic()/canonicalPath() contract
// closely enough to exercise this plugin's own routing -- hfs-shared isn't a
// dependency of this repo's test suite, its own correctness is covered by
// its own smoke test.
function makeFakeHfsShared() {
  function redirect(ctx, url, status) {
    ctx.status = status || 302;
    ctx.set('Location', url);
    ctx.body = '';
    ctx.stop();
  }
  function gate(ctx, api, opts) {
    opts = opts || {};
    const { getCurrentUsername } = api.require('./auth');
    const username = getCurrentUsername(ctx);
    function deny(status, message, reason) {
      if (opts.redirectUrl) redirect(ctx, opts.redirectUrl);
      else { ctx.status = status; ctx.type = 'application/json'; ctx.body = JSON.stringify({ error: message }); ctx.stop(); }
      return { denied: true, reason };
    }
    if (!username) return opts.publicAccess ? null : deny(401, 'Authentication required', 'unauthenticated');
    const rows = Array.isArray(opts.allowedUsers) ? opts.allowedUsers : [];
    const allowed = rows.map(r => typeof r === 'string' ? r : (r && r.enabled !== false ? r.username : null)).filter(Boolean);
    if (allowed.length && !allowed.includes(username)) return deny(403, 'Access denied', 'not-allowed');
    return null;
  }
  function canonicalPath(api) { return `/~/plugins/${api.id}/`; }
  function servePublic(ctx, api, opts) {
    opts = opts || {};
    const canonical = canonicalPath(api).replace(/\/+$/, '');
    const subPath = String(opts.subPath || '').replace(/^\/+|\/+$/g, '');
    const dashboardRoot = subPath ? `${canonical}/${subPath}` : canonical;

    if (opts.pathAlias) {
      const alias = String(opts.pathAlias).replace(/\/+$/, '');
      if (alias && alias !== canonical && (ctx.path === alias || ctx.path.startsWith(alias + '/'))) {
        redirect(ctx, canonical + ctx.path.slice(alias.length) + (ctx.querystring ? '?' + ctx.querystring : ''), 307);
        return true;
      }
    }
    if (ctx.path !== dashboardRoot && ctx.path !== `${dashboardRoot}/` && ctx.path !== `${dashboardRoot}/index.html`) return false;
    if (ctx.path !== `${dashboardRoot}/`) {
      redirect(ctx, `${dashboardRoot}/${ctx.querystring ? '?' + ctx.querystring : ''}`);
      return true;
    }
    if (gate(ctx, api, { allowedUsers: opts.allowedUsers, publicAccess: opts.publicAccess, redirectUrl: opts.redirectUrl })) return true;
    if (opts.useCustomFrontend) {
      const customFile = path.join(api.storageDir, 'custom-frontend', 'index.html');
      try {
        if (fs.statSync(customFile).isFile()) {
          ctx.type = 'text/html; charset=utf-8';
          ctx.set('Cache-Control', 'no-cache');
          ctx.body = fs.readFileSync(customFile, 'utf8');
          ctx.stop();
          return true;
        }
      } catch { /* fall through to the bundled file */ }
    }
    try {
      ctx.type = 'text/html; charset=utf-8';
      ctx.set('Cache-Control', 'no-cache');
      ctx.body = fs.readFileSync(path.join(opts.distDir, 'public', 'index.html'), 'utf8');
    } catch { ctx.status = 404; }
    ctx.stop();
    return true;
  }
  return {
    requireVersion: () => true,
    createLogger: () => ({ log: () => {}, logNow: () => {}, unload: () => {} }),
    response: { redirect },
    auth: { gate },
    canonicalPath,
    servePublic,
  };
}

function makeMockApi(configSchema, storageDir, preset) {
  const store = {};
  for (const [k, desc] of Object.entries(configSchema)) store[k] = desc && 'defaultValue' in desc ? desc.defaultValue : undefined;
  Object.assign(store, preset || {});
  // Minimal stand-in for HFS's real api.events (an EventEmitter): only what
  // hfs-shared-guard.js needs -- on() to subscribe, emit() to notify itself
  // once hfs-shared is found, both no-ops here since this test always has
  // hfs-shared available synchronously via customApiCall below.
  const listeners = {};
  return {
    id: PLUGIN_ID,
    storageDir,
    getConfig: k => store[k],
    setConfig: (k, v) => { store[k] = v; },
    log: () => {},
    events: {
      on(name, cb) { (listeners[name] || (listeners[name] = [])).push(cb); },
      emit(name, arg) { for (const cb of listeners[name] || []) cb(arg); },
    },
    require: mod => {
      if (mod === './auth') return { getCurrentUsername: ctx => (ctx.state && ctx.state.username) || null };
      if (mod === 'child_process') return { spawn: () => new EventEmitter() };
      throw new Error('unhandled require ' + mod);
    },
    customApiCall: name => {
      if (name === 'hfsShared') return [makeFakeHfsShared()];
      if (name === 'tailwind') return [];
      throw new Error('unhandled ' + name);
    },
  };
}

function makeCtx(url, username, method = 'GET') {
  const [pathname, querystring = ''] = url.split('?');
  const req = new EventEmitter();
  req.url = url; req.method = method;
  const headers = {};
  return {
    req, method, path: pathname, querystring,
    state: { username: username || null },
    status: 200, body: undefined, type: undefined,
    set(k, v) { headers[k] = v; },
    get _location() { return headers.Location; },
    stop() {},
  };
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hfs-wol-test-'));
  const overrideDir = path.join(tmpRoot, 'custom-frontend');
  fs.mkdirSync(overrideDir, { recursive: true });
  fs.writeFileSync(path.join(overrideDir, 'index.html'), '<!doctype html><title>override</title>');

  const plugin = require(PLUGIN_PATH);
  const api = makeMockApi(plugin.config, tmpRoot);
  const instance = await plugin.init(api);

  record('basePath is no longer a config field', !('basePath' in plugin.config));

  {
    const ctx = makeCtx('/~/wake-on-lan/api/devices?x=1', 'alice', 'POST');
    await instance.middleware(ctx);
    record('the default alias redirects to the canonical path, sub-path and query kept',
      ctx.status === 307 && ctx._location === CANONICAL + '/api/devices?x=1',
      `status=${ctx.status} location=${ctx._location}`);
  }
  {
    api.setConfig('pathAlias', '');
    const ctx = makeCtx('/~/wake-on-lan');
    await instance.middleware(ctx);
    record('an empty alias redirects nothing', ctx.status === 200 && ctx._location === undefined);
    api.setConfig('pathAlias', '/~/wake-on-lan');
  }
  {
    const ctx = makeCtx('/some/other/route');
    await instance.middleware(ctx);
    record('a route outside the canonical path is left alone', ctx.status === 200 && ctx.body === undefined);
  }
  {
    const ctx = makeCtx(CANONICAL + '/api/devices');
    await instance.middleware(ctx);
    record('the canonical path denies an unauthenticated request with 401 JSON',
      ctx.status === 401 && JSON.parse(ctx.body).error === 'Authentication required');
  }
  {
    api.setConfig('allowedUsers', [{ username: 'bob' }]);
    const ctx = makeCtx(CANONICAL + '/api/devices', 'alice');
    await instance.middleware(ctx);
    record('allowlist denies a logged-in user not on the list', ctx.status === 403);
    api.setConfig('allowedUsers', []);
  }
  {
    api.setConfig('redirectUrl', '/login');
    const ctx = makeCtx(CANONICAL + '/api/devices');
    await instance.middleware(ctx);
    record('redirectUrl sends a 302 instead of 401 when configured', ctx.status === 302);
    api.setConfig('redirectUrl', '');
  }
  {
    const ctx = makeCtx(CANONICAL + '/api/devices', 'alice');
    await instance.middleware(ctx);
    record('an allowed authenticated user reaches the API', ctx.status === 200 && JSON.parse(ctx.body).success === true);
  }
  {
    const ctx = makeCtx(CANONICAL, 'alice');
    await instance.middleware(ctx);
    record('the bare path redirects to the trailing-slash canonical URL',
      ctx.status === 302 && ctx._location === CANONICAL + '/',
      `status=${ctx.status} location=${ctx._location}`);
  }
  {
    const ctx = makeCtx(CANONICAL + '/index.html', 'alice');
    await instance.middleware(ctx);
    record('an explicit /index.html also redirects to the trailing-slash canonical URL, never serves there',
      ctx.status === 302 && ctx._location === CANONICAL + '/',
      `status=${ctx.status} location=${ctx._location}`);
  }
  {
    const ctx = makeCtx(CANONICAL + '/', 'alice');
    await instance.middleware(ctx);
    record('the trailing-slash canonical URL serves the dashboard page directly',
      ctx.status === 200 && ctx.type === 'text/html; charset=utf-8' && typeof ctx.body === 'string',
      `status=${ctx.status} type=${ctx.type}`);
  }
  {
    const ctx = makeCtx(CANONICAL + '/wake.css', 'alice');
    await instance.middleware(ctx);
    record('an asset is left to HFS to serve from the public folder',
      ctx.status === 200 && ctx.body === undefined);
  }
  {
    api.setConfig('useCustomFrontend', true);
    const ctx = makeCtx(CANONICAL + '/', 'alice');
    await instance.middleware(ctx);
    record('the override serves its own index.html for the root path',
      ctx.status === 200 && ctx.body !== undefined && ctx.type === 'text/html; charset=utf-8',
      `type=${ctx.type}`);
    if (ctx.body && ctx.body.destroy) ctx.body.destroy();
  }
  {
    const ctx = makeCtx(CANONICAL + '/wake.css', 'alice');
    await instance.middleware(ctx);
    record('the override falls through for a file it does not have',
      ctx.status === 200 && ctx.body === undefined);
  }
  {
    const ctx = makeCtx(CANONICAL + '/../../../etc/passwd', 'alice');
    await instance.middleware(ctx);
    record('the override refuses to climb out of its folder', ctx.body === undefined);
    api.setConfig('useCustomFrontend', false);
  }

  instance.unload();

  {
    // A retired basePath is carried into the alias field, so the URL somebody
    // configured keeps answering.
    const api2 = makeMockApi(plugin.config, tmpRoot, { basePath: '/wol', pathAlias: '' });
    const inst2 = await plugin.init(api2);
    record('a leftover basePath becomes the alias', api2.getConfig('pathAlias') === '/wol');
    const ctx = makeCtx('/wol/api/ping', 'alice');
    await inst2.middleware(ctx);
    record('and that alias then redirects', ctx.status === 307 && ctx._location === CANONICAL + '/api/ping');
    inst2.unload();
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const passCount = results.filter(r => r.pass).length;
  console.log(`\n${passCount}/${results.length} scenarios passed`);
  process.exit(results.every(r => r.pass) ? 0 : 1);
}

main().catch(err => { console.log('FATAL', err.stack); process.exit(2); });
