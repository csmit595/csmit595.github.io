set -e
cd "$(dirname "$0")"
npx esbuild entry.js --bundle --format=iife --global-name=StewardHelper --target=es2020 --charset=utf8 --legal-comments=none --minify --outfile=out/bundle.js --log-level=warning
{ echo "// Steward Google helper — built from csmit595.github.io/steward. Applies Claude's task changes and sends reminder notifications while Steward is closed."; cat out/bundle.js wrapper.gs.js; } > out/Code.gs
wc -c out/Code.gs
