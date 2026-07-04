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
> maintain, audit, or take responsibility for community plugins. Install them at
> your own risk, on your own instance, after reviewing their declared permissions.
> A `Reviewed` marker means a maintainer looked at that exact commit on that date —
> it is **not** an ongoing guarantee.

---

## How the registry works

- Each plugin is one small file: `registry/plugins/<id>.json`.
- CI (`.github/workflows/validate.yml`) validates every PR.
- On merge, `publish.yml` regenerates the aggregated `dist/index.json` that
  instances actually download, and stamps `reviewedAt` on the reviewed version.
- Plugin **code**, **README**, and **screenshots** live in **your** GitHub repo —
  never here. TREK fetches them live from your repo.

## Publish your plugin

1. **Build your plugin** and scaffold it with the SDK:
   ```
   npx create-trek-plugin my-plugin --type integration|page|widget
   ```
   This emits a working plugin plus a [`README.template.md`](./README.template.md)
   you must fill in (the CI enforces this — see below).

2. **Tag a release.** The git tag (`v1.2.0`) must equal `version` in your
   `trek-plugin.json`. Attach a built **`plugin.zip`** release asset — that is the
   supported path, because the registry pins its exact SHA-256. (GitHub's
   auto-generated source archives are not byte-stable, so a pinned hash of one can
   later fail; don't rely on them.)

3. **Validate the manifest locally:**
   ```
   npx trek-plugin validate
   ```
   This runs the same manifest rules the server loader uses. The registry's full
   CI additionally checks the release tag, the artifact SHA-256, the README and
   the owner binding over the network on your PR.

4. **Fork this repo, then open a PR** adding `registry/plugins/<your-id>.json`.
   You don't have write access here, so add your entry in your fork and open the
   pull request from it. Do **not** touch `dist/` — it is generated. See
   [`schema/example-entry.json`](./schema/example-entry.json) for the exact shape
   and [`schema/plugin-entry.schema.json`](./schema/plugin-entry.schema.json) for
   the full schema.

## What CI checks (each is a hard gate)

**Entry** (`scripts/validate-entry.mjs`): JSON schema · `id` matches filename and
is a valid slug · **owner/repo binding** (an existing plugin id can't be repointed
to a different owner) · homoglyph / mixed-script names blocked · release tag exists ·
manifest parity (`id`/`version`/`type`/`apiVersion` match) · **SHA-256 of the
downloaded artifact matches the pin** · **no native `.node` binaries** (forbidden in
v1) · `egress[]` present and non-wildcard when `http:outbound` is declared · an
optional author signature (minisign) is verified when present.

**README** (`scripts/check-readme.mjs`): a `README.md` exists · has the required
sections (*What it does / Screenshots / Permissions / Setup*) · contains **at least
one screenshot that actually resolves to an image** · has real written content
(not just the template) · **no leftover `{{placeholder}}` tokens** · every declared
permission is explained. A stub or image-less README is rejected.

## Plugin ids

Any `id` is fine — nothing is reserved. Pick a short, descriptive slug; it just
has to be unique in the registry and match your entry's filename. On first
registration an `id` is bound to its GitHub owner ([`OWNERS.json`](./OWNERS.json))
so nobody else can repoint your plugin to a different repo later; changing the
owner needs a maintainer override.

## License

Registry metadata and tooling in this repo: MIT. Each listed plugin is licensed
by its own author under its own terms.
