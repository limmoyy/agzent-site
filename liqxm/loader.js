// liqxm: the strategy modules are shipped encrypted (engine.<hash>.enc.json, AES-256-GCM, key = PBKDF2-SHA256 of the
// page's own passphrase — not the /scanner·/forex one). Decrypting proves the passphrase; the modules are then loaded
// from blob: URLs (CSP script-src 'self' blob:). Nothing secret lives in this file.
const te = new TextEncoder(), td = new TextDecoder();
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function fetchPkg(dir) {
  let file = 'engine.enc.json';
  try { const m = await (await fetch(dir + 'engine.manifest.json?_=' + Date.now(), { cache: 'no-store' })).json(); if (m && m.file) file = m.file; } catch (_) { }
  const r = await fetch(dir + file, { cache: 'force-cache' });
  if (!r.ok) throw new Error('Engine file not found (' + r.status + ')');
  return r.json();
}
export async function decryptEngine(pw, dir = '') {
  const pkg = await fetchPkg(dir);
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64d(pkg.salt), iterations: pkg.iter || 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(pkg.iv) }, key, b64d(pkg.ct)); // throws on a wrong passphrase
  if (pkg.z === 'gzip') {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old (no DecompressionStream).');
    pt = await new Response(new Blob([pt]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return JSON.parse(td.decode(pt));
}
/** Load the decrypted modules in dependency order; './x.js' specifiers are rewritten to the blob URL of x.js.
 *  Returns { ver, built, mods: { 'engine.js': namespace, ... } }. */
export async function loadModules(payload) {
  const urls = {}, mods = {};
  for (const name of payload.order) {
    const src = payload.files[name].replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])\.\/([\w-]+\.js)\2/g, (m, pre, q, dep) => {
      if (!urls[dep]) throw new Error(`${name} imports ${dep} before it is loaded`);
      return pre + q + urls[dep] + q;
    });
    urls[name] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    mods[name] = await import(urls[name]);
  }
  return { ver: payload.ver, built: payload.built, mods };
}
