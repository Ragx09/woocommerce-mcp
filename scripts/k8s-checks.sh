#!/usr/bin/env bash
# Cluster checks with explicit PASS/FAIL lines. Usage: scripts/k8s-checks.sh netpol|rbac|stores|hosted|rogue|ingress|killpod|metrics|replicas|all
set -uo pipefail
STORE=store PLATFORM=platform DOMAIN="${DOMAIN:-127.0.0.1.nip.io}"
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails+1)); }

# probe <namespace> <labels> <host> <port> → prints OPEN or CLOSED (TCP connect, 4 s timeout).
# The pod waits 3 s first: k3s's policy controller needs a moment to add a new pod's IP to the
# allow rules, and connecting immediately can give a false CLOSED. One retry on a lost result.
probe() {
  local i out
  for i in 1 2; do
    out=$(kubectl -n "$1" run "probe-$RANDOM$RANDOM" --rm -i --restart=Never --quiet --image=busybox:1.36 --labels="$2" \
      --overrides='{"spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"probe","image":"busybox:1.36","command":["sh","-c","sleep 3; nc -z -w 4 '"$3 $4"' && echo OPEN || echo CLOSED"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' \
      2>/dev/null | grep -E '^(OPEN|CLOSED)$' | tail -1)
    [ -n "$out" ] && { echo "$out"; return; }
  done
}
expect() { # expect <OPEN|CLOSED> <description> <probe args...>
  local want="$1" desc="$2"; shift 2
  local got; got="$(probe "$@")"
  [ "$got" = "$want" ] && pass "$desc → $got" || fail "$desc → ${got:-no result} (want $want)"
}

# TC-BON-09-2 (D-026): what the provisioner's account may and may not do. RBAC via `kubectl auth can-i --as`,
# the admission policy via real requests (server-side dry run where possible) as that account.
rbac() {
  local sa="system:serviceaccount:$PLATFORM:provisioner" t="store-rbactest"
  local as=(--as="$sa")
  can() { # can <yes|no> <description> <can-i args...>
    local want="$1" desc="$2"; shift 2
    local got; got="$(kubectl auth can-i "${as[@]}" "$@" 2>/dev/null)"
    [ "$got" = "$want" ] && pass "$desc → $got" || fail "$desc → $got (want $want)"
  }
  denied() { # denied <description> <kubectl args...>: must be refused by RBAC or the admission policy
    local desc="$1"; shift
    local out; out="$(kubectl "${as[@]}" "$@" 2>&1)"
    if echo "$out" | grep -qiE 'forbidden|denied|ValidatingAdmissionPolicy'; then pass "$desc → refused ($(echo "$out" | grep -oiE 'ValidatingAdmissionPolicy|forbidden' | head -1))"; else fail "$desc → not refused: $(echo "$out" | head -1)"; fi
  }
  allowed() { local desc="$1"; shift; if kubectl "${as[@]}" "$@" >/dev/null 2>&1; then pass "$desc → allowed"; else fail "$desc → refused: $(kubectl "${as[@]}" "$@" 2>&1 | head -1)"; fi; }
  # Cluster scope: namespaces and bind store-manager only.
  can yes "TC-BON-09-2a create namespaces" create namespaces
  can yes "TC-BON-09-2b bind clusterrole/store-manager" bind clusterrole/store-manager
  can no  "TC-BON-09-2c bind clusterrole/cluster-admin" bind clusterrole/cluster-admin
  can no  "TC-BON-09-2d create clusterrolebindings" create clusterrolebindings
  can no  "TC-BON-09-2e create clusterroles" create clusterroles
  can no  "TC-BON-09-2f escalate roles" escalate roles -n "$t"
  can no  "TC-BON-09-2g impersonate users" impersonate users
  can no  "TC-BON-09-2h read secrets in $PLATFORM" get secrets -n "$PLATFORM"
  can no  "TC-BON-09-2i read secrets in the default store ($STORE)" get secrets -n "$STORE"
  can no  "TC-BON-09-2j create deployments in $PLATFORM" create deployments -n "$PLATFORM"
  can no  "TC-BON-09-2k create pods/exec anywhere" create pods/exec -n "$STORE"
  can no  "TC-BON-09-2l list nodes" list nodes
  # Admission policy: names, labels, Pod Security and role bindings.
  denied "TC-BON-09-2m namespace kube-evil" create namespace kube-evil --dry-run=server
  denied "TC-BON-09-2n namespace store-nolabel (no platform.io/store)" create namespace store-nolabel --dry-run=server
  denied "TC-BON-09-2o delete the default store namespace ($STORE)" delete namespace "$STORE" --dry-run=server
  denied "TC-BON-09-2p delete namespace kube-system" delete namespace kube-system --dry-run=server
  local nsjson='{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"NAME","labels":{"platform.io/store":"SLUG"PSS}}}'
  echo "${nsjson/NAME/store-nopss}" | sed 's/SLUG/nopss/; s/PSS//' | denied "TC-BON-09-2q store namespace without Pod Security restricted" create -f - --dry-run=server
  echo "${nsjson/NAME/store-mismatch}" | sed 's/SLUG/other/; s/PSS/,"pod-security.kubernetes.io\/enforce":"restricted"/' | denied "TC-BON-09-2r label not matching the name" create -f - --dry-run=server
  echo "${nsjson/NAME/$t}" | sed 's/SLUG/rbactest/; s/PSS/,"pod-security.kubernetes.io\/enforce":"restricted"/' | allowed "TC-BON-09-2s labelled store namespace $t" create -f -
  local rb='{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"RoleBinding","metadata":{"name":"NAME","namespace":"NS"},"roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":"ClusterRole","name":"ROLE"},"subjects":[{"kind":"ServiceAccount","name":"SUBJ","namespace":"'"$PLATFORM"'"}]}'
  echo "$rb" | sed "s/NAME/x/; s/NS/$t/; s/ROLE/cluster-admin/; s/SUBJ/provisioner/" | denied "TC-BON-09-2t RoleBinding to cluster-admin in $t" create -f - --dry-run=server
  echo "$rb" | sed "s/NAME/x/; s/NS/$t/; s/ROLE/store-manager/; s/SUBJ/gateway/" | denied "TC-BON-09-2u store-manager bound to another account" create -f - --dry-run=server
  echo "$rb" | sed "s/NAME/x/; s/NS/kube-system/; s/ROLE/store-manager/; s/SUBJ/provisioner/" | denied "TC-BON-09-2v store-manager RoleBinding in kube-system" create -f - --dry-run=server
  echo "$rb" | sed "s/NAME/provisioner-store-manager/; s/NS/$t/; s/ROLE/store-manager/; s/SUBJ/provisioner/" | allowed "TC-BON-09-2w store-manager RoleBinding in $t" create -f -
  # Inside a store namespace: the chart's kinds, nothing more.
  can yes "TC-BON-09-2x create deployments in $t" create deployments -n "$t"
  can yes "TC-BON-09-2y create networkpolicies in $t" create networkpolicies -n "$t"
  can no  "TC-BON-09-2z create roles in $t" create roles -n "$t"
  can no  "TC-BON-09-2aa create pods/exec in $t" create pods/exec -n "$t"
  can no  "TC-BON-09-2ab create daemonsets in $t" create daemonsets -n "$t"
  allowed "TC-BON-09-2ac delete $t" delete namespace "$t" --wait=false
  # BON-10 (D-029): hosted-* namespaces follow the same rules with their own role.
  local th="hosted-rbactest"
  can yes "TC-BON-10-3a bind clusterrole/hosted-manager" bind clusterrole/hosted-manager
  local hns='{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"NAME","labels":{"platform.io/hosted":"SLUG"PSS}}}'
  echo "${hns/NAME/hosted-nopss}" | sed 's/SLUG/nopss/; s/PSS//' | denied "TC-BON-10-3b hosted namespace without Pod Security restricted" create -f - --dry-run=server
  echo "${hns/NAME/hosted-mismatch}" | sed 's/SLUG/other/; s/PSS/,"pod-security.kubernetes.io\/enforce":"restricted"/' | denied "TC-BON-10-3c hosted label not matching the name" create -f - --dry-run=server
  echo "${hns/NAME/hosted-store}" | sed 's/platform.io\/hosted/platform.io\/store/; s/SLUG/store/; s/PSS/,"pod-security.kubernetes.io\/enforce":"restricted"/' | denied "TC-BON-10-3d hosted-* namespace carrying the store label" create -f - --dry-run=server
  echo "${hns/NAME/$th}" | sed 's/SLUG/rbactest/; s/PSS/,"pod-security.kubernetes.io\/enforce":"restricted"/' | allowed "TC-BON-10-3e labelled hosted namespace $th" create -f -
  echo "$rb" | sed "s/NAME/x/; s/NS/$th/; s/ROLE/store-manager/; s/SUBJ/provisioner/" | denied "TC-BON-10-3f store-manager bound in a hosted namespace" create -f - --dry-run=server
  echo "$rb" | sed "s/NAME/x/; s/NS/$t/; s/ROLE/hosted-manager/; s/SUBJ/provisioner/" | denied "TC-BON-10-3g hosted-manager bound in a store namespace" create -f - --dry-run=server
  echo "$rb" | sed "s/NAME/x/; s/NS/$th/; s/ROLE/hosted-manager/; s/SUBJ/gateway/" | denied "TC-BON-10-3h hosted-manager bound to another account" create -f - --dry-run=server
  echo "$rb" | sed "s/NAME/provisioner-hosted-manager/; s/NS/$th/; s/ROLE/hosted-manager/; s/SUBJ/provisioner/" | allowed "TC-BON-10-3i hosted-manager RoleBinding in $th" create -f -
  can yes "TC-BON-10-3j create deployments in $th" create deployments -n "$th"
  can no  "TC-BON-10-3k create statefulsets in $th" create statefulsets -n "$th"
  can no  "TC-BON-10-3l create jobs in $th" create jobs -n "$th"
  can no  "TC-BON-10-3m create persistentvolumeclaims in $th" create persistentvolumeclaims -n "$th"
  can no  "TC-BON-10-3n create ingresses in $th" create ingresses -n "$th"
  can no  "TC-BON-10-3o create pods/exec in $th" create pods/exec -n "$th"
  allowed "TC-BON-10-3p delete $th" delete namespace "$th" --wait=false
  # The gateway still mounts no token and has no RBAC account.
  local gw; gw="$(kubectl -n "$PLATFORM" get deploy gateway -o jsonpath='{.spec.template.spec.automountServiceAccountToken}/{.spec.template.spec.serviceAccountName}/{.spec.template.spec.volumes[*].projected}')"
  [ "$gw" = "false/workload/" ] && pass "TC-BON-09-2ad gateway: no token, account workload ($gw)" || fail "TC-BON-09-2ad gateway token/account: $gw"
  can no "TC-BON-09-2ae workload account in $PLATFORM has no rights" --as="system:serviceaccount:$PLATFORM:workload" get pods -n "$PLATFORM"
}

netpol() {
  local woo="woo-mcp.$STORE.svc.cluster.local" db="mariadb.$STORE.svc.cluster.local" wp="wordpress.$STORE.svc.cluster.local"
  # TC-SEC-02: upstream MCP server reachable only from the gateway.
  expect CLOSED "TC-SEC-02a woo-mcp from a random pod in $PLATFORM" "$PLATFORM" app=intruder "$woo" 80
  expect CLOSED "TC-SEC-02b woo-mcp from a random pod in $STORE" "$STORE" app=intruder "$woo" 80
  expect CLOSED "TC-SEC-02c woo-mcp from default namespace" default app=gateway "$woo" 80
  expect OPEN   "TC-SEC-02d woo-mcp from app=gateway in $PLATFORM" "$PLATFORM" app=gateway "$woo" 80
  # TC-SEC-03: database reachable only from WordPress.
  expect CLOSED "TC-SEC-03a mariadb from a random pod in $STORE" "$STORE" app=intruder "$db" 3306
  expect CLOSED "TC-SEC-03b mariadb from the gateway" "$PLATFORM" app=gateway "$db" 3306
  expect OPEN   "TC-SEC-03c mariadb from app=wordpress" "$STORE" app=wordpress "$db" 3306
  # WordPress itself is public only through Traefik.
  expect CLOSED "wordpress from a random pod in $PLATFORM" "$PLATFORM" app=intruder "$wp" 80
  # GW-13: everything-mcp ← the gateway only, and it cannot open connections itself (gzip tool SSRF).
  local ev="everything-mcp.$PLATFORM.svc.cluster.local"
  expect CLOSED "TC-GW-13-2a everything-mcp from a random pod in $PLATFORM" "$PLATFORM" app=intruder "$ev" 80
  expect CLOSED "TC-GW-13-2b everything-mcp from $STORE" "$STORE" app=gateway "$ev" 80
  expect OPEN   "TC-GW-13-2c everything-mcp from app=gateway in $PLATFORM" "$PLATFORM" app=gateway "$ev" 80
  # F-INF-2: egress default-deny. Internet target 1.1.1.1:443 (reachable from the cluster without policies).
  local inet=1.1.1.1 pg="postgres.$PLATFORM.svc.cluster.local"
  expect CLOSED "TC-SEC-10a internet from app=wordpress" "$STORE" app=wordpress "$inet" 443
  expect CLOSED "TC-SEC-10b internet from app=mariadb" "$STORE" app=mariadb "$inet" 443
  expect CLOSED "TC-SEC-10c internet from app=postgres" "$PLATFORM" app=postgres "$inet" 443
  expect CLOSED "TC-SEC-10d internet from a random pod in $PLATFORM" "$PLATFORM" app=intruder "$inet" 443
  expect OPEN   "TC-SEC-10e internet (remote MCP / LLM) from app=gateway" "$PLATFORM" app=gateway "$inet" 443
  expect CLOSED "TC-SEC-10f cloud metadata 169.254.169.254 from app=gateway" "$PLATFORM" app=gateway 169.254.169.254 80
  expect CLOSED "TC-SEC-10g Kubernetes API 10.43.0.1 from app=gateway" "$PLATFORM" app=gateway 10.43.0.1 443
  expect CLOSED "TC-SEC-10h mariadb from app=gateway" "$PLATFORM" app=gateway "$db" 3306
  expect OPEN   "TC-SEC-10i postgres from app=gateway" "$PLATFORM" app=gateway "$pg" 5432
  expect OPEN   "TC-SEC-10j internet 443 (WooCommerce download) from app=wp-init" "$STORE" app=wp-init "$inet" 443
  local out
  # Raw TCP connect to the API server's ClusterIP (the gateway, with open egress, gets OPEN here).
  out=$(kubectl -n "$PLATFORM" exec deploy/everything-mcp -- node -e \
    "const s=require('net').connect(443,'$(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}')');s.setTimeout(4000);s.on('connect',()=>{console.log('OPEN');s.destroy()});s.on('timeout',()=>{console.log('CLOSED');s.destroy()});s.on('error',()=>console.log('CLOSED'))" 2>/dev/null)
  [ "$out" = CLOSED ] && pass "TC-GW-13-2d everything-mcp egress (API server by IP) → CLOSED" || fail "TC-GW-13-2d everything-mcp egress → ${out:-no result} (want CLOSED)"
  # UI-20: the dashboard (static nginx) accepts only Traefik and opens no connections itself.
  local dash="dashboard.$PLATFORM.svc.cluster.local"
  expect CLOSED "TC-UI-20-1a dashboard from a random pod in $PLATFORM" "$PLATFORM" app=intruder "$dash" 80
  expect CLOSED "TC-UI-20-1b dashboard from app=gateway in $PLATFORM" "$PLATFORM" app=gateway "$dash" 80
  out=$(kubectl -n "$PLATFORM" exec deploy/dashboard -- sh -c \
    "nc -z -w 4 $(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}') 443 && echo OPEN || echo CLOSED" 2>/dev/null)
  [ "$out" = CLOSED ] && pass "TC-UI-20-1c dashboard egress (API server by IP) → CLOSED" || fail "TC-UI-20-1c dashboard egress → ${out:-no result} (want CLOSED)"
}

# TC-BON-14-1 / TC-BON-14-2 (D-026, A-11): isolation and guardrails of CREATED stores. Needs two stores made through
# the dashboard (or `scripts/e2e.sh stores`); checks the first two it finds. Probes run from pods that carry the
# labels the policies key on, so a "yes" here means the policy allows exactly that and nothing wider.
stores() {
  local -a slugs; read -r -a slugs <<<"$(kubectl get ns -l platform.io/store -o jsonpath='{.items[*].metadata.labels.platform\.io/store}')"
  if [ "${#slugs[@]}" -lt 2 ]; then fail "TC-BON-14-1 needs two created stores (found ${#slugs[@]}): create them in the dashboard first"; return; fi
  local a="${slugs[0]}" b="${slugs[1]}"; local na="store-$a" nb="store-$b"
  local a_db="mariadb.$na.svc.cluster.local" a_wp="wordpress.$na.svc.cluster.local" a_mcp="woo-mcp.$na.svc.cluster.local"
  local b_db="mariadb.$nb.svc.cluster.local" b_wp="wordpress.$nb.svc.cluster.local" b_mcp="woo-mcp.$nb.svc.cluster.local"
  echo "# checking created stores: $a ($na) and $b ($nb)"
  # Cross-store: nothing in A reaches anything in B, whatever label it carries.
  expect CLOSED "TC-BON-14-1a A woo-mcp → B mariadb" "$na" app=woo-mcp "$b_db" 3306
  expect CLOSED "TC-BON-14-1b A woo-mcp → B wordpress" "$na" app=woo-mcp "$b_wp" 80
  expect CLOSED "TC-BON-14-1c A woo-mcp → B woo-mcp" "$na" app=woo-mcp "$b_mcp" 80
  expect CLOSED "TC-BON-14-1d A wordpress → B mariadb" "$na" app=wordpress "$b_db" 3306
  expect CLOSED "TC-BON-14-1e A wordpress → B wordpress" "$na" app=wordpress "$b_wp" 80
  expect CLOSED "TC-BON-14-1f B wordpress → A mariadb" "$nb" app=wordpress "$a_db" 3306
  expect CLOSED "TC-BON-14-1g A wp-init → B mariadb" "$na" app=wp-init "$b_db" 3306
  # Same store: only the intended paths.
  expect OPEN   "TC-BON-14-1h A wordpress → A mariadb" "$na" app=wordpress "$a_db" 3306
  expect OPEN   "TC-BON-14-1i A woo-mcp → A wordpress" "$na" app=woo-mcp "$a_wp" 80
  expect CLOSED "TC-BON-14-1j A woo-mcp → A mariadb (no direct DB access)" "$na" app=woo-mcp "$a_db" 3306
  expect CLOSED "TC-BON-14-1k a random pod in A → A mariadb" "$na" app=intruder "$a_db" 3306
  expect CLOSED "TC-BON-14-1l a random pod in A → A woo-mcp" "$na" app=intruder "$a_mcp" 80
  expect CLOSED "TC-BON-14-1m a random pod in A → A wordpress" "$na" app=intruder "$a_wp" 80
  # The platform and the default store.
  expect OPEN   "TC-BON-14-1n gateway → A woo-mcp (the one allowed way in)" "$PLATFORM" app=gateway "$a_mcp" 80
  expect CLOSED "TC-BON-14-1o gateway → A mariadb" "$PLATFORM" app=gateway "$a_db" 3306
  expect CLOSED "TC-BON-14-1p gateway → A wordpress" "$PLATFORM" app=gateway "$a_wp" 80
  expect CLOSED "TC-BON-14-1q a random pod in $PLATFORM → A woo-mcp" "$PLATFORM" app=intruder "$a_mcp" 80
  expect CLOSED "TC-BON-14-1r default store wordpress → A mariadb" "$STORE" app=wordpress "$a_db" 3306
  expect CLOSED "TC-BON-14-1s default store woo-mcp → A woo-mcp" "$STORE" app=woo-mcp "$a_mcp" 80
  expect CLOSED "TC-BON-14-1t A wordpress → postgres" "$na" app=wordpress "postgres.$PLATFORM.svc.cluster.local" 5432
  expect CLOSED "TC-BON-14-1u A woo-mcp → gateway" "$na" app=woo-mcp "gateway.$PLATFORM.svc.cluster.local" 80
  expect CLOSED "TC-BON-14-1v internet from A wordpress" "$na" app=wordpress 1.1.1.1 443
  expect CLOSED "TC-BON-14-1w internet from A woo-mcp" "$na" app=woo-mcp 1.1.1.1 443
  expect CLOSED "TC-BON-14-1x Kubernetes API from A woo-mcp" "$na" app=woo-mcp "$(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}')" 443
  # TC-BON-14-2: quota and Pod Security hold in every created namespace.
  local ns out
  for ns in "$na" "$nb"; do
    kubectl -n "$ns" get resourcequota store >/dev/null 2>&1 && pass "TC-BON-14-2a $ns has its ResourceQuota" || fail "TC-BON-14-2a $ns has no ResourceQuota"
    kubectl -n "$ns" get limitrange store >/dev/null 2>&1 && pass "TC-BON-14-2b $ns has its LimitRange" || fail "TC-BON-14-2b $ns has no LimitRange"
    out="$(kubectl -n "$ns" run quota-probe --image=busybox:1.36 --restart=Never --dry-run=server \
      --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"p","image":"busybox:1.36","command":["true"],"resources":{"limits":{"cpu":"64","memory":"512Mi"},"requests":{"cpu":"64","memory":"64Mi"}},"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' 2>&1)"
    echo "$out" | grep -qiE 'exceeded quota|maximum cpu usage|forbidden' && pass "TC-BON-14-2c $ns refuses a pod beyond its quota" || fail "TC-BON-14-2c $ns accepted an oversized pod: $(echo "$out" | head -1)"
    out="$(kubectl -n "$ns" run root-probe --image=busybox:1.36 --restart=Never --dry-run=server --overrides='{"spec":{"containers":[{"name":"p","image":"busybox:1.36","command":["true"],"securityContext":{"runAsUser":0}}]}}' 2>&1)"
    echo "$out" | grep -qiE 'violates PodSecurity|forbidden' && pass "TC-BON-14-2d $ns refuses a root pod (Pod Security restricted)" || fail "TC-BON-14-2d $ns accepted a root pod: $(echo "$out" | head -1)"
    out="$(kubectl -n "$ns" get serviceaccount workload -o jsonpath='{.automountServiceAccountToken}' 2>/dev/null)"
    [ "$out" = false ] && pass "TC-BON-14-2e $ns workloads get no service account token" || fail "TC-BON-14-2e $ns workload ServiceAccount automount = ${out:-missing}"
  done
}

# TC-BON-10-3 (D-029): a hosted MCP server is untrusted. Probes run from pods carrying the hosted label, inside the
# server's own namespace, so a "CLOSED" means the policies stop exactly what a compromised image could try.
hosted() {
  local -a slugs; read -r -a slugs <<<"$(kubectl get ns -l platform.io/hosted -o jsonpath='{.items[*].metadata.labels.platform\.io/hosted}')"
  if [ "${#slugs[@]}" -lt 1 ]; then fail "TC-BON-10-3 needs one hosted server (found none): add one in the dashboard or run scripts/e2e.sh hosted with KEEP=1"; return; fi
  local a="${slugs[0]}" na="hosted-${slugs[0]}"
  local svc="server.$na.svc.cluster.local" port; port="$(kubectl -n "$na" get deploy server -o jsonpath='{.spec.template.spec.containers[0].ports[0].containerPort}')"
  local api; api="$(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}')"
  echo "# checking hosted server: $a ($na, port $port)"
  expect OPEN   "TC-BON-10-3-1 gateway → hosted server (the one allowed way in)" "$PLATFORM" app=gateway "$svc" 80
  expect CLOSED "TC-BON-10-3-2 a random pod in $PLATFORM → hosted server" "$PLATFORM" app=intruder "$svc" 80
  expect CLOSED "TC-BON-10-3-3 the dashboard → hosted server" "$PLATFORM" app=dashboard "$svc" 80
  expect CLOSED "TC-BON-10-3-4 the provisioner → hosted server" "$PLATFORM" app=provisioner "$svc" 80
  expect CLOSED "TC-BON-10-3-5 a random pod in the default store → hosted server" "$STORE" app=intruder "$svc" 80
  expect CLOSED "TC-BON-10-3-6 the default store's woo-mcp → hosted server" "$STORE" app=woo-mcp "$svc" 80
  expect CLOSED "TC-BON-10-3-7 a random pod in its own namespace → hosted server" "$na" app=intruder "$svc" 80
  # Outbound: nothing reaches the cluster; the internet only when the admin allowed it.
  expect CLOSED "TC-BON-10-3-8 hosted → default store woo-mcp" "$na" app=hosted-server "woo-mcp.$STORE.svc.cluster.local" 80
  expect CLOSED "TC-BON-10-3-9 hosted → default store mariadb" "$na" app=hosted-server "mariadb.$STORE.svc.cluster.local" 3306
  expect CLOSED "TC-BON-10-3-10 hosted → default store wordpress" "$na" app=hosted-server "wordpress.$STORE.svc.cluster.local" 80
  expect CLOSED "TC-BON-10-3-11 hosted → postgres" "$na" app=hosted-server "postgres.$PLATFORM.svc.cluster.local" 5432
  expect CLOSED "TC-BON-10-3-12 hosted → gateway" "$na" app=hosted-server "gateway.$PLATFORM.svc.cluster.local" 80
  expect CLOSED "TC-BON-10-3-13 hosted → Kubernetes API" "$na" app=hosted-server "$api" 443
  expect CLOSED "TC-BON-10-3-14 hosted → cloud metadata" "$na" app=hosted-server 169.254.169.254 80
  local other; for other in "${slugs[@]:1}"; do expect CLOSED "TC-BON-10-3-15 hosted → another hosted server ($other)" "$na" app=hosted-server "server.hosted-$other.svc.cluster.local" 80; done
  local st; for st in $(kubectl get ns -l platform.io/store -o jsonpath='{.items[*].metadata.name}'); do
    expect CLOSED "TC-BON-10-3-16 hosted → created store $st (woo-mcp)" "$na" app=hosted-server "woo-mcp.$st.svc.cluster.local" 80
  done
  if kubectl -n "$na" get networkpolicy server-egress >/dev/null 2>&1; then
    expect OPEN   "TC-BON-10-3-17 internet 443 (the admin allowed egress)" "$na" app=hosted-server 1.1.1.1 443
    expect CLOSED "TC-BON-10-3-18 internet port 80 even with egress allowed" "$na" app=hosted-server 1.1.1.1 80
  else
    expect CLOSED "TC-BON-10-3-17 internet 443 (no egress allowed)" "$na" app=hosted-server 1.1.1.1 443
  fi
  # The workload itself.
  local pod; pod="$(kubectl -n "$na" get pod -l app=hosted-server -o json)"
  local sc; sc="$(echo "$pod" | python3 -c "import json,sys; p=json.load(sys.stdin)['items'][0]; c=p['spec']['containers'][0]; s=c['securityContext']; ps=p['spec']['securityContext']; print(ps.get('runAsNonRoot'), ps.get('runAsUser'), s.get('readOnlyRootFilesystem'), s.get('allowPrivilegeEscalation'), 'ALL' in s['capabilities']['drop'], p['spec'].get('automountServiceAccountToken'), bool(c['resources'].get('limits')))")"
  [ "$sc" = "True 10001 True False True False True" ] && pass "TC-BON-10-3-19 pod: non-root, read-only fs, no escalation, no capabilities, no token, limits ($sc)" || fail "TC-BON-10-3-19 pod security: $sc"
  local out
  out="$(kubectl -n "$na" run root-probe --image=busybox:1.36 --restart=Never --dry-run=server --overrides='{"spec":{"containers":[{"name":"p","image":"busybox:1.36","command":["true"],"securityContext":{"runAsUser":0}}]}}' 2>&1)"
  echo "$out" | grep -qiE 'violates PodSecurity|forbidden' && pass "TC-BON-10-3-20 $na refuses a root pod (Pod Security restricted)" || fail "TC-BON-10-3-20 $na accepted a root pod: $(echo "$out" | head -1)"
  out="$(kubectl -n "$na" run quota-probe --image=busybox:1.36 --restart=Never --dry-run=server --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"p","image":"busybox:1.36","command":["true"],"resources":{"limits":{"cpu":"64","memory":"512Mi"},"requests":{"cpu":"64","memory":"64Mi"}},"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' 2>&1)"
  echo "$out" | grep -qiE 'exceeded quota|maximum cpu usage|forbidden' && pass "TC-BON-10-3-21 $na refuses a pod beyond its quota" || fail "TC-BON-10-3-21 $na accepted an oversized pod: $(echo "$out" | head -1)"
  out="$(kubectl -n "$PLATFORM" get deploy gateway -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['spec']['template']['spec'].get('automountServiceAccountToken'))")"
  [ "$out" = False ] && pass "TC-BON-10-3-22 the gateway still mounts no Kubernetes token" || fail "TC-BON-10-3-22 gateway automount = $out"
}

# SEC-06 (TC-SEC-06-3): rogue pods (no special labels, or a label they should not be able to use for a
# given path) in every namespace try every internal service and port, incl. the gateway pod directly
# (bypassing Traefik) and its metrics port. Together with netpol() this is the full NetworkPolicy matrix.
rogue() {
  local pg="postgres.$PLATFORM.svc.cluster.local" db="mariadb.$STORE.svc.cluster.local" wp="wordpress.$STORE.svc.cluster.local"
  local woo="woo-mcp.$STORE.svc.cluster.local" api; api=$(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}')
  local gw; gw=$(kubectl -n "$PLATFORM" get pod -l app=gateway -o jsonpath='{.items[0].status.podIP}')
  local ns
  for ns in "$STORE" "$PLATFORM" default; do
    expect CLOSED "TC-SEC-06-3 postgres from a random pod in $ns" "$ns" app=intruder "$pg" 5432
    expect CLOSED "TC-SEC-06-3 mariadb from a random pod in $ns" "$ns" app=intruder "$db" 3306
    expect CLOSED "TC-SEC-06-3 woo-mcp from a random pod in $ns" "$ns" app=intruder "$woo" 80
    expect CLOSED "TC-SEC-06-3 gateway pod :8080 directly (no Traefik) from $ns" "$ns" app=intruder "$gw" 8080
    expect CLOSED "TC-SEC-06-3 gateway metrics :9464 from $ns" "$ns" app=intruder "$gw" 9464
    # default is not ours (no workloads, no policies): only our namespaces are held to egress default-deny.
    [ "$ns" != default ] && expect CLOSED "TC-SEC-06-3 Kubernetes API from a random pod in $ns" "$ns" app=intruder "$api" 443
  done
  expect CLOSED "TC-SEC-06-3 wordpress from a random pod in $STORE" "$STORE" app=intruder "$wp" 80
  expect OPEN   "TC-SEC-06-3 wordpress from app=woo-mcp (its REST client)" "$STORE" app=woo-mcp "$wp" 80
  expect CLOSED "TC-SEC-06-3 mariadb from app=woo-mcp" "$STORE" app=woo-mcp "$db" 3306
  expect CLOSED "TC-SEC-06-3 postgres from app=wordpress" "$STORE" app=wordpress "$pg" 5432
  expect CLOSED "TC-SEC-06-3 internet from app=woo-mcp" "$STORE" app=woo-mcp 1.1.1.1 443
  expect CLOSED "TC-SEC-06-3 gateway pod from app=woo-mcp (no calls back)" "$STORE" app=woo-mcp "$gw" 8080
  expect OPEN   "TC-SEC-06-3 gateway metrics from a labelled scraper" "$PLATFORM" "app=intruder,platform.io/metrics-scraper=true" "$gw" 9464
}

ingress() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://store.$DOMAIN/"); [ "$code" = 200 ] && pass "store.$DOMAIN / → 200" || fail "store.$DOMAIN / → $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://store.$DOMAIN/shop/"); [ "$code" = 200 ] && pass "store.$DOMAIN /shop/ → 200" || fail "store.$DOMAIN /shop/ → $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://store.$DOMAIN/wp-json/wc/v3/products"); [ "$code" = 401 ] && pass "unauthenticated WC REST → 401" || fail "unauthenticated WC REST → $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://woo-mcp.$DOMAIN/mcp"); [ "$code" = 404 ] && pass "no public route to woo-mcp → 404" || fail "woo-mcp public route → $code"
  # INF-11 / UI-20: app.<domain> splits between dashboard (/) and gateway (/api, /mcp). The gateway
  # sets x-request-id on every answer; nginx never does, so the header tells who answered.
  local app="http://app.$DOMAIN" got
  route() { # <label> <want: gateway|dashboard> <want code> <curl args…>
    local label="$1" want="$2" wcode="$3"; shift 3
    local h; h=$(curl -s -o /dev/null -D - "$@" | tr -d '\r')
    local c; c=$(echo "$h" | awk 'NR==1{print $2}')
    local who=dashboard; echo "$h" | grep -qi '^x-request-id:' && who=gateway
    [ "$who $c" = "$want $wcode" ] && pass "TC-INF-11-1 $label → $who $c" || fail "TC-INF-11-1 $label → $who $c (want $want $wcode)"
  }
  route "GET  /"            dashboard 200 "$app/"
  route "GET  /servers"     dashboard 200 "$app/servers"
  route "POST /mcp"         gateway 401 -X POST -H 'content-type: application/json' --data '{}' "$app/mcp"
  route "GET  /mcp"         gateway 401 "$app/mcp"          # auth first, then 405 for a key holder
  route "GET  /mcp/x"       gateway 404 "$app/mcp/x"        # Prefix route: still the gateway, not the SPA
  route "GET  /api/me"      gateway 401 "$app/api/me"
  route "GET  /healthz"     dashboard 200 "$app/healthz"   # SPA fallback: the gateway probe is not public
  got=$(curl -s "$app/" | grep -c '<div id="root"'); [ "$got" = 1 ] && pass "TC-K8S-04 dashboard index served" || fail "TC-K8S-04 no <div id=\"root\"> at $app/"
  got=$(curl -sI "$app/" | grep -ci '^content-security-policy:.*frame-ancestors .none.'); [ "$got" = 1 ] && pass "dashboard CSP header present" || fail "dashboard CSP header missing"
}

# --- GW-16: kill the everything-mcp pod; the gateway must keep serving woo + github ---------------
GW_URL="http://app.$DOMAIN/mcp"
# rpc <json-body> → "<seconds> <body>" (stateless /mcp: no initialize needed)
rpc() {
  curl -s -m 20 -w '\n%{time_total}' -X POST "$GW_URL" -H "Authorization: Bearer $MCP_KEY" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$1"
}
# list_check <label> <everything yes|no|any>: list must answer in < 3 s with woo + github.
list_check() {
  local out secs slugs
  out="$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"; secs="$(tail -1 <<<"$out")"
  slugs="$(head -n -1 <<<"$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c={};for(const t of JSON.parse(s).result.tools){const k=t.name.split("__")[0];c[k]=(c[k]||0)+1}console.log(Object.entries(c).map(([k,v])=>k+":"+v).join(" "))}catch{console.log("unparseable")}})')"
  local ok=1
  awk -v t="$secs" 'BEGIN{exit !(t<3)}' || ok=0
  grep -q 'woo:' <<<"$slugs" && grep -q 'github:' <<<"$slugs" || ok=0
  case "$2" in
    yes) grep -q 'everything:' <<<"$slugs" || ok=0 ;;
    no) grep -q 'everything:' <<<"$slugs" && ok=0 ;;
  esac
  [ $ok = 1 ] && pass "$1 → ${secs}s [$slugs]" || fail "$1 → ${secs}s [$slugs] (want < 3 s, woo + github, everything=$2)"
}
call_text() { # call_text <tool> <args-json> → first text content
  rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" | head -n -1 |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(r.result?(r.result.isError?"ERROR ":"")+r.result.content[0].text:"RPCERR "+r.error.message)}catch{console.log("unparseable")}})'
}
# wait_status <from-time> <status> <timeout-s> → seconds until the gateway logs everything → <status>
wait_status() {
  local i
  for ((i = 0; i < $3; i++)); do
    kubectl -n "$PLATFORM" logs -l app=gateway --since-time="$1" --tail=-1 2>/dev/null |
      grep '"upstream status changed"' | grep '"upstream":"everything"' | grep -q "\"to\":\"$2\"" && { echo "$i"; return 0; }
    sleep 1
  done
  return 1
}
killpod() {
  # A temporary admin API key for this run, revoked on exit (AUTH-08: no shared key any more).
  if [ -z "${MCP_KEY:-}" ]; then
    local created; created="$(node "$(dirname "$0")/lib/gateway-key.mjs" create k8s-checks-killpod)" || { fail "could not create a temporary API key"; return; }
    MCP_KEY="${created#* }"; TEMP_KEY_ID="${created%% *}"
    trap 'node "$(dirname "$0")/lib/gateway-key.mjs" revoke "$TEMP_KEY_ID" >/dev/null 2>&1' EXIT
  fi
  local t secs out
  list_check "TC-GW-16-0 baseline list" yes

  # 1. Scale to 0 (the pod is gone, the Service has no endpoints).
  t="$(date -u +%FT%TZ)"
  kubectl -n "$PLATFORM" scale deploy/everything-mcp --replicas=0 >/dev/null
  kubectl -n "$PLATFORM" wait --for=delete pod -l app=everything-mcp --timeout=60s >/dev/null 2>&1
  list_check "TC-GW-16-1a list right after scale 0" no
  secs="$(wait_status "$t" unreachable 30)" && pass "TC-GW-16-1b everything → Unreachable (${secs}s after the pod was gone)" || fail "TC-GW-16-1b no Unreachable status within 30 s"
  list_check "TC-GW-16-1c list while Unreachable" no
  out="$(call_text everything__echo '{"message":"x"}')"
  [[ "$out" == "ERROR upstream_unreachable:"* ]] && pass "TC-GW-16-1d everything__echo → ${out:0:70}" || fail "TC-GW-16-1d everything__echo → ${out:0:120}"
  out="$(call_text woo__list_products '{"per_page":1}')"
  [[ "$out" != ERROR* && "$out" != RPCERR* && "$out" != unparseable ]] && pass "TC-GW-16-1e woo__list_products still works" || fail "TC-GW-16-1e woo__list_products → ${out:0:120}"

  # 2. Scale back to 1 → Connected within 20 s of the pod being Ready.
  t="$(date -u +%FT%TZ)"
  kubectl -n "$PLATFORM" scale deploy/everything-mcp --replicas=1 >/dev/null
  kubectl -n "$PLATFORM" rollout status deploy/everything-mcp --timeout=120s >/dev/null
  secs="$(wait_status "$t" connected 20)" && pass "TC-GW-16-2a everything → Connected ${secs}s after Ready" || fail "TC-GW-16-2a not Connected within 20 s of Ready"
  list_check "TC-GW-16-2b list after recovery" yes
  out="$(call_text everything__echo '{"message":"back"}')"
  [ "$out" = "Echo: back" ] && pass "TC-GW-16-2c everything__echo → $out" || fail "TC-GW-16-2c everything__echo → ${out:0:120}"

  # 3. kubectl delete pod: the Deployment starts a replacement at once, so everything may already be
  # back (or briefly missing) when we look; woo + github must be there either way. The old MCP
  # session dies with the pod, so the gateway must reconnect to the new one.
  kubectl -n "$PLATFORM" delete pod -l app=everything-mcp --wait=true >/dev/null
  list_check "TC-GW-16-3a list right after the pod was deleted" any
  kubectl -n "$PLATFORM" rollout status deploy/everything-mcp --timeout=120s >/dev/null
  kubectl -n "$PLATFORM" wait --for=condition=Ready pod -l app=everything-mcp --timeout=120s >/dev/null
  local i
  for ((i = 0; i < 20; i++)); do
    out="$(call_text everything__echo '{"message":"new pod"}')"; [ "$out" = "Echo: new pod" ] && break; sleep 1
  done
  [ "$out" = "Echo: new pod" ] && pass "TC-GW-16-3b new pod serves everything__echo ${i}s after Ready (new session)" || fail "TC-GW-16-3b everything__echo → ${out:0:120}"
  list_check "TC-GW-16-3c list after the new pod" yes
}

# --- BON-03: gateway /metrics — internal port only, scraper label only, counts follow real calls -----
# scrape <namespace> <labels> <url> → the body (busybox wget, 5 s timeout), or nothing.
scrape() {
  kubectl -n "$1" run "scrape-$RANDOM$RANDOM" --rm -i --restart=Never --quiet --image=busybox:1.36 --labels="$2" \
    --overrides='{"spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"scrape","image":"busybox:1.36","command":["sh","-c","sleep 3; wget -q -T 5 -O- '"$3"' || echo SCRAPE-FAILED"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' \
    2>/dev/null
}
metric() { # metric <body> <series> → value or 0
  awk -v s="$2" '$1 == s { print $2; found=1 } END { if (!found) print 0 }' <<<"$1"
}
metrics() {
  if [ -z "${MCP_KEY:-}" ]; then
    local created; created="$(node "$(dirname "$0")/lib/gateway-key.mjs" create k8s-checks-metrics)" || { fail "could not create a temporary API key"; return; }
    MCP_KEY="${created#* }"; TEMP_KEY_ID="${created%% *}"
    trap 'node "$(dirname "$0")/lib/gateway-key.mjs" revoke "$TEMP_KEY_ID" >/dev/null 2>&1' EXIT
  fi
  local ip ips url before after body series='mcp_tool_calls_total{upstream="woo",outcome="ok",source="mcp"}'
  # Metrics are per replica: scrape every gateway pod and add up.
  read -r -a ips <<<"$(kubectl -n "$PLATFORM" get pods -l app=gateway -o jsonpath='{.items[*].status.podIP}')"
  ip="${ips[0]}"; url="http://$ip:9464/metrics"
  sum_all() { local t=0 i b; for i in "${ips[@]}"; do b="$(scrape "$PLATFORM" platform.io/metrics-scraper=true "http://$i:9464/metrics")"; t=$((t + $(metric "$b" "$series"))); done; echo "$t"; }
  local pub; pub="$(curl -s -m 10 "http://app.$DOMAIN/metrics")"
  grep -q 'mcp_tool_calls_total' <<<"$pub" && fail "TC-BON-03-2a /metrics through the Ingress exposes gateway metrics" \
    || pass "TC-BON-03-2a /metrics through the Ingress → no gateway metrics (dashboard SPA)"
  expect CLOSED "TC-BON-03-2b metrics port from an unlabelled pod in $PLATFORM" "$PLATFORM" app=intruder "$ip" 9464
  expect CLOSED "TC-BON-03-2c metrics port from an unlabelled pod in $STORE" "$STORE" app=intruder "$ip" 9464
  body="$(scrape "$PLATFORM" platform.io/metrics-scraper=true "$url")"
  grep -q '^# TYPE mcp_tool_call_duration_seconds histogram' <<<"$body" && grep -q '^mcp_upstream_up{upstream="woo",status="connected"} 1' <<<"$body" \
    && pass "TC-BON-03-2d labelled scraper gets /metrics (histogram + mcp_upstream_up woo=1)" \
    || fail "TC-BON-03-2d labelled scraper → $(head -c 200 <<<"$body")"
  before="$(sum_all)"
  local out; out="$(call_text woo__list_orders '{"per_page":1}')"; out="$(call_text woo__list_orders '{"per_page":1}')"
  after="$(sum_all)"
  [ "$after" = "$((before + 2))" ] && pass "TC-BON-03-2e two woo__list_orders calls → counter summed over ${#ips[@]} replica(s) $before → $after" \
    || fail "TC-BON-03-2e counter $before → $after over ${#ips[@]} replica(s) (want +2; last call: ${out:0:80})"
  grep -qE 'mgw_|list_orders|@' <<<"$body" && fail "TC-BON-03-2f metrics contain a key, tool name or e-mail" \
    || pass "TC-BON-03-2f no keys, tool names or e-mails in the metrics"
  local stats; stats="$(node --input-type=module -e '
    import { adminSession } from "./scripts/lib/gateway-key.mjs";
    const origin = process.env.APP_ORIGIN ?? "http://app.127.0.0.1.nip.io";
    const r = await fetch(`${origin}/api/upstreams`, { headers: { cookie: await adminSession() } });
    const woo = (await r.json()).find((u) => u.slug === "woo");
    console.log(JSON.stringify(woo.stats));' stats)"   # an argv[1], so gateway-key.mjs does not run as a CLI
  node -e 'const s=JSON.parse(process.argv[1]); process.exit(s && s.calls >= 2 && s.p95Ms !== null ? 0 : 1)' "$stats" \
    && pass "TC-BON-03-3b dashboard API woo stats (last hour, all replicas): $stats" || fail "TC-BON-03-3b dashboard stats: $stats"
}

# --- BON-04: two gateway replicas — spread, sessions anywhere, a pod kill under load, shared per-key limit ---
replicas() {
  if [ -z "${MCP_KEY:-}" ]; then
    local created; created="$(node "$(dirname "$0")/lib/gateway-key.mjs" create k8s-checks-replicas)" || { fail "could not create a temporary API key"; return; }
    MCP_KEY="${created#* }"; TEMP_KEY_ID="${created%% *}"
    trap 'node "$(dirname "$0")/lib/gateway-key.mjs" revoke "$TEMP_KEY_ID" >/dev/null 2>&1' EXIT
  fi
  local ready pods since i n0 n1
  ready="$(kubectl -n "$PLATFORM" get deploy gateway -o jsonpath='{.status.readyReplicas}')"
  [ "${ready:-0}" -ge 2 ] && pass "TC-BON-04-2a gateway has $ready ready replicas" || fail "TC-BON-04-2a gateway ready replicas: ${ready:-0} (want ≥ 2)"
  [ "$(kubectl -n "$PLATFORM" get pdb gateway -o jsonpath='{.spec.minAvailable}' 2>/dev/null)" = 1 ] \
    && pass "TC-BON-04-2b PodDisruptionBudget gateway minAvailable=1" || fail "TC-BON-04-2b no PodDisruptionBudget"

  # Spread: Traefik balances over both pods; each pod logs the tools/list it served.
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; sleep 1
  for i in $(seq 20); do rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' >/dev/null; done
  read -r -a pods <<<"$(kubectl -n "$PLATFORM" get pods -l app=gateway -o jsonpath='{.items[*].metadata.name}')"
  n0="$(kubectl -n "$PLATFORM" logs "${pods[0]}" --since-time="$since" | grep -c '"msg":"tools/list"')"
  n1="$(kubectl -n "$PLATFORM" logs "${pods[1]}" --since-time="$since" | grep -c '"msg":"tools/list"')"
  [ "$n0" -gt 0 ] && [ "$n1" -gt 0 ] && [ $((n0 + n1)) -eq 20 ] && pass "TC-BON-04-2c 20 tools/list spread over both pods ($n0 + $n1)" \
    || fail "TC-BON-04-2c tools/list per pod: $n0 + $n1 (want both > 0, total 20)"

  # Dashboard session created on one replica works on the other (sessions in Postgres).
  local ok; ok="$(node --input-type=module -e '
    import { adminSession } from "./scripts/lib/gateway-key.mjs";
    const origin = process.env.APP_ORIGIN ?? "http://app.127.0.0.1.nip.io";
    const cookie = await adminSession(); let ok = 0;
    for (let i = 0; i < 10; i++) if ((await fetch(`${origin}/api/me`, { headers: { cookie } })).status === 200) ok++;
    console.log(ok);' session)"
  [ "$ok" = 10 ] && pass "TC-BON-04-2d one dashboard session, 10 × /api/me over both replicas → 10 × 200" || fail "TC-BON-04-2d /api/me ok $ok/10"

  # Kill one pod while a client keeps calling: no failed request (graceful shutdown + endpoint removal).
  local results="$(mktemp)" bad total
  ( for i in $(seq 40); do
      out="$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"woo__list_orders","arguments":{"per_page":1}}}' | head -n -1)"
      grep -q '"result"' <<<"$out" && grep -qv '"isError":true' <<<"$out" && echo ok >>"$results" || echo "bad ${out:0:100}" >>"$results"
      sleep 0.25
    done ) &
  local loop=$!
  sleep 2; kubectl -n "$PLATFORM" delete pod "${pods[0]}" --wait=false >/dev/null
  wait $loop
  total="$(wc -l <"$results")"; bad="$(grep -c '^bad' "$results")"
  [ "$total" = 40 ] && [ "$bad" = 0 ] && pass "TC-BON-04-2e pod ${pods[0]} deleted during 40 woo__list_orders calls → 0 failed" \
    || fail "TC-BON-04-2e $bad of $total calls failed while a pod was deleted: $(grep -m1 '^bad' "$results")"
  rm -f "$results"
  kubectl -n "$PLATFORM" rollout status deploy/gateway --timeout=120s >/dev/null && pass "TC-BON-04-2f replacement pod Ready" || fail "TC-BON-04-2f rollout"

  # Shared per-key limit through the Ingress (both replicas): limit + 20 requests, 20 at a time, so they all
  # land in one window (sequential calls can take longer than the window). At most `limit` may succeed.
  local limit codes ok429 ok200 retry
  limit="$(kubectl -n "$PLATFORM" get deploy gateway -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MCP_RATE_LIMIT_PER_APIKEY")].value}')"
  codes="$(seq $((limit + 20)) | xargs -P 20 -I{} curl -s -o /dev/null -w '%{http_code}\n' -m 20 -X POST "$GW_URL" -H "Authorization: Bearer $MCP_KEY" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
  ok200="$(grep -c '^200$' <<<"$codes")"; ok429="$(grep -c '^429$' <<<"$codes")"
  retry="$(curl -s -D - -o /dev/null -m 10 -X POST "$GW_URL" -H "Authorization: Bearer $MCP_KEY" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | tr -d '\r' | awk -F': ' 'tolower($1)=="retry-after"{print $2}')"
  [ "$ok200" -le "$limit" ] && [ "$ok429" -ge 20 ] && [ $((ok200 + ok429)) -eq $((limit + 20)) ] && [ "${retry:-0}" -gt 0 ] \
    && pass "TC-BON-04-2g per-key limit $limit/min across both replicas: $((limit + 20)) parallel requests → $ok200 × 200, $ok429 × 429, Retry-After ${retry} s" \
    || fail "TC-BON-04-2g $((limit + 20)) requests → $ok200 × 200, $ok429 × 429 (want ≤ $limit and ≥ 20), Retry-After '${retry}'"
}

case "${1:-all}" in
  netpol) netpol ;;
  rbac) rbac ;;
  stores) stores ;;
  hosted) hosted ;;
  rogue) rogue ;;
  ingress) ingress ;;
  killpod) killpod ;;
  metrics) metrics ;;
  replicas) replicas ;;
  all) ingress; netpol ;;
  *) echo "usage: $0 netpol|ingress|killpod|metrics|replicas|all" >&2; exit 2 ;;
esac
echo "failures: $fails"
exit $((fails > 0))
