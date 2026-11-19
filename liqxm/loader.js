// liqxm: the strategy modules are shipped encrypted (engine.<hash>.enc.json, AES-256-GCM, key = PBKDF2-SHA256 of the
// page's own passphrase — not the /scanner·/forex one). Decrypting proves the passphrase; the modules are then loaded
// from blob: URLs (CSP script-src 'self' blob:). Nothing secret lives in this file.
const te = new TextEncoder(), td = new TextDecoder();
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** The manifest names the content-addressed engine file; retried (no guessed fallback name — build.mjs writes none). */
async function fetchPkg(dir) {
  let file = null, last = null;
  for (let k = 0; k < 3 && !file; k++) {
    if (k) await sleep(500 * k);
    try {
      const r = await fetch(dir + 'engine.manifest.json?_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) { last = 'HTTP ' + r.status; continue; }
      const m = await r.json(); if (m && m.file) file = m.file; else last = 'isi manifest tidak valid';
    } catch (e) { last = e; }
  }
  if (!file) throw last instanceof Error && /fetch|network|load failed/i.test(last.message) ? last : new Error('Daftar engine tidak bisa dimuat (' + (last?.message || last || '?') + ').');
  const r = await fetch(dir + file, { cache: 'force-cache' });
  if (!r.ok) throw new Error('File engine tidak ditemukan (HTTP ' + r.status + ') — muat ulang halaman.');
  return r.json();
}
export async function decryptEngine(pw, dir = '') {
  const pkg = await fetchPkg(dir);
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64d(pkg.salt), iterations: pkg.iter || 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(pkg.iv) }, key, b64d(pkg.ct)); // throws on a wrong passphrase
  if (pkg.z === 'gzip') {
    if (typeof DecompressionStream === 'undefined') throw new Error('Browser ini terlalu lama (tidak ada DecompressionStream) — pakai Chrome/Firefox/Safari versi baru.');
    pt = await new Response(new Blob([pt]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return JSON.parse(td.decode(pt));
}
/** Load the decrypted modules in dependency order; './x.js' specifiers are rewritten to the blob URL of x.js.
 *  Modules named in `optional` may fail without failing the unlock (their error lands in `errors`).
 *  Returns { ver, built, mods: { 'engine.js': namespace, ... }, errors: { 'x.js': message } }. */
export async function loadModules(payload, { optional = [] } = {}) {
  const urls = {}, mods = {}, errors = {};
  for (const name of payload.order) {
    try {
      const src = payload.files[name].replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])\.\/([\w-]+\.js)\2/g, (m, pre, q, dep) => {
        if (!urls[dep]) throw new Error(`${name} mengimpor ${dep} sebelum modul itu dimuat (build engine tidak konsisten)`);
        return pre + q + urls[dep] + q;
      });
      urls[name] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      mods[name] = await import(urls[name]);
    } catch (e) {
      if (!optional.includes(name)) throw e;
      errors[name] = String(e && e.message || e);
    }
  }
  return { ver: payload.ver, built: payload.built, mods, errors };
}
