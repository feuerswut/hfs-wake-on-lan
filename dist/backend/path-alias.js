'use strict';
// Redirects a legacy/custom path onto this plugin's canonical URL. Local to
// hfs-wake-on-lan only -- no dependency on any other plugin or shared module.

/**
 * @param ctx           Koa-style context (path/querystring/status/set/body/stop)
 * @param api           plugin api (for getConfig('pathAlias'))
 * @param canonicalPath the plugin's fixed HFS-assigned path, e.g. `/~/plugins/hfs-wake-on-lan`
 * @returns true if a redirect was issued (caller should stop routing)
 */
function redirectAlias(ctx, api, canonicalPath) {
    const alias = (api.getConfig('pathAlias') || '').replace(/\/+$/, '');
    const canonical = canonicalPath.replace(/\/+$/, '');
    if (!alias || alias === canonical) return false;
    if (ctx.path !== alias && !ctx.path.startsWith(alias + '/')) return false;

    const suffix = ctx.path.slice(alias.length);
    ctx.status = 307; // preserve method+body, not just GET
    ctx.set('Location', canonical + suffix + (ctx.querystring ? '?' + ctx.querystring : ''));
    ctx.body = '';
    ctx.stop();
    return true;
}

module.exports = { redirectAlias };
