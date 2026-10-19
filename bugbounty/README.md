# Agzent Bug Bounty Vault

A private, HackerOne-style directory of bug-bounty & vulnerability-disclosure
programs, served under **https://agzent.my.id/bugbounty/**.

It is hosted on public GitHub Pages, but the program data is **AES-256-GCM
encrypted** with a passphrase. The page downloads the encrypted blob and
decrypts it *in the browser*. Without the passphrase the data is unreadable, so
the directory is genuinely private even on a public host.

```
bugbounty/
├─ index.html          ← the app (gate + viewer). Static. Rarely changes.
├─ programs.enc.json   ← PUBLIC encrypted data. Regenerated on every update.
├─ programs.json       ← PRIVATE plaintext (git-ignored). The source of truth.
├─ programs.sample.json← committed schema reference (safe to read).
├─ encrypt.mjs         ← builds programs.enc.json from programs.json.
└─ README.md           ← this file.
```

## Passphrase

The passphrase is the AES key. There is nothing to configure — whatever
passphrase was used to run `encrypt.mjs` is the passphrase the page will accept.
To change it: re-run `encrypt.mjs` with the new passphrase and push the new
`programs.enc.json`. Keep it out of git and out of chat.

---

## For Hermes — how to update the directory

This is the entire workflow. Operate in the `bugbounty/` directory of a checkout
of `github.com/limmoyy/agzent-site`.

1. **Edit `programs.json`** — add/update/remove an entry in the `programs` array.
   (If `programs.json` is missing, `cp programs.sample.json programs.json`.)
2. **Encrypt:**
   ```bash
   AGZ_BB_PW='<the passphrase>' node encrypt.mjs
   ```
   This validates the JSON and writes `programs.enc.json`. It refuses to run on
   broken JSON, so a bad edit never reaches the site.
3. **Publish only the encrypted file:**
   ```bash
   git add programs.enc.json
   git commit -m "bb: <what changed>"
   git push
   ```
   `programs.json` is git-ignored and must stay local. Never commit it.

GitHub Pages serves the update within a minute or two.

### Program schema (one object in `programs[]`)

| field | what it is |
|---|---|
| `id` | unique slug (e.g. `acme-vdp`). Required. |
| `name`, `org` | display title and the owning organisation. |
| `status` | `active` · `paused` · `archived` (controls the badge + sort order). |
| `type` | free label, e.g. `Bug Bounty`, `VDP`, `Private invite`. |
| `tags` | array of strings → become filter chips + search terms. |
| `added` | date you added it (`YYYY-MM-DD`). |
| **`source`** | **where the program came from** — `{ platform, url, policyUrl, discovered }`. |
| `summary` | short paragraph shown on the card and at the top of the detail. |
| `rewards` | `{ low, medium, high, critical, notes }` — any subset; strings. |
| **`scope`** | `{ in: [...], out: [...] }`, each row `{ asset, type, notes }`. |
| **`submission`** | **how to submit** — `{ how, url, email, sla, language }`. |
| **`reportTemplate`** | ordered array of fields a report must contain. A plain string gets an automatic HackerOne-style hint; use `["Field","custom hint"]` to override. |
| `policy` | disclosure rules / testing rules (plain text, line breaks kept). |
| `safeHarbor` | one line about legal safe harbor. |

Only `id` is strictly required; every section hides itself when empty. Copy the
`_template` entry in `programs.sample.json` as a starting point.

### Where to source programs
Pull from the public program lists on **HackerOne**, **Bugcrowd**,
**Intigriti**, **YesWeHack**, **Google/Microsoft/Apple VRPs**, and from a
target's own `/.well-known/security.txt` or `/security` page. Always set
`source.url` to the canonical policy page, and treat scope/rewards there as
authoritative over anything cached here.
