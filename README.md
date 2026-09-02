# Catalyst Plugins

Official plugin repository and marketplace for the
[Catalyst](https://github.com/catalystctl/catalyst) game-server panel.

Every plugin lives in its own directory with a `plugin.json` manifest. On
every push to `main`, CI validates all manifests, builds a `.catpkg.zip`
package per plugin, and publishes them to the `dist` branch. `index.json` is
the marketplace index the panel consumes (name, description, download URL,
sha256).

## Installing plugins

In your panel: **Admin → Plugins → Marketplace → Browse**. The official
index is included by default; add your own sources (any HTTPS URL serving an
index document in the same format) via the `PLUGIN_MARKETPLACE_URLS` env var
(comma-separated — first source wins on name conflicts).

Packages are verified with sha256 before extraction and land inert — code
only executes after an admin accepts the safety disclaimer and enables the
plugin.

## Developing a plugin

See [docs/plugins.md](https://github.com/catalystctl/catalyst/blob/main/docs/plugins.md)
in the main repo and the [plugin-sdk](https://www.npmjs.com/package/@catalyst/plugin-sdk)
package. Quick start:

```bash
mkdir my-plugin && cd my-plugin
# create plugin.json + backend/index.js (+ frontend/index.ts and a
# frontend.mjs bundle if you ship UI)
npx @catalyst/plugin-sdk pack   # builds my-plugin-1.0.0.catpkg.zip + .sha256
```

### Third-party listing

Third-party marketplaces don't need our permission — run your own index URL.
To be considered for inclusion in the official index, open a PR adding your
plugin directory here (manifest + code reviewed by maintainers).

## Repository layout

```
<plugin-name>/        plugin.json, backend/, frontend/, README.md
index.json            marketplace index (generated; consumed by panels)
scripts/              packaging tooling
dist (branch)         built .catpkg.zip artifacts (CI-generated, do not edit)
```

## License

GPL-3.0 — see [LICENSE](LICENSE).
