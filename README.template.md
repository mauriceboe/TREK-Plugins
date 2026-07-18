<!--
  TREK PLUGIN README TEMPLATE
  ---------------------------
  This file is emitted into your plugin repo by `create-trek-plugin`.
  It is ALSO graded by the TREK-Plugins registry CI. Your submission PR is
  rejected until every REQUIRED section below is genuinely filled in.

  Rules the CI enforces (see scripts/check-readme.mjs in the registry repo):
    1. All headings marked (required) below must remain present.
    2. At least ONE screenshot image that actually resolves (200 + image type).
    3. No leftover template placeholders (the {{...}} tokens, or "TODO"/"REPLACE_ME").
    4. Every permission your trek-plugin.json declares must be explained in
       the "## Permissions" section.
    5. At least ~400 characters of real prose (comments/code/images don't count).

  Delete this comment block before you publish. It is stripped by the CI anyway.
-->

# {{Plugin Name}}

> {{One sentence: what this plugin does, in plain language.}}

<!-- (required) At least one real screenshot of YOUR plugin running inside TREK.
     Put images under ./docs/ in your repo and reference them with a relative path.
     A broken or missing image fails CI. Animated GIFs are fine. -->
![{{Plugin Name}} in TREK]({{./docs/screenshot-1.png}})

## What it does <!-- (required) -->

{{Describe the feature this plugin adds to TREK. Two or three sentences minimum.
Who is it for, and what problem does it solve? Do not leave this as a stub.}}

## Screenshots <!-- (required) -->

<!-- Show the plugin in context: the widget/page, its settings, a real result.
     One image is the minimum; more is better. -->
![{{describe this screenshot}}]({{./docs/screenshot-2.png}})

## Permissions <!-- (required) -->

<!-- (required) List EVERY permission from your trek-plugin.json and justify it.
     TREK shows this to the admin at activation. Requesting a permission you
     don't explain here fails CI (permission/README parity check). -->

| Permission | Why this plugin needs it |
|---|---|
| `{{db:read:trips}}` | {{e.g. to read flight reservations so it can look up status}} |
| `{{http:outbound}}` | {{which host(s) and why — must match your `egress[]`}} |

## Setup <!-- (required) -->

{{How the admin configures this plugin: which settings fields to fill in, where
to get an API key, any external account needed. If there is no setup, say so.}}

## Compatibility

- Requires **TREK {{>=3.2.0 <4.0.0}}** — state the same range as your manifest's `trek`
  field. TREK enforces it: it will not install or activate this plugin outside that range.
- {{Any other requirement: an external service, a paid API tier, etc.}}

## Support

- Issues & questions: {{https://github.com/your-name/trek-plugin-xyz/issues}}
- {{Optional: docs, changelog, funding links}}

## License

{{MIT}} — see [LICENSE](./LICENSE).

---

<sub>This is a community plugin. It is not maintained or endorsed by the TREK core team.
Install third-party plugins at your own risk after reviewing their declared permissions.</sub>
