# Releasing the desktop app

Crystal ships a signed, notarized macOS desktop app with in-app auto-update, cut
by `.github/workflows/release.yml`. This is the OpenBook release shape scoped to
macOS. Windows/Linux legs come later.

## How a release happens

The pipeline is **conventional-commit driven** and **push-to-main + approval**:

1. You merge to `main`. Commit subjects follow conventional commits
   (`feat:`, `fix:`, `perf:`, `feat!:` / `BREAKING CHANGE:` for a major).
2. `plan` runs `node scripts/release.mjs --dry-run`. If nothing since the last
   `v*` tag warrants a release (only docs/chore/refactor/test/ci/build/style),
   it stops here — **no one is pinged**.
3. If a release is due, the run parks at the **`release` environment approval
   gate**. A required reviewer approves it in the Actions tab.
4. `release` bumps the version (`package.json` + `apps/desktop/package.json`),
   writes `CHANGELOG.md`, commits + tags `vX.Y.Z`, pushes, and drafts the GitHub
   release.
5. `publish-tauri` builds both arches (Apple Silicon on `macos-14`, Intel on
   `macos-13`), signs + notarizes, and attaches the `.dmg` + updater archive.
6. `finalize` assembles `latest.json` (the updater manifest) across both arches
   and flips the release **public**.

Version bumps (from commits since the last `v*` tag): `feat` → minor, `fix` /
`perf` → patch, `!` / `BREAKING CHANGE` → major (capped at minor while on 0.x).
The first release ever ships the version already in `package.json` as-is.

You can also trigger it from the Actions tab (**workflow_dispatch**) — it runs
the same `plan` → approval path.

## One-time setup

### 1. Environments (Settings → Environments)

- **`release`** — add yourself (and/or the team) under **Required reviewers**.
  This is the human gate; every release waits here.
- **`publish`** — **no** required reviewers (the gate is already `release`
  upstream). Holds the signing/notarization secrets below.

### 2. Updater signing key (already generated)

A minisign keypair was generated for the updater (public key id
`FCEB001250FADD55`). The **public** half is already committed in
`apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. The
**private** half is on the machine that generated it:

- private key: `~/.crystal/updater/crystal.key`
- password:    `~/.crystal/updater/password.txt`

Add these to the **`publish`** environment as secrets:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the full contents of `~/.crystal/updater/crystal.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the contents of `~/.crystal/updater/password.txt` |

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY          --env publish < ~/.crystal/updater/crystal.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env publish < ~/.crystal/updater/password.txt
```

> ⚠️ The pubkey in `tauri.conf.json` is the updater's **trust anchor** — an
> installed app only ever trusts the key it shipped with. To rotate, run
> `pnpm --filter @crystal/desktop exec tauri signer generate`, replace the
> `pubkey`, and update the two secrets. Clients on the old key won't auto-update
> to builds signed by the new one (they'll need a manual re-download), so rotate
> deliberately.

### 3. Apple Developer ID (notarization)

Needs an Apple Developer account. Add to the **`publish`** environment:

| Secret | How to get it |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of your **Developer ID Application** `.p12` — `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | an **app-specific password** (appleid.apple.com → Sign-In and Security), not your account password |
| `APPLE_TEAM_ID` | your 10-char Team ID (Apple Developer → Membership) |

Tauri imports the `.p12` into an ephemeral keychain, auto-detects the signing
identity, and notarizes via `notarytool` when the `APPLE_*` set is present.

To ship **un-notarized** during bring-up (Gatekeeper will warn users), drop the
`APPLE_*` assertion from the `preflight` job in `release.yml`. The updater key is
still mandatory — the build errors without it once a pubkey is configured.

## Local release-style builds

Because `createUpdaterArtifacts` + a pubkey are now set, a plain
`pnpm --filter @crystal/desktop build` **requires the updater signing env** or it
errors (this is intentional — it mirrors CI). To build a signed bundle locally:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.crystal/updater/crystal.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.crystal/updater/password.txt)"
pnpm --filter @crystal/desktop build
```

`tauri dev` is unaffected (no updater artifacts are produced in dev).

## Residual risk — verify on the first real release

Notarization of the **Node-SEA sidecar and node-pty's native `.node`** (both
nested Mach-O inside the bundle) is the one thing that can't be verified without
an Apple cert. The hardened-runtime entitlements are wired
(`entitlements.plist` → `allow-jit`, `allow-unsigned-executable-memory`,
`disable-library-validation` for the on-disk `.node`), matching OpenBook's
working setup. If the first notarized build is rejected, check `notarytool`'s log
for an unsigned/mis-sealed nested binary and add a deep-sign step before
notarization in `publish-tauri`.

Why each entitlement is required (the sidecar is a Node Single-Executable-App —
a copy of `node` with the server blob injected, see `scripts/build-sidecar.mjs`):

- `allow-jit` / `allow-unsigned-executable-memory` — V8 JITs JavaScript; under
  the hardened runtime both are required or the sidecar is SIGKILLed on launch
  after notarization.
- `disable-library-validation` — the sidecar loads node-pty's native `.node`
  addon from the app's Resources dir (staged as a Tauri resource, not baked into
  the SEA — native addons aren't embeddable). Library validation would refuse a
  Mach-O sealed under a different Team ID; disabling it lets the app-signed addon
  load.

**Do not add XML comments (`<!-- … -->`) to `entitlements.plist`.** `codesign`
embeds entitlements through AMFI's deserializer (`AMFIUnserializeXML`), which is
stricter than a normal plist parser and errors on comments —
`Failed to parse entitlements: AMFIUnserializeXML: syntax error near line N`,
failing the whole `tauri build`. `plutil -lint` will NOT catch this (it passes
on comments); test with `codesign -s - --force --options runtime --entitlements
entitlements.plist <copy-of-any-macho>`. Keep the rationale here in the runbook,
not in the plist.
