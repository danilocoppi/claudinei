#!/usr/bin/env bash
#
# install-emoji-font.sh — instala a Noto Color Emoji atual na pasta de fontes
# do usuário (~/.local/share/fonts), sem sudo, para que emojis novos (Unicode
# recente) renderizem corretamente no Claudinei e em todos os apps.
#
# Contexto: distros como o Ubuntu 20.04 / Zorin 16 trazem uma Noto Color Emoji
# de 2020 que não tem emojis mais novos (aparecem como caixinhas). Este script
# baixa a versão atual do repositório oficial do Google e atualiza o cache de
# fontes. Depois, FECHE E REABRA o navegador completamente (ele só relê as
# fontes do sistema ao reiniciar todos os processos).
#
# Uso:  ./scripts/install-emoji-font.sh
#
set -euo pipefail

FONT_URL="https://github.com/googlefonts/noto-emoji/raw/main/fonts/NotoColorEmoji.ttf"
DEST_DIR="${HOME}/.local/share/fonts"
DEST="${DEST_DIR}/NotoColorEmoji.ttf"

echo "==> Instalando Noto Color Emoji (atual) em ${DEST}"
mkdir -p "${DEST_DIR}"

if command -v curl >/dev/null 2>&1; then
  curl -fSL -o "${DEST}" "${FONT_URL}"
elif command -v wget >/dev/null 2>&1; then
  wget -O "${DEST}" "${FONT_URL}"
else
  echo "erro: preciso de curl ou wget para baixar a fonte." >&2
  exit 1
fi

size=$(stat -c%s "${DEST}" 2>/dev/null || stat -f%z "${DEST}")
if [ "${size}" -lt 1000000 ]; then
  echo "erro: o arquivo baixado parece pequeno demais (${size} bytes) — download falhou?" >&2
  exit 1
fi
echo "==> Baixado (${size} bytes)."

echo "==> Atualizando o cache de fontes (fc-cache)…"
if command -v fc-cache >/dev/null 2>&1; then
  fc-cache -f "${DEST_DIR}" >/dev/null 2>&1 || true
  if command -v fc-match >/dev/null 2>&1; then
    preferred=$(fc-match -v emoji 2>/dev/null | grep -m1 'file:' | sed 's/.*"\(.*\)".*/\1/')
    echo "==> Fonte de emoji preferida agora: ${preferred:-desconhecida}"
  fi
else
  echo "aviso: fc-cache não encontrado; a fonte foi copiada, mas atualize o cache manualmente." >&2
fi

echo
echo "✅ Pronto. Agora FECHE E REABRA o navegador completamente (não só um refresh)"
echo "   para ele carregar a fonte nova. Os emojis novos passarão a aparecer coloridos."
