#!/bin/bash
# Startet einen einfachen Webserver auf dem Mac. Die Karte ist dann im WLAN erreichbar.
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "IP unbekannt")

echo ""
echo "  🚲 Fahrradkarte Sachsen-Anhalt Süd"
echo "  ---------------------------------------------"
echo "  Auf diesem Mac:   http://localhost:$PORT/"
echo "  Im WLAN:          http://$IP:$PORT/"
echo "  Einbinden:        http://$IP:$PORT/demo.html"
echo ""
echo "  Zum Beenden: Strg+C"
echo "  ---------------------------------------------"
echo ""

python3 -m http.server "$PORT" --bind 0.0.0.0
