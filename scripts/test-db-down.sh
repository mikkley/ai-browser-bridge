#!/usr/bin/env bash
set -euo pipefail
docker rm -f bridge-test-pg >/dev/null 2>&1 || true
echo "bridge-test-pg removed"
