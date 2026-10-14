#!/bin/bash

########################
# Script by John Reed  #
# debt-audit fixture   #
########################

# A shell file carrying two deferral markers: a FIXME whose text repeats
# in retry.ts (different case, spacing and trailing stop — same key text),
# and a shortcut: with no upgrade trigger. Never run; read line by line.

set -euo pipefail


# Variables
dry="${1:-}"


# Main
echo "deploying..."

# FIXME:  The timeout path is unhandled.
if [ "$dry" = "--dry-run" ]; then
  # shortcut: skip the lock file on dry runs
  echo "dry run, skipping lock..."
fi

echo "done."
exit
