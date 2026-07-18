<!-- Adding or updating a plugin in the registry. -->

**Plugin:** <!-- id + link to your GitHub repo -->

## Checklist

- [ ] I added/updated a single file: `registry/plugins/<id>.json` (the `id` matches the filename).
- [ ] I did **not** touch `dist/` — it is generated on merge.
- [ ] The git tag equals the manifest `version`, and I attached a built `plugin.zip` release asset.
- [ ] The newest version is first in the `versions` array.
- [ ] My manifest declares a `trek` range (e.g. `">=3.2.0 <4.0.0"`) and the entry mirrors it —
      TREK will not install or activate a plugin outside its declared range.
- [ ] `npx trek-plugin validate` passes locally.
- [ ] My repo has a `README.md` (What it does / Screenshots / Permissions / Setup) and a `docs/screenshot.png`.
- [ ] Every permission my plugin declares is explained in the README.

<!-- Tip: `size` is the byte length of plugin.zip, `sha256` is its SHA-256, and
     `commitSha` is the commit your tag points at (git rev-parse <tag>^{commit}).
     See schema/example-entry.json for the exact shape. -->
