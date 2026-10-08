#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
THREAD_ID="${CODEX_SITES_THREAD_ID:-01a10c73-df03-7f71-b711-14d64ab22a03}"
MANIFEST="$ROOT_DIR/sites/orderly-agent/.openai/hosting.json"
if [[ ! -f "$MANIFEST" ]]; then
  MANIFEST="$ROOT_DIR/.openai/hosting.json"
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI blev ikke fundet. Installér eller åbn Codex, og prøv igen." >&2
  exit 1
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "Sites-manifestet mangler: $MANIFEST" >&2
  exit 1
fi

MESSAGE="Udgiv den nyeste lokale version af dette projekt igen via Sites. Brug projektfilerne i $ROOT_DIR og det eksisterende Site fra $MANIFEST. Brug det separate Site-checkout i sites/orderly-agent; klargør det fra det eksisterende Site, hvis det mangler. Synkroniser HTML, JavaScript, CSS og assets til Site-checkoutet, valider filerne, bevar den nuværende adgang, udgiv, og rapportér den verificerede URL."

codex queue \
  --thread "$THREAD_ID" \
  --message "$MESSAGE"

echo "Udgivelsen er sendt til Codex-chatten. Følg status i Codex-appen."
