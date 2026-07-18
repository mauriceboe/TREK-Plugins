# TREK Plugins — Community Registry

The registry for third-party [TREK](https://github.com/mauriceboe/TREK) plugins.
This repo is a **static index**: every TREK instance fetches one file,
[`dist/index.json`](./dist/index.json), to show admins which plugins are
available to install. There is no server and no account — you list a plugin by
opening a pull request.

> [!WARNING]
> **Community plugins are third-party software.** They run **arbitrary server-side
> code** on the instance that installs them (inside a per-plugin isolated process,
> but still with the permissions the admin grants). The TREK team does **not**
> maintain, audit, or take responsibility for community plugins. Review their
> declared permissions before you install one on your instance. A `Reviewed`
> marker means a maintainer manually scanned that exact commit for malware on that
> date — not for functionality, and **not** a guarantee the plugin is harmless.

---

## How the registry works

- Each plugin is one small file: `registry/plugins/<id>.json`.
- CI (`.github/workflows/validate.yml`) validates every PR.
- On merge, `publish.yml` regenerates the aggregated `dist/index.json` that
  instances actually download, and stamps `reviewedAt` on the reviewed version.
- Plugin **code**, **README**, and **screenshots** live in **your** GitHub repo —
  never here. TREK fetches them live from your repo.

## Publish your plugin

1. **Scaffold + build** with the [`trek-plugin-sdk`](https://www.npmjs.com/package/trek-plugin-sdk):
   ```
   npx trek-plugin-sdk create        # interactive wizard: id, type, permissions
   ```
   Fill in the README (CI enforces it — see below), and try it locally with
   `npx trek-plugin-sdk dev`. Commit your plugin to a **public GitHub repo**.

2. **Publish in one command:**
   ```
   npx trek-plugin-sdk publish --repo you/your-repo --tag v1.0.0
   ```
   This packs the artifact, tags + creates the GitHub release (attaching the
   `plugin.zip` whose SHA-256 the registry pins), runs the registry CI checks
   locally (**preflight**), and opens the PR adding
   `registry/plugins/<your-id>.json` — stopping *before* it submits if anything
   would fail CI. The git tag must equal `version` in your `trek-plugin.json`.
   Add `--sign` to sign it (trust-on-first-use author identity).

   **By hand instead:** `npx trek-plugin-sdk validate`, then `pack` →
   `gh release create` → `entry --out registry/plugins/<id>.json`, then fork this
   repo and open the PR yourself. Do **not** touch `dist/` — it is generated. See
   [`schema/example-entry.json`](./schema/example-entry.json) for the exact shape
   and [`schema/plugin-entry.schema.json`](./schema/plugin-entry.schema.json) for
   the full schema.

Full guides: [Plugin Development](https://github.com/mauriceboe/TREK/wiki/Plugin-Development)
and [Publishing a Plugin](https://github.com/mauriceboe/TREK/wiki/Plugin-Publishing).

## What CI checks (each is a hard gate)

**Entry** (`scripts/validate-entry.mjs`): JSON schema · `id` matches filename and
is a valid slug · **owner/repo binding** (an existing plugin id can't be repointed
to a different owner) · homoglyph / mixed-script names blocked · release tag exists ·
manifest parity (`id`/`version`/`type`/`apiVersion`/`trek`/`operatorEgress`/`requiredAddons`/
`pluginDependencies` match) · **the TREK version range** (see below) · **SHA-256 of the
downloaded artifact matches the pin** · **the author signature verifies** (see below) ·
**no native `.node` binaries** (forbidden in v1) · `egress[]` present and non-wildcard when
`http:outbound` is declared (an empty `egress[]` is allowed only with `operatorEgress: true`
— see below) · **`icon` is a real lucide name** (see below).

### The store icon

An entry's optional `icon` is a [lucide](https://lucide.dev/icons) icon name in PascalCase
(e.g. `"icon": "Luggage"`) and is what TREK draws on the plugin's tile in the store. It is
normally the same icon your `trek-plugin.json` declares — `trek-plugin-sdk entry` (and
`publish`) copies it across for you, so there is usually nothing to do by hand. Omit it and
the tile falls back to a generic `Blocks` glyph.

CI rejects a name lucide doesn't have. That check exists because the failure is otherwise
silent: TREK falls back to `Blocks` on an unknown name, so a typo doesn't error anywhere —
your plugin just looks like every other one in the store.

### TREK version compatibility

Your manifest's **`trek`** field is the semver **range** of TREK versions your plugin
supports (`">=3.2.0 <4.0.0"`). Since TREK 3.4.0 it is **load-bearing, not advisory**: TREK
refuses to install a plugin whose range excludes the running version, and refuses to
*activate* one it has since outgrown — so a plugin that ships without a range, or with the
wrong one, is simply uninstallable.

CI therefore requires it on the version you are publishing, and pins it to the truth:

- the manifest must declare a **satisfiable** range (`">=4.0.0 <3.0.0"` is valid semver and
  satisfiable by nothing — it is rejected);
- the entry's `trek` must equal the manifest's, verbatim.

`trek-plugin entry` fills it in for you; don't write it by hand.

**`trek` is the only compatibility field a new entry needs.** `minTrekVersion` and
`maxTrekVersion` are the older shape and are **deprecated** — the first said nothing the
range doesn't already say, and neither can express the exclusive upper bound that is the
whole point of `<4.0.0`. Don't set them. They are still accepted (and CI checks a floor,
if present, agrees with the range) so that entries published before `trek` existed keep
validating, and so a TREK predating `trek` still has something to read. Versions published
before the field existed are likewise grandfathered: CI won't demand a range from a commit
that predates it.

### Signing

Signing is **optional**. An unsigned plugin installs on its SHA-256 pin alone, exactly as
before — the pin proves the bytes are what the *registry* vouches for. A signature proves
they came from the *author*, so a compromised registry cannot ship code under your name
without also stealing your key. Sign with `npx trek-plugin-sdk publish --sign` (or `keygen` + `entry --sign`), 
which emits a per-version `signature` and the entry's `authorPublicKey`.

If you supply them, **CI verifies them** — it is not merely carrying them through to the
index:

- **Shape** — a key without any signed version, or a signature without a key, is refused.
  TREK will not install a half-signed entry (`incomplete signature: an author key and a
  version signature must both be present`), so merging one ships an entry nobody can use.
- **Signature** — the signature is verified against the downloaded artifact bytes with the
  same verifier TREK uses at install (`scripts/lib/verify-signature.mjs` is a port of the
  host's `install/verify-signature.ts`, and must stay behaviourally identical). A signature
  CI accepts but the host would reject is an entry that bricks the update for everyone who
  already has the plugin.
- **No signing downgrade** — TREK pins the author key on **first install** (trust-on-first-use).
  Once a plugin has shipped signed, an update that drops the key, drops a version's signature,
  or is signed with a *different* key is refused on every instance that already has it. CI
  compares against the entry on the PR base and blocks all three. An entry **absent** from the
  base is compared against its last published state in the base branch's *history*, if it has
  one — so deleting a plugin and re-adding it later does not reset the baseline, and an
  unsigned or re-keyed resurrection of a previously-signed id is caught like any other
  downgrade.

Rotating a key is therefore not a routine release: every existing install stops updating
until an admin explicitly **re-trusts** the new key in TREK's admin UI (TREK ≥ 3.4.0 shows
both fingerprints and asks them to confirm the new one with you out of band).

### Maintainer overrides

Some gates protect *existing installs* (or the registry itself) rather than the submission,
so each has an escape hatch — for a real repo transfer, a genuinely rotated key, a plugin
that really is being retired. A maintainer opens them by applying a **label** to the PR:

| Label | Lifts | Use when |
|---|---|---|
| `allow-key-change` | `authorPublicKey` differs from the entry on the PR base (or, for a re-added id, from its last published state) | The author rotated their signing key, or lost it and made a new one |
| `allow-owner-change` | The entry's repo owner differs from the `id`'s binding in [`OWNERS.json`](./OWNERS.json) — and any manual edit to `OWNERS.json` itself | The plugin genuinely moved to a new owner or org |
| `allow-removal` | The PR deletes (or renames away) a `registry/plugins/*.json` entry | The plugin is genuinely being unlisted or renamed — a maintainer decision, never a routine submission |

Applying the label re-runs the validation workflow, and the gate passes. Removing it puts
the gate back.

`OWNERS.json` is written by `publish.yml` on merge and is validated on every PR: it must
keep the exact `id → { boundOwner, repo, firstReviewedAt }` shape, and every bound id must
map to a registry entry — or to the tombstone of one that was deliberately removed (the
binding of a deleted plugin is kept so nobody else can claim its id). Editing it by hand
is the exceptional case and needs the `allow-owner-change` label.

It is a label rather than anything in the PR itself **on purpose**: labelling requires
triage/write permission on this repo, which a fork contributor does not have — so an author
cannot wave their own PR through. Do not expect a magic string in a commit message or a file
in the branch to work; a submitter controls those, which would defeat the point.

The other two signing-downgrade cases — **dropping** the key, or shipping a version with no
signature — have **no override at all**. They are not recoverable: TREK refuses those updates
on every instance that already has the plugin, so merging one is simply a broken entry.

### `operatorEgress`

If your plugin talks to a **self-hosted** service whose hostname you can't know at publish
time (a Gotify, an ntfy), its manifest sets `"operatorEgress": true` and an admin adds the
real hosts *after* installing. Because that means the `egress[]` list is **not** the
plugin's full network reach, the flag is mirrored onto the entry version and CI checks the
two agree — an entry can never understate what the code at the pinned commit can reach.
`trek-plugin-sdk entry` emits it for you; it is simply absent for ordinary plugins.

It is also the **only** way to declare `http:outbound` with an empty `egress[]` — for a plugin
whose target is *always* self-hosted, so there is no host to name. That is not an allow-all:
TREK blocks every outbound call until an admin adds a host.

**README** (`scripts/check-readme.mjs`): a `README.md` exists · has the required
sections (*What it does / Screenshots / Permissions / Setup*) · contains **at least
one screenshot that actually resolves to an image** · has real written content
(not just the template) · **no leftover `{{placeholder}}` tokens** · every declared
permission is explained. A stub or image-less README is rejected.

`npx trek-plugin-sdk preflight --repo you/repo --tag vX` runs both gates locally,
over the network, so you can see a green result before you open the PR.

## Plugin ids

Any `id` is fine **except `registry`, `install` and `rescan`** (they collide with
admin API route segments and the install loader refuses them). Pick a short,
descriptive slug; it just has to be unique in the registry and match your entry's
filename. On first
registration an `id` is bound to its GitHub owner ([`OWNERS.json`](./OWNERS.json))
so nobody else can repoint your plugin to a different repo later; changing the
owner needs a maintainer override.

## License

Registry metadata and tooling in this repo: MIT. Each listed plugin is licensed
by its own author under its own terms.
