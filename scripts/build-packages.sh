#!/usr/bin/env bash
# Build .catpkg.zip packages for every plugin and regenerate index.json.
#
# A catpkg is a ZIP with a root plugin.json plus backend/ and frontend/ files
# (see catalyst-backend/src/plugins/marketplace/packaging.ts). Output lands in
# dist/plugins/<name>-<version>.catpkg.zip; index.json entries get exact
# downloadUrl + sha256 for each package so the panel can verify installs.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

command -v zip >/dev/null || { echo "zip(1) is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

mkdir -p dist/plugins
rm -f dist/plugins/*.catpkg.zip

INDEX=index.json

update_entry() { # name key plain-string-value
  python3 - "$1" "$2" "$3" <<'PYEOF'
import json, sys
name, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
with open('index.json') as f:
    idx = json.load(f)
for e in idx.get('plugins', []):
    if e.get('name') == name:
        e[key] = value
with open('index.json', 'w') as f:
    json.dump(idx, f, indent=2)
    f.write('\n')
PYEOF
}

published=""
for dir in */; do
  dir="${dir%/}"
  [ -f "$dir/plugin.json" ] || continue
  name=$(python3 -c "import json;print(json.load(open('$dir/plugin.json'))['name'])")
  version=$(python3 -c "import json;print(json.load(open('$dir/plugin.json'))['version'])")
  pkg="dist/plugins/${name}-${version}.catpkg.zip"

  echo "==> packaging ${name}@${version}"
  (cd "$dir" && zip -qr "../$pkg" plugin.json backend frontend README.md -x '*/node_modules/*' -x '*/.*' -x 'frontend/dist/*')

  sha=$(sha256sum "$pkg" | awk '{print $1}')
  url="https://raw.githubusercontent.com/catalystctl/catalyst-plugins/dist/plugins/$(basename "$pkg")"
  update_entry "$name" version "$version"
  update_entry "$name" downloadUrl "$url"
  update_entry "$name" sha256 "$sha"
  published="$published $name@$version"
done

# Timestamp the index
python3 - <<'PYEOF'
import json, datetime
with open('index.json') as f:
    idx = json.load(f)
idx['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
with open('index.json', 'w') as f:
    json.dump(idx, f, indent=2)
    f.write('\n')
PYEOF

echo "published:${published:- (none)}"
echo "index.json updated"
