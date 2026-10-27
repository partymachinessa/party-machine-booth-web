#!/bin/zsh
# Make a booth code for a new client:   ./new-code.sh "Client name"
# Switch a code off:                     ./new-code.sh off PM-ABC123
export PATH=~/.local/node/bin:$PATH
cd "${0:A:h}"
if [[ "$1" == "off" ]]; then
  npx wrangler kv key put --binding BOOTH --remote "code:$2" '{"name":"(switched off)","active":false}' && echo "$2 switched off"
  exit
fi
name="${1:?Usage: ./new-code.sh \"Client name\"}"
code="PM-$(LC_ALL=C tr -dc 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' </dev/urandom | head -c 6)"
json=$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1],"active":True}))' "$name")
npx wrangler kv key put --binding BOOTH --remote "code:$code" "$json" >/dev/null && echo "Booth code for $name: $code"
