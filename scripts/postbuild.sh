#!/usr/bin/env bash
# next build's standalone output (.next/standalone) never includes the
# public/ and .next/static/ asset folders, and starts with no env file —
# Next.js requires copying those in by hand after every single build.
# Skipping this step doesn't fail the build; it just leaves the server
# running with no CSS/JS assets and no runtime secrets, which only shows up
# once something tries to start it. Runs automatically after `npm run
# build` so that's no longer a manual step anyone has to remember.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d ".next/standalone" ]; then
  echo "postbuild: no .next/standalone dir (output: \"standalone\" not in next.config.ts?) — skipping"
  exit 0
fi

mkdir -p .next/standalone/public .next/standalone/.next/static
cp -r public/. .next/standalone/public/
cp -r .next/static/. .next/standalone/.next/static/
echo "postbuild: copied public/ and .next/static/ into .next/standalone/"

if [ -f .env.local ]; then
  cp .env.local .next/standalone/.env
  echo "postbuild: copied .env.local -> .next/standalone/.env"
else
  echo "postbuild: no .env.local found, skipping (fine for CI/build-only environments)"
fi
