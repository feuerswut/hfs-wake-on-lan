'use strict';
// Smoke test for hfs-wake-on-lan's hfs-shared retrofit (auth/redirect/logging
// wiring only -- WoL packet sending itself is untouched, pre-existing logic).
const path = require('path');
const { EventEmitter } = require('events');
const PLUGIN_PATH = path.join(__dirname, '..', 'dist', 'plugin.js');

const results = [];
function record(name, pass, reason) {
  results.push({ name, pass, reason });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${reason ? ' -- ' + reason : ''}`);
}

function makeFakeHfsShared() {
  return {
    requireVersion: () => true,
    createLogger: () => ({ log: () => {}, logNow: () => {}, unload: () => {} }),
    response: { redirect(ctx, url) { ctx.status = 302; ctx._location = url; ctx.stop(); } },
  };
}

function makeMockApi(configSchema) {
  const store = {};
  for (const [k, desc] of Object.entries(configSchema)) store[k] = desc && 'defaultValue' in desc ? desc.defaultValue : undefined;
  return {
    getConfig: k => store[k],
    setConfig: (k, v) => { store[k] = v; },
    log: () => {},
    require: mod => {
      if (mod === './auth') return { getCurrentUsername: ctx => (ctx.state && ctx.state.username) || null };
      if (mod === 'child_process') return { spawn: () => new EventEmitter() };
      throw new Error('unhandled require ' + mod);
    },
    customApiCall: name => { if (name === 'hfsShared') return [makeFakeHfsShared()]; throw new Error('unhandled ' + name); },
  };
}

function makeCtx(url, username, method = 'GET') {
  const req = new EventEmitter();
  req.url = url; req.method = method;
  return { req, state: { username: username || null }, status: 200, body: undefined, set() {}, stop() {} };
}

async function main() {
  const plugin = require(PLUGIN_PATH);
  const api = makeMockApi(plugin.config);
  const instance = await plugin.init(api);

  {
    const ctx = makeCtx('/~/wake-on-lan');
    await instance.middleware(ctx);
    record('old default path redirects to the configured basePath', ctx.status === 302 && ctx._location === '/~/plugins/hfs-wake-on-lan', `status=${ctx.status} location=${ctx._location}`);
  }
  {
    const ctx = makeCtx('/~/plugins/hfs-wake-on-lan/api/devices');
    await instance.middleware(ctx);
    record('new path denies an unauthenticated request with 401 JSON', ctx.status === 401 && JSON.parse(ctx.body).error === 'Authentication required');
  }
  {
    api.setConfig('allowedUsers', [{ username: 'bob' }]);
    const ctx = makeCtx('/~/plugins/hfs-wake-on-lan/api/devices', 'alice');
    await instance.middleware(ctx);
    record('allowlist denies a logged-in user not on the list', ctx.status === 403);
    api.setConfig('allowedUsers', []);
  }
  {
    api.setConfig('redirectUrl', '/login');
    const ctx = makeCtx('/~/plugins/hfs-wake-on-lan/api/devices');
    await instance.middleware(ctx);
    record('redirectUrl sends a 302 instead of 401 when configured', ctx.status === 302);
    api.setConfig('redirectUrl', '');
  }
  {
    const ctx = makeCtx('/~/plugins/hfs-wake-on-lan/api/devices', 'alice');
    await instance.middleware(ctx);
    record('an allowed authenticated user reaches the API', ctx.status === 200 && JSON.parse(ctx.body).success === true);
  }

  instance.unload();
  const passCount = results.filter(r => r.pass).length;
  console.log(`\n${passCount}/${results.length} scenarios passed`);
  process.exit(results.every(r => r.pass) ? 0 : 1);
}

main().catch(err => { console.log('FATAL', err.stack); process.exit(2); });
