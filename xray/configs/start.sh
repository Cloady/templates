#!/bin/sh
set -eu

RAW=$(printf '%s' "${CLIENT_ID:-}" | sed 's/[[:space:]-]//g' | tr 'A-F' 'a-f')
case "$RAW" in
  ????????????????????????????????) ;;
  *) echo "CLIENT_ID must be a UUID or 32 hexadecimal characters" >&2; exit 1 ;;
esac
case "$RAW" in
  *[!0-9a-f]*) echo "CLIENT_ID must be a UUID or 32 hexadecimal characters" >&2; exit 1 ;;
esac

ID=$(printf '%s' "$RAW" | sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/')
WS="/${WS_PATH#/}"
HOST="${PUBLIC_HOST:-localhost}"

cat > /tmp/config.json <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "listen": "::",
      "port": 8080,
      "protocol": "vless",
      "settings": { "clients": [{ "id": "$ID" }], "decryption": "none" },
      "streamSettings": { "network": "ws", "wsSettings": { "path": "$WS" } },
      "sniffing": { "enabled": true, "destOverride": ["http", "tls", "quic"], "routeOnly": true }
    }
  ],
  "outbounds": [
    { "protocol": "freedom", "tag": "direct" },
    { "protocol": "blackhole", "tag": "block" }
  ],
  "routing": {
    "rules": [
      { "type": "field", "protocol": ["bittorrent"], "outboundTag": "block" },
      { "type": "field", "port": "25", "outboundTag": "block" },
      {
        "type": "field",
        "ip": ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "fe80::/10", "::1/128"],
        "outboundTag": "block"
      }
    ]
  }
}
EOF

ENCODED_PATH=$(printf '%s' "$WS" | sed 's#/#%2F#g')
echo "VLESS client link: vless://$ID@$HOST:443?encryption=none&security=tls&sni=$HOST&type=ws&host=$HOST&path=$ENCODED_PATH#Cloady"

exec /usr/bin/xray run -config /tmp/config.json
