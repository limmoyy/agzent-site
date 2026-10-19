#!/usr/bin/env node
/*
 * Agzent Bug Bounty Vault — encrypt helper
 * -----------------------------------------
 * Turns the plaintext `programs.json` into the public `programs.enc.json`
 * (AES-256-GCM, key derived from the passphrase with PBKDF2-SHA256).
 *
 * The plaintext file is NEVER committed. Only programs.enc.json is published,
 * and it is useless without the passphrase — so the directory is genuinely
 * private even though GitHub Pages serves everything publicly.
 *
 * Usage:
 *   AGZ_BB_PW="your-passphrase" node encrypt.mjs
 *   node encrypt.mjs --pw "your-passphrase"
 *   node encrypt.mjs --in programs.json --out programs.enc.json
 *
 * Then commit & push ONLY programs.enc.json (index.html if it changed).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const IN   = resolve(here, arg('--in', 'programs.json'));
const OUT  = resolve(here, arg('--out', 'programs.enc.json'));
const ITER = parseInt(arg('--iter', '200000'), 10);
const PW   = arg('--pw', process.env.AGZ_BB_PW || '');

if (!PW) {
  console.error('ERROR: no passphrase. Set AGZ_BB_PW=... or pass --pw "..."');
  process.exit(1);
}

const enc = new TextEncoder();
const b64 = buf => Buffer.from(buf).toString('base64');

// Validate the JSON before encrypting so we never ship a broken file.
let plain;
try {
  plain = JSON.parse(readFileSync(IN, 'utf8'));
} catch (e) {
  console.error(`ERROR: ${IN} is not valid JSON:\n  ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(plain.programs)) {
  console.error('ERROR: expected a top-level "programs" array.');
  process.exit(1);
}
plain.updated = plain.updated || new Date().toISOString().slice(0, 10);

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv   = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey('raw', enc.encode(PW), 'PBKDF2', false, ['deriveKey']);
const key  = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
  base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(plain)));

writeFileSync(OUT, JSON.stringify({
  v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter: ITER,
  salt: b64(salt), iv: b64(iv), ct: b64(ct)
}));

console.log(`OK  ${plain.programs.length} program(s) encrypted  ->  ${OUT}`);
console.log('Next: git add programs.enc.json && git commit -m "bb: update" && git push');
