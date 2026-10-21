#!/bin/sh
set -eu
if [ "$#" -ge 2 ] && [ "$1" = stapler ] && [ "$2" = staple ]; then
  exec node "${GITHUB_WORKSPACE:?}/scripts/staple-macos.js" "$@"
fi
exec /usr/bin/xcrun "$@"
