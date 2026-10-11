# Kubernetes & Helm — learning notes

## Core objects
1. **What:** A *Pod* runs containers. A *Deployment* keeps N identical, replaceable pods (stateless apps). A *StatefulSet* gives pods stable identity and their own volumes (databases). A *Service* is a stable virtual IP and DNS name (`svc.ns.svc.cluster.local`) in front of pods selected by labels. A *Job* runs to completion.
2. **Why:** Declarative desired state, with controllers reconciling reality towards it.
3. **Why we need it:** The brief requires everything to run on Kubernetes.
4. **How:** You `kubectl apply` YAML; controllers create and replace pods; the Service routes by label selector.
5. **Where:** `charts/platform/templates/*` (planned): gateway, dashboard, woo-mcp and wordpress are Deployments; mariadb and postgres are StatefulSets; wp-init is a Job.
6. **Alternatives:** docker-compose (no self-healing or scheduling), raw VMs.
7. **Debugging:** `kubectl get pods -A`, `kubectl describe pod` (events!), `kubectl logs [-p]`, `kubectl get endpoints <svc>` (empty means the selector or readiness is wrong).
8. **Self-test:** Why is MariaDB a StatefulSet and the gateway a Deployment?

## k3s and k3d
1. **What:** k3s is a lightweight, certified Kubernetes distribution in a single binary, with Traefik ingress, the local-path storage provisioner and a network-policy controller built in. k3d runs k3s nodes as Docker containers.
2. **Why:** Full Kubernetes with little RAM, which suits small VPSes.
3. **Why we need it:** The brief suggests k3s for the VPS. Using k3d locally means **the same distribution** everywhere, so only values differ (D-010).
4. **How:** `k3d cluster create mcp -p "80:80@loadbalancer"` maps host port 80 to Traefik.
5. **Where:** `k3d/cluster.yaml`, `scripts/cluster-up.sh` (planned).
6. **Alternatives:** kind (needs a separately installed ingress controller and storage), minikube (heavier).
7. **Debugging:** `k3d cluster list`, `docker ps` (one server container plus a loadbalancer container), `kubectl -n kube-system get pods`.
8. **Self-test:** Which three components does k3s bundle that we would otherwise install ourselves?

## Helm
1. **What:** A package manager for Kubernetes. A *chart* is a set of templated manifests, *values* are its inputs, and a *release* is an installed instance with revision history.
2. **Why:** It avoids copy-pasting YAML per environment and gives upgrade and rollback.
3. **Why we need it:** It is mandatory, and local vs VPS must differ only by values files.
4. **How:** `helm upgrade --install platform charts/platform -f values-local.yaml` renders the templates with the values and applies them. `helm rollback platform 3` re-applies revision 3.
5. **Where:** `charts/platform` (planned).
6. **Alternatives:** Kustomize (forbidden by the brief), raw manifests.
7. **Debugging:** `helm template … | less` to see the rendered YAML; `helm lint`; `helm get values platform`; `helm history platform`.
8. **Self-test:** What does `helm rollback` *not* undo? (Hint: data in PVCs and database migrations.)
