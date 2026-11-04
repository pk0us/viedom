#!/usr/bin/env bash
set -euo pipefail
if [ ! -s /keyfile/replica.key ]; then
  umask 077
  openssl rand -base64 756 > /keyfile/replica.key
fi
chown mongodb:mongodb /keyfile/replica.key
chmod 400 /keyfile/replica.key
