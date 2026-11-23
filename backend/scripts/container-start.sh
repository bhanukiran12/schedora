#!/bin/sh
set -eu

if [ -z "${FORM_UPLOAD_DIRECTORY:-}" ]; then
  exec npm start
fi

umask 077
mkdir -p "$FORM_UPLOAD_DIRECTORY"
cat > /tmp/schedora-freshclam.conf <<'CONFIG'
DatabaseOwner root
DatabaseDirectory /var/lib/clamav
DatabaseMirror database.clamav.net
Checks 12
Foreground yes
LogTime yes
CONFIG

# The image includes a signed database so startup does not depend on a mirror download.
# FreshClam refreshes it in the background. The scanner refuses an outdated database.
freshclam --config-file=/tmp/schedora-freshclam.conf --daemon --foreground &
updater_pid=$!
node --disable-warning=ExperimentalWarning server.mjs &
app_pid=$!
trap 'kill "$app_pid" "$updater_pid" 2>/dev/null || true; wait 2>/dev/null || true' TERM INT EXIT
wait "$app_pid"
