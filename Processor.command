#!/bin/bash
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo "  Install the LTS version from https://nodejs.org, then run this again."
  echo
  read -r -p "Press return to close."
  exit 1
fi

node scripts/launch.mjs || {
  echo
  read -r -p "Press return to close."
}
