#!/usr/bin/env bash
# One-time setup for the image-cutout skill: venv + rembg + isnet-anime weights.
# ~300 MB download (~100 MB deps + 176 MB model). Ask the user before running.
set -euo pipefail

ENV="${CUTOUT_VENV:-$HOME/.cache/pi-cutout}"
mkdir -p "$ENV"
cd "$ENV"

if [ ! -x .venv/bin/python ]; then
  uv venv --python 3.12 .venv
fi
uv pip install --python .venv/bin/python "rembg[cpu]" pillow numpy scipy

# warm up so the 176 MB isnet-anime weights land in ~/.rembg/models
.venv/bin/python - <<'PY'
from rembg import new_session
new_session("isnet-anime")
print("isnet-anime ready")
PY

echo "env: $ENV/.venv/bin/python"
