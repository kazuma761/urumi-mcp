#!/usr/bin/env bash
# End-to-end check of the brief's definition of done, with two team members.
#
#   scripts/e2e.sh
#       against the local cluster (kube context k3d-urumi, *.127.0.0.1.nip.io)
#   DOMAIN=203.0.113.10.sslip.io SCHEME=https KUBE_CONTEXT=vps scripts/e2e.sh
#       against another cluster
#   BASE=http://localhost:8090 ADMIN_PASSWORD=dev-admin-pw scripts/e2e.sh
#       gateway checks only, against apps/gateway/dev.sh (no store, no cluster)
#
# Needs curl and jq, plus kubectl for a cluster run. Written for bash 3.2, the
# one macOS ships, so JSON bodies are built with jq instead of escaped quotes.
set -uo pipefail

CONTEXT=${KUBE_CONTEXT:-k3d-urumi}
DOMAIN=${DOMAIN:-127.0.0.1.nip.io}
SCHEME=${SCHEME:-http}
if [ -n "${BASE:-}" ]; then CLUSTER=0; else CLUSTER=1; BASE=$SCHEME://app.$DOMAIN; fi
STORE=${STORE:-$SCHEME://store.$DOMAIN}
K="kubectl --context $CONTEXT"
secret() { $K -n "$1" get secret "$2" -o "jsonpath={.data.$3}" | base64 -d; }
# In a cluster run the admin's address and password are read from the cluster itself.
if [ "$CLUSTER" = 1 ]; then
  [ -n "${ADMIN_EMAIL:-}" ] || ADMIN_EMAIL=$($K -n platform get deploy gateway -o json | jq -r '.spec.template.spec.containers[0].env[] | select(.name=="ADMIN_EMAIL") | .value')
  [ -n "${ADMIN_PASSWORD:-}" ] || ADMIN_PASSWORD=$(secret platform gateway admin-password)
fi
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@urumi.local}

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0; skipped=0
ok() { echo "  PASS  $1"; pass=$((pass + 1)); }
ko() { echo "  FAIL  $1"; [ $# -gt 1 ] && echo "        got: $2"; fail=$((fail + 1)); }
skip() { echo "  SKIP  $1"; skipped=$((skipped + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "$2 (wanted $3)"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) ko "$1" "$2" ;; esac; }
lacks() { case "$2" in *"$3"*) ko "$1" "$2" ;; *) ok "$1" ;; esac; }

# Dashboard API as one user: $1 names that user's cookie jar.
api() { local jar=$1 method=$2 path=$3; shift 3; curl -s -b "$T/$jar" -c "$T/$jar" -X "$method" "$BASE$path" -H 'Content-Type: application/json' "$@"; }
code() { local jar=$1 method=$2 path=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -b "$T/$jar" -X "$method" "$BASE$path" -H 'Content-Type: application/json' "$@"; }
# One MCP request with an API key, the way an external client sends it. The
# response body is either JSON or a single server-sent event; print the JSON.
mcp_raw() { curl -s "$@" -X POST "$BASE/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream'; }
mcp() { mcp_raw -H "Authorization: Bearer $1" -d "$2" | sed -n -e 's/^data: //p' -e '/^{/p' | head -1; }
mcp_code() { mcp_raw -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" -d "$2"; }
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
tools() { mcp "$1" "$LIST" | jq -r '[.result.tools[].name] | sort | join(" ")'; }
call_body() { jq -nc --arg n "$1" --argjson a "$2" '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:$n,arguments:$a}}'; }
call() { mcp "$1" "$(call_body "$2" "$3")"; }
text() { jq -r '.result.content[0].text'; }
is_error() { jq -r '.result.isError // false'; }
# Asks the chat agent one question; prints its events, one JSON object per line.
chat() { api "$1" POST /api/chat -d "$(jq -nc --arg c "$2" '{messages:[{role:"user",content:$c}]}')"; }
server_field() { api admin GET /api/servers | jq -r --arg s "$1" --arg f "$2" '.servers[] | select(.slug==$s) | .[$f]'; }
# Polls until a server reports the wanted status. $3 = seconds to wait.
wait_status() {
  local i=0
  while [ "$i" -lt "$3" ]; do
    [ "$(server_field "$1" status)" = "$2" ] && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}

echo "Target: $BASE$([ "$CLUSTER" = 1 ] && echo ", store $STORE, kube context $CONTEXT")"

# ------------------------------------------------------------------------------
echo "Team: an admin and two members, each with an own API key"
api admin POST /api/login -d "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')" >/dev/null
check "admin logs in" "$(api admin GET /api/me | jq -r .user.role)" admin
RUN=$RANDOM
join() { # $1 = jar name; invites a member, accepts the invite, creates a key; sets EMAIL and KEY
  EMAIL="$1-$RUN@example.com"
  local invite
  invite=$(api admin POST /api/users -d "$(jq -nc --arg e "$EMAIL" '{email:$e,role:"member"}')" | jq -r .inviteToken)
  check "$1 cannot log in before accepting the invite" "$(code none POST /api/login -d "$(jq -nc --arg e "$EMAIL" '{email:$e,password:""}')")" 401
  check "$1 accepts the invite and is logged in" "$(api "$1" POST /api/invite/accept -d "$(jq -nc --arg t "$invite" '{token:$t,password:"member-pass-1"}')" | jq -r .user.role)" member
  check "$1's invite link is single use" "$(code none POST /api/invite/accept -d "$(jq -nc --arg t "$invite" '{token:$t,password:"another-pass"}')")" 400
  KEY=$(api "$1" POST /api/keys -d '{"name":"e2e"}' | jq -r .secret)
  check "$1 generates an own API key" "${KEY:0:4}" ugw_
}
join usera; A_EMAIL=$EMAIL; A_KEY=$KEY
join userb; B_EMAIL=$EMAIL; B_KEY=$KEY
ADMIN_KEY=$(api admin POST /api/keys -d '{"name":"e2e-admin"}' | jq -r .secret)
check "a member cannot add a server" "$(code userb POST /api/servers -d '{"slug":"x1","name":"x","url":"https://example.com/mcp"}')" 403
check "a member cannot list users" "$(code userb GET /api/users)" 403
check "a member's view of servers has no URL" "$(api userb GET /api/servers | jq -r '[.servers[] | has("url")] | any')" false
check "a member cannot revoke another member's key" "$(code userb DELETE "/api/keys/$(api usera GET /api/keys | jq -r '.keys[0].id')")" 404

# ------------------------------------------------------------------------------
echo "External MCP client, as user B: only the gateway URL and B's key"
check "a request without a valid key is rejected" "$(mcp_code nope "$LIST")" 401
INIT='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
check "initialize answers" "$(mcp "$B_KEY" "$INIT" | jq -r .result.serverInfo.name)" urumi-gateway
ALL=$(tools "$B_KEY")
echo "        tools: $ALL"
has "tools carry their server's prefix" "$ALL" toolbox__echo
check "a call is routed to the right server" "$(call "$B_KEY" toolbox__echo '{"message":"hi"}' | text)" HI
check "an unknown tool is a clear error, not a crash" "$(call "$B_KEY" nope__x '{}' | is_error)" true
check "bad arguments come back as a tool error" "$(call "$B_KEY" toolbox__echo '{}' | is_error)" true
check "user A's own key works the same way" "$(call "$A_KEY" toolbox__echo '{"message":"a"}' | text)" A
if [ "$CLUSTER" = 1 ]; then
  has "WooCommerce tools are listed" "$ALL" woo__list_orders
  has "the third server's tools are listed" "$ALL" everything__echo
  # Two servers expose a tool called "echo". The prefix keeps both, and each call reaches its own server.
  check "same-named tools on two servers do not collide" "$(call "$B_KEY" everything__echo '{"message":"hi"}' | text | grep -ci 'hi')" 1
  lacks "and they are different tools" "$(call "$B_KEY" everything__echo '{"message":"hi"}' | text)" HI
fi

# ------------------------------------------------------------------------------
if [ "$CLUSTER" = 1 ]; then
  echo "Store: product created through the gateway, order placed on the storefront"
  check "the storefront answers" "$(curl -s -o /dev/null -w '%{http_code}' -L "$STORE/")" 200
  PRODUCT="E2E Mug $RUN"
  CREATED=$(call "$A_KEY" woo__create_product "$(jq -nc --arg n "$PRODUCT" '{name:$n,regular_price:"249"}')")
  PRODUCT_ID=$(echo "$CREATED" | text | jq -r .id)
  [ "$PRODUCT_ID" -gt 0 ] 2>/dev/null && ok "user A creates a product through the gateway (id $PRODUCT_ID)" || ko "user A creates a product through the gateway" "$CREATED"
  # The Store API is what the storefront itself reads: public, no credentials.
  check "the product appears on the storefront" "$(curl -s -G "$STORE/wp-json/wc/store/v1/products" --data-urlencode "search=$PRODUCT" | jq -r '.[0].name')" "$PRODUCT"

  # Places an order the way the storefront's checkout does: as a guest, through the
  # public Store API, paying Cash on Delivery. Prints the order id.
  place_order() {
    local jar="$T/shopper" headers="$T/shopper.headers" nonce token
    curl -s -c "$jar" -D "$headers" -o /dev/null "$STORE/wp-json/wc/store/v1/cart"
    nonce=$(awk 'tolower($1)=="nonce:" {print $2}' "$headers" | tr -d '\r')
    token=$(awk 'tolower($1)=="cart-token:" {print $2}' "$headers" | tr -d '\r')
    shop() { curl -s -b "$jar" -c "$jar" -X POST "$STORE/wp-json/wc/store/v1/$1" -H 'Content-Type: application/json' -H "Nonce: $nonce" -H "Cart-Token: $token" -d "$2"; }
    shop cart/add-item "$(jq -nc --argjson id "$1" '{id:$id,quantity:1}')" >/dev/null
    local address
    address=$(jq -nc --arg e "shopper-$RUN@example.com" '{first_name:"E2E",last_name:"Shopper",address_1:"1 MG Road",city:"Bengaluru",state:"KA",postcode:"560001",country:"IN",email:$e,phone:"9999999999"}')
    shop checkout "$(jq -nc --argjson a "$address" '{billing_address:$a,shipping_address:$a,payment_method:"cod"}')" >"$T/checkout.json"
    jq -r '.order_id // empty' "$T/checkout.json"
  }
  ORDER_ID=$(place_order "$PRODUCT_ID")
  [ -n "$ORDER_ID" ] && ok "a guest checks out with Cash on Delivery (order $ORDER_ID)" || ko "a guest checks out with Cash on Delivery" "$(cut -c1-300 "$T/checkout.json")"
  ORDER=$(call "$B_KEY" woo__get_order "$(jq -nc --argjson id "${ORDER_ID:-0}" '{id:$id}')" | text)
  check "the order is in WooCommerce, with the product" "$(echo "$ORDER" | jq -r '.items[0].name')" "$PRODUCT"
  TODAY=$(call "$B_KEY" woo__list_orders '{"date":"today"}' | text)
  check "user B asks what orders came in today and gets that order" "$(echo "$TODAY" | jq --argjson id "${ORDER_ID:-0}" '[.orders[].id] | index($id) != null')" true
  check "an order's status can be updated" "$(call "$A_KEY" woo__update_order_status "$(jq -nc --argjson id "${ORDER_ID:-0}" '{id:$id,status:"completed"}')" | text | jq -r .status)" completed
  has "products can be listed" "$(call "$B_KEY" woo__list_products "$(jq -nc --arg s "$PRODUCT" '{search:$s}')" | text)" "$PRODUCT"

  echo "Chat agent, as user A"
  if [ "$(api usera GET /api/me | jq -r .chatEnabled)" = true ]; then
    CHAT_PRODUCT="Chat Tee $RUN"
    EVENTS=$(chat usera "Create a product called \"$CHAT_PRODUCT\" priced at 499.")
    has "the agent calls the create-product tool" "$(echo "$EVENTS" | jq -r 'select(.type=="tool_call") | .name')" woo__create_product
    check "the product it created is on the storefront" "$(curl -s -G "$STORE/wp-json/wc/store/v1/products" --data-urlencode "search=$CHAT_PRODUCT" | jq -r '.[0].name')" "$CHAT_PRODUCT"
    CHAT_ID=$(curl -s -G "$STORE/wp-json/wc/store/v1/products" --data-urlencode "search=$CHAT_PRODUCT" | jq -r '.[0].id')
    CHAT_ORDER=$(place_order "$CHAT_ID")
    EVENTS=$(chat usera "What orders came in today? List their ids.")
    has "asked about today's orders, the agent calls the list-orders tool" "$(echo "$EVENTS" | jq -r 'select(.type=="tool_call") | .name')" woo__list_orders
    has "and its answer names the order placed by hand ($CHAT_ORDER)" "$(echo "$EVENTS" | jq -r 'select(.type=="message") | .text')" "$CHAT_ORDER"
    check "the agent's calls are audited under user A, marked as chat" "$(api admin GET '/api/audit?limit=200' | jq -r --arg m "$A_EMAIL" '[.entries[] | select(.userEmail==$m and .via=="chat" and .tool=="list_orders")] | length > 0')" true
  else
    skip "chat agent: no LLM key is configured (set llm.apiKey and deploy the platform chart again)"
  fi
fi

# ------------------------------------------------------------------------------
echo "Tool permissions: a tool only admins may use"
DENIED=toolbox__percent_of; ARGS='{"part":1,"total":2}'
[ "$CLUSTER" = 1 ] && DENIED=woo__create_product && ARGS='{"name":"should not exist","regular_price":"1"}'
check "admin restricts $DENIED to admins" "$(code admin PUT /api/tool-access -d "$(jq -nc --arg t "$DENIED" '{tool:$t,memberAllowed:false}')")" 204
lacks "it is hidden from a member's tool list" "$(tools "$B_KEY")" "$DENIED"
check "and rejected when the member calls it anyway" "$(call "$B_KEY" "$DENIED" "$ARGS" | text)" "You are not allowed to use $DENIED"
has "an admin still has it" "$(tools "$ADMIN_KEY")" "$DENIED"
code admin PUT /api/tool-access -d "$(jq -nc --arg t "$DENIED" '{tool:$t,memberAllowed:true}')" >/dev/null
has "lifting the restriction gives it back" "$(tools "$B_KEY")" "$DENIED"

# ------------------------------------------------------------------------------
echo "Servers: add, edit, disable, remove"
check "a cloud metadata address is refused (SSRF)" "$(code admin POST /api/servers -d '{"slug":"meta","name":"m","url":"http://169.254.169.254/latest"}')" 400
check "a private address is refused (SSRF)" "$(code admin POST /api/servers -d '{"slug":"priv","name":"p","url":"http://10.0.0.5/mcp"}')" 400
check "a cluster-internal name is refused (SSRF)" "$(code admin POST /api/servers -d '{"slug":"internal","name":"i","url":"http://postgres.platform.svc:5432/"}')" 400
check "a bearer server without a credential is refused" "$(code admin POST /api/servers -d '{"slug":"nocred","name":"n","url":"https://example.com/mcp","authType":"bearer"}')" 400
ADDED=$(api admin POST /api/servers -d '{"slug":"extra","name":"Extra","url":"https://example.com/mcp","authType":"bearer","credential":"s3cret-token-e2e"}')
check "admin adds a server by URL and credential" "$(echo "$ADDED" | jq -r .server.slug)" extra
check "it is reported unreachable, with a reason" "$(echo "$ADDED" | jq -r '.server.status + ":" + ((.server.error // "") | length > 0 | tostring)')" unreachable:true
lacks "the credential is not in the response" "$ADDED" s3cret-token-e2e
check "that broken server does not break listing for anyone" "$(tools "$B_KEY" | grep -c toolbox__echo)" 1
EXTRA_ID=$(echo "$ADDED" | jq -r .server.id)
check "a duplicate slug is a conflict" "$(code admin POST /api/servers -d '{"slug":"extra","name":"Extra","url":"https://example.com/mcp"}')" 409
check "admin edits it" "$(api admin PATCH "/api/servers/$EXTRA_ID" -d '{"name":"Extra 2"}' | jq -r .server.name)" "Extra 2"
check "admin removes it" "$(code admin DELETE "/api/servers/$EXTRA_ID")" 204
TB_ID=$(server_field toolbox id)
check "a server declared in Helm values cannot be removed here" "$(code admin DELETE "/api/servers/$TB_ID")" 409
check "admin disables a server" "$(api admin PATCH "/api/servers/$TB_ID" -d '{"enabled":false}' | jq -r .server.status)" disabled
lacks "its tools are gone from the external client" "$(tools "$B_KEY")" toolbox__
check "and a call to one is rejected" "$(call "$B_KEY" toolbox__echo '{"message":"hi"}' | is_error)" true
check "admin enables it again" "$(api admin PATCH "/api/servers/$TB_ID" -d '{"enabled":true}' | jq -r .server.status)" connected
has "and its tools are back" "$(tools "$B_KEY")" toolbox__echo

# ------------------------------------------------------------------------------
if [ "$CLUSTER" = 1 ]; then
  echo "Failure: kill one upstream's pod"
  $K -n upstreams delete pod -l app.kubernetes.io/name=everything --wait=false >/dev/null
  check "another server answers while it is down" "$(call "$B_KEY" toolbox__echo '{"message":"still up"}' | text)" "STILL UP"
  wait_status everything unreachable 30 && ok "the dashboard shows the dead server as unreachable" || ko "the dashboard shows the dead server as unreachable" "$(server_field everything status)"
  check "listing still works while it is down" "$(tools "$B_KEY" | grep -c woo__list_orders)" 1
  wait_status everything connected 90 && ok "it reconnects once its pod is back" || ko "it reconnects once its pod is back" "$(server_field everything status): $(server_field everything error)"
else
  START=$(date +%s); REPLY=$(call "$B_KEY" dead__anything '{}' | text); TOOK=$(($(date +%s) - START))
  [ "$TOOK" -le 3 ] && ok "a dead server fails fast (${TOOK}s: $REPLY)" || ko "a dead server fails fast" "${TOOK}s"
fi

# ------------------------------------------------------------------------------
echo "Revocation and audit"
check "the API never returns a key or its hash after creation" "$(api userb GET /api/keys | jq -r '.keys[0] | has("secret") or has("keyHash")')" false
check "admin revokes user B's key" "$(code admin DELETE "/api/keys/$(api userb GET /api/keys | jq -r '.keys[0].id')")" 204
check "user B's next call is rejected" "$(mcp_code "$B_KEY" "$(call_body toolbox__echo '{"message":"x"}')")" 401
AUDIT=$(api admin GET '/api/audit?limit=500')
mine() { echo "$AUDIT" | jq -r --arg m "$1" "[.entries[] | select(.userEmail==\$m) | $2] | $3"; }
check "user B's calls are in the audit log under B" "$(mine "$B_EMAIL" 'select(.server=="toolbox" and .tool=="echo" and .outcome=="ok" and .via=="mcp")' 'length > 0')" true
has "so are the refused ones: denied" "$(mine "$B_EMAIL" .outcome 'unique | join(" ")')" denied
has "... and the call made with the revoked key" "$(mine "$B_EMAIL" .outcome 'unique | join(" ")')" rejected
check "every entry has user, server, tool, time, duration and outcome" "$(mine "$B_EMAIL" 'select(.outcome=="ok")' 'all(.userEmail and .server and .tool and .ts and (.durationMs >= 0) and .outcome)')" true
[ "$CLUSTER" = 1 ] && check "user A's calls are under A, not B" "$(mine "$A_EMAIL" 'select(.tool=="create_product")' 'length > 0')" true
check "admin removes user B" "$(code admin DELETE "/api/users/$(api admin GET /api/users | jq -r --arg m "$B_EMAIL" '.users[] | select(.email==$m) | .id')")" 204
check "user B's open dashboard session stops working" "$(code userb GET /api/me)" 401
check "user B's entries stay in the audit log" "$(api admin GET '/api/audit?limit=500' | jq -r --arg m "$B_EMAIL" '[.entries[] | select(.userEmail==$m)] | length > 0')" true
check "an admin cannot remove themselves" "$(code admin DELETE "/api/users/$(api admin GET /api/me | jq -r .user.id)")" 409
check "a member sees only own audit entries" "$(api usera GET /api/audit | jq -r --arg m "$A_EMAIL" '(.entries | length > 0) and ([.entries[] | .userEmail==$m] | all)')" true

# ------------------------------------------------------------------------------
if [ "$CLUSTER" = 1 ]; then
  echo "Isolation: what is public and what is not"
  check "the only public hosts are the store and the dashboard" "$($K get ingress -A -o json | jq -r '[.items[].spec.rules[].host] | sort | join(" ")')" "app.$DOMAIN store.$DOMAIN"
  SERVERS=$(api admin GET /api/servers)
  lacks "the WooCommerce MCP token is not in the admin's server list" "$SERVERS" "$(secret store woo-mcp bearer-token)"
  lacks "nor is the toolbox key" "$SERVERS" "$(secret upstreams toolbox api-key)"
  # A throwaway pod outside every app namespace tries each internal Service.
  # The Kubernetes API is the control: it proves the probe itself has a network.
  PROBE=$($K -n default run "e2e-probe-$RUN" --rm -i --restart=Never --quiet --image=busybox:1.37 -- sh -c '
    try() { nc -z -w 4 "$2" "$3" 2>/dev/null && echo "$1=open" || echo "$1=blocked"; }
    try control kubernetes.default.svc 443
    try woo-mcp woo-mcp.store.svc 3000
    try mariadb mariadb.store.svc 3306
    try wordpress wordpress.store.svc 80
    try postgres postgres.platform.svc 5432
    try gateway gateway.platform.svc 8080
    try toolbox toolbox.upstreams.svc 3000
    try everything everything.upstreams.svc 3001' 2>/dev/null)
  has "the probe pod has a working network (control)" "$PROBE" control=open
  for target in woo-mcp mariadb wordpress postgres gateway toolbox everything; do
    has "$target is not reachable from another namespace" "$PROBE" "$target=blocked"
  done
fi

api admin DELETE "/api/keys/$(api admin GET /api/keys | jq -r '.keys[] | select(.name=="e2e-admin" and .revokedAt==null) | .id' | head -1)" >/dev/null
echo
echo "$pass passed, $fail failed, $skipped skipped"
[ "$fail" -eq 0 ]
