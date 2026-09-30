#!/usr/bin/env bash
# Build the ZIP uploaded to platform.openai.com/plugins ("With MCP").
#
# Only the files the plugin needs are added, and they land at the archive root:
# the uploader rejects a ZIP that contains more than one plugin root, and keeps
# a top-level plugin directory only when it has no sibling files. Zipping the
# package directory itself would put build.sh and any stray editor file beside
# plugin.json, so the members are listed explicitly instead of globbed.
#
# Usage: bash scripts/build-openai-plugin.sh [output.zip]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="$repo_root/openai-plugin"
out="${1:-$repo_root/openai-plugin.zip}"

cd "$package"

# Every path referenced from plugin.json must exist, or the upload fails with a
# missing-asset error that names the field rather than the file.
node -e '
const fs = require("fs"), path = require("path");
const manifest = JSON.parse(fs.readFileSync("plugin.json", "utf8"));
const iface = manifest.extensions["com.openai"].interface;
const refs = ["composerIcon", "logo", ...(iface.screenshots || [])]
    .map((k) => (k === "composerIcon" || k === "logo" ? iface[k] : k))
    .filter(Boolean);
let bad = 0;
for (const ref of refs) {
    const file = ref.replace(/^\.\//, "");
    if (!fs.existsSync(file)) { console.error(`missing asset: ${ref}`); bad = 1; continue; }
    const { width, height } = require("child_process").execSync(
        `magick "${file}" -format "%w %h" info:`, { encoding: "utf8" }
    ).trim().split(" ").reduce((a, v, i) => (i ? { ...a, height: +v } : { width: +v }), {});
    if (width !== height) { console.error(`not square: ${ref} is ${width}x${height}`); bad = 1; }
    if (width < 48) { console.error(`too small: ${ref} is ${width}x${height}, minimum is 48x48`); bad = 1; }
    console.log(`ok ${ref} ${width}x${height}`);
}
process.exit(bad);
'

rm -f "$out"
zip -q -X "$out" plugin.json mcp.json -r assets
echo
echo "wrote $out"
unzip -l "$out"
