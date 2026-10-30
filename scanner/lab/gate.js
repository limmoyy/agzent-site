// Passphrase gate shared by /scanner and /forex (/alerts has its own passphrase and its own copy): the VPS snapshot is AES-256-GCM encrypted with a PBKDF2-SHA256 key
// derived from the passphrase; v2 snapshots are gzip-compressed before encryption. Decrypting it proves the passphrase.
const te = new TextEncoder(), td = new TextDecoder();
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pw, salt, iters) {
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
/** dir = folder holding <name>.manifest.json ('' on /scanner, '../scanner/' elsewhere); name = 'scanner' or 'alerts'. */
async function fetchPkg(dir, name) {
  let file = name + '.enc.json';
  try { const m = await (await fetch(dir + name + '.manifest.json?_=' + Date.now(), { cache: 'no-store' })).json(); if (m && m.file) file = m.file; } catch (_) { }
  return (await fetch(dir + file + '?_=' + Date.now(), { cache: 'no-store' })).json();
}
export async function decryptSnap(pw, dir = '', name = 'scanner') {
  const pkg = await fetchPkg(dir, name);
  const key = await deriveKey(pw, b64d(pkg.salt), pkg.iter || 200000);
  let pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(pkg.iv) }, key, b64d(pkg.ct));
  if (pkg.z === 'gzip' && typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to open the snapshot (no DecompressionStream).');
  if (pkg.z === 'gzip') pt = await new Response(new Blob([pt]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return JSON.parse(td.decode(pt));
}
