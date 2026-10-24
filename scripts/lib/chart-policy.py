#!/usr/bin/env python3
"""Policy checks on rendered manifests (stdin): every container has requests+limits; long-running
containers have readiness+liveness probes; no Secret objects carry literal data; Services are ClusterIP;
pods do not mount service-account tokens; every container runs as non-root with seccomp RuntimeDefault,
no privilege escalation, no added capabilities and a read-only root filesystem (REL-09, no exceptions).
Exit 1 on any violation."""
import sys, yaml

docs = [d for d in yaml.safe_load_all(sys.stdin) if d]
errors = []
for d in docs:
    kind, name = d.get("kind"), d.get("metadata", {}).get("name")
    ref = f"{kind}/{name}"
    if kind == "Secret":
        errors.append(f"{ref}: chart must not render Secrets (use existingSecret / scripts/make-secrets.sh)")
    if kind == "Service" and d["spec"].get("type", "ClusterIP") != "ClusterIP":
        errors.append(f"{ref}: type {d['spec']['type']} (only ClusterIP; Traefik is the only public entry)")
    if kind == "ServiceAccount" and d.get("automountServiceAccountToken") is not False:
        errors.append(f"{ref}: ServiceAccount must set automountServiceAccountToken: false")
    if kind not in ("Deployment", "StatefulSet", "Job"):
        continue
    pod = d["spec"]["template"]["spec"]
    psc = pod.get("securityContext") or {}
    if pod.get("automountServiceAccountToken") is not False:
        errors.append(f"{ref}: automountServiceAccountToken must be false")
    if pod.get("serviceAccountName") != "workload":
        errors.append(f"{ref}: serviceAccountName must be 'workload' (no token, F-INF-4), not the namespace default")
    for c in pod.get("containers", []) + pod.get("initContainers", []):
        cref = f"{ref}[{c['name']}]"
        r = c.get("resources") or {}
        if not r.get("requests") or not r.get("limits"):
            errors.append(f"{cref}: missing resources.requests/limits")
        elif not {"cpu", "memory"} <= set(r["limits"]):
            errors.append(f"{cref}: limits need both cpu and memory (F-INF-3)")
        if kind != "Job":
            for p in ("readinessProbe", "livenessProbe"):
                if p not in c:
                    errors.append(f"{cref}: missing {p}")
        sc = c.get("securityContext") or {}
        if sc.get("allowPrivilegeEscalation") is not False:
            errors.append(f"{cref}: allowPrivilegeEscalation must be false")
        if "ALL" not in (sc.get("capabilities") or {}).get("drop", []):
            errors.append(f"{cref}: capabilities.drop must include ALL")
        if (sc.get("capabilities") or {}).get("add"):
            errors.append(f"{cref}: capabilities.add {sc['capabilities']['add']} (none allowed)")
        if sc.get("runAsNonRoot", psc.get("runAsNonRoot")) is not True or sc.get("runAsUser", psc.get("runAsUser")) in (None, 0):
            errors.append(f"{cref}: must run as a non-root numeric user (runAsNonRoot + runAsUser)")
        if (sc.get("seccompProfile") or psc.get("seccompProfile") or {}).get("type") != "RuntimeDefault":
            errors.append(f"{cref}: seccompProfile must be RuntimeDefault")
        if sc.get("readOnlyRootFilesystem") is not True:
            errors.append(f"{cref}: readOnlyRootFilesystem must be true (mount emptyDirs for writable paths)")
        for e in c.get("env", []):
            if any(w in e["name"].upper() for w in ("PASSWORD", "SECRET", "TOKEN", "_KEY")) and "value" in e:
                errors.append(f"{cref}: env {e['name']} has a literal value (use secretKeyRef)")

for e in errors:
    print(f"FAIL  {e}")
print(f"policy: {len(docs)} objects, {len(errors)} violations")
sys.exit(1 if errors else 0)
