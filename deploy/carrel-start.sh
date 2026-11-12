#!/bin/sh
# carrel-deployd (from land) runs this from the release directory on every
# deploy and rollback, as the finance user, with /srv/apps/finance/env loaded.
# The release holds the built server and web app.
set -eu
export FINANCE_DIST="$PWD/dist"
exec bun build/server.js
