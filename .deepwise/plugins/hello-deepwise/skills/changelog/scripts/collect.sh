#!/usr/bin/env bash
# Print the last N commits as `hash\tsubject`, newest first.
set -euo pipefail
git log --oneline --no-merges -n "${1:-20}" --pretty=format:"%h%x09%s"
