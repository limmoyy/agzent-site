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
| `status` | the **program's** state: `active` · `paused` · `archived`. |
| `workStatus` | **your** progress on it: `new` · `queued` · `in_progress` · `submitted` · `resolved` · `blocked` · `skipped`. Drives the progress badge + the progress filter. See the execution rules below. `skipped` = the **X** mark (do not execute). |
| `auto` | `true`/`false` — may the agent run this one autonomously? Leave unset to let the viewer derive it (email channel, or a platform in `authorizedPlatforms`). |
| `outcome` | free text once `resolved` (e.g. `Accepted — $500`, `Duplicate`, `Rejected`). |
| `workNote`, `workUpdated` | optional: a short progress note and the date it last moved. |
| `type` | free label, e.g. `Bug Bounty`, `VDP`, `Private invite`. |
| `tags` | array of strings → become filter chips + search terms. |
| `added` | date you added it to the vault (`YYYY-MM-DD`). |
| `published` | when the **program/source itself** was released or last updated — ISO 8601 (`2024-05-01`, or with time `2024-05-01T14:00Z`). Shown as "Released …" and drives the Newest/Oldest sort. |
| **`source`** | **where the program came from** — `{ platform, url, policyUrl, discovered }`. |
| `summary` | short paragraph shown on the card and at the top of the detail. |
| `rewards` | `{ low, medium, high, critical, notes }` — any subset; strings. |
| **`scope`** | `{ in: [...], out: [...] }`, each row `{ asset, type, notes }`. |
| **`submission`** | **how to submit** — `{ channel, how, url, email, sla, language }`. `channel` is `email` · `platform` · `web-form` · `other` and decides auto-eligibility. |
| **`reportTemplate`** | ordered array of the fields a report must contain **for this specific program**. See the note below — this is NOT a fixed list. A plain string gets an automatic HackerOne-style hint; use `["Field","custom hint"]` to override. |
| `policy` | disclosure rules / testing rules (plain text, line breaks kept). |
| `safeHarbor` | one line about legal safe harbor. |

Only `id` is strictly required; every section hides itself when empty. Copy the
`_template` entry in `programs.sample.json` as a starting point.

### `reportTemplate` — curate it per program, don't pad to a fixed count
Different programs ask for different things. **Fetch the program's actual policy /
report page** (`source.url` / `source.policyUrl`), read what *that* program
requires in a submission, and list only those fields in the order they want
them. Real forms are usually **4–8 fields**, sometimes 3, sometimes more — never
assume a fixed "always 10" set. If a program mandates a CVSS vector, a specific
title format, or a PoC video, encode that as a hint: `["Severity","CVSS 3.1
vector required"]`. If the page lists nothing special, a short default
(Title → Steps to reproduce → PoC → Impact → Severity) is fine.

### Browsing
The viewer has search, tag-chip filters, and a sort control
(**Newest / Oldest / Highest reward / A–Z**). Newest/Oldest use `published`
(falling back to `added`), and reward sort reads the largest number in
`rewards`. There is also a **progress filter** (New / Queued / In progress /
Submitted / Resolved / Needs registration / **X — skip**). Fill those fields so
sorting and filtering are meaningful.

### The X mark (do not execute)

A program becomes **X — skip** two ways:

- **Automatic.** `added` is more than **3 days** old. A program that has sat in
  the list past its working window is stale — someone else has almost certainly
  worked it — so it flips to X on its own. The badge reads
  `X — auto >3 hari`. Day 3 is still inside the window; day 4 is out.
- **Manual.** You press the **X** button (old program, or already worked by
  another hunter). The badge reads `X — skip`.

Either way the card dims, the entry drops out of **⚡ Auto** into **✋ Manual**,
and it gets its own entry in the progress filter. **Your click always wins**: X
on an auto-X card pins it back in, X on a live card pins it out. So if a stale
program is actually still worth doing, one click rescues it.

Marks are kept in the browser's `localStorage`, because the site is static — a
click cannot write back to the vault by itself.

To hand the marks to the agent, press **Kirim ke Telegram** — it opens
Telegram's share sheet with the line pre-filled, so you only pick the agent chat
and hit send. **Salin daftar X** copies the same line
(`X range, priors, strise`) if you would rather paste it; send it and the agent
sets `workStatus: "skipped"` on those entries, re-encrypts and pushes — so the
mark becomes permanent and shows up on every device. The copied line contains
both kinds, so the auto ones become permanent too.

A `skipped` entry is never executed, never auto-eligible, and never picked as the
next target.

---

## Agent execution rules (autonomous run)

`authorizedPlatforms` (top-level array) is the list of platforms the operator
has **already given the agent an account/access to** — e.g. `["HackerOne",
"Bugcrowd"]`. Email submission is always allowed. This is the ONLY gate for
autonomous work.

**A program is auto-eligible when** `submission.channel` is `email` (or an
`submission.email` is set), **OR** its platform is in `authorizedPlatforms`.
The viewer shows eligible entries as **⚡ Auto** and everything else as
**✋ Manual**.

The agent runs like this:

1. **Only auto-eligible programs.** If a program is on a platform NOT in
   `authorizedPlatforms`, do **not** touch it. Set `workStatus: "blocked"`,
   leave a `workNote` ("needs account on <platform>"), and move on. The operator
   registers that platform themselves, adds it to `authorizedPlatforms`, and
   tells the agent — only then does it become eligible.
2. **One at a time, to completion.** Work a single program fully —
   `queued` → `in_progress` → test within scope → write the report → submit →
   `submitted` — before starting the next. Never run two in parallel. Set
   exactly one program to `in_progress` at any moment.
3. **Pick order:** oldest `queued` first (or operator's choice), skipping
   anything `blocked`/`submitted`/`resolved`/`skipped`. **`skipped` is a hard
   stop** — the operator marked it X because it is old or already worked by
   someone else. Do not test it, do not re-add it, do not "double-check" it.
4. **Stay inside the rules.** Only assets in `scope.in`; obey each program's
   `policy` (no DoS, no out-of-scope targets, no automated scanning where
   disallowed, stop at proof-of-concept). The program's scope IS the
   authorisation — nothing outside it.
5. **Record every move.** Update `workStatus`, `workUpdated`, and `outcome`
   as things change, then re-encrypt + push so the board reflects reality.

After each status change: `AGZ_BB_PW='<pw>' node encrypt.mjs` → commit + push
`programs.enc.json`.

### Where to source programs
Pull from the public program lists on **HackerOne**, **Bugcrowd**,
**Intigriti**, **YesWeHack**, **Immunefi**, **HackenProof**, the audit contests
on **Code4rena**, **CodeHawks** and **Sherlock**, the big vendor VRPs
(**Google/Microsoft/Apple**), and from a target's own `/.well-known/security.txt`
or `/security` page. **Web3 projects also announce new bounty programs on X /
Twitter** — that is often where a program shows up first, before it is listed
anywhere else, so watch project accounts and bounty-keyword chatter there too.
Always set `source.url` to the canonical policy page, and treat scope/rewards
there as authoritative over anything cached here.
