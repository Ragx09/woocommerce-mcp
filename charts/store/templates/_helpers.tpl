{{/* Target namespace: `namespace` (the platform chart sets "store") or the release namespace (provisioned stores). */}}
{{- define "store.namespace" -}}{{ .Values.namespace | default .Release.Namespace }}{{- end }}

{{/* Common labels. "app" is the stable selector used by Services and NetworkPolicies. part-of and chart can be
pinned by the parent (the default store keeps the labels it had in the platform chart: StatefulSet
volumeClaimTemplates are immutable). */}}
{{- define "store.labels" -}}
app: {{ .app }}
app.kubernetes.io/name: {{ .app }}
app.kubernetes.io/part-of: {{ .root.Values.labels.partOf }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ .root.Values.labels.chart | default (printf "%s-%s" .root.Chart.Name .root.Chart.Version) }}
{{- with .root.Values.labels.store }}
platform.io/store: {{ . }}
{{- end }}
{{- end }}

{{- define "store.selector" -}}
app: {{ .app }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{/* Fails the render when a container has no requests/limits (INF-08). */}}
{{- define "store.resources" -}}
{{- $r := required (printf "resources are required for %s" .name) .resources -}}
{{- if not (and $r.requests $r.limits) -}}{{- fail (printf "%s needs both resources.requests and resources.limits" .name) -}}{{- end -}}
{{- toYaml $r -}}
{{- end }}

{{/* Host and public URL, e.g. store.127.0.0.1.nip.io or tea.store.127.0.0.1.nip.io */}}
{{- define "store.host" -}}{{ printf "%s.%s" .host .root.Values.global.domain }}{{- end }}
{{- define "store.url" -}}{{ printf "%s://%s.%s" .root.Values.global.scheme .host .root.Values.global.domain }}{{- end }}

{{/* Our own images get the registry prefix; third-party images are used as written. */}}
{{- define "store.image" -}}{{ printf "%s%s:%s" .root.Values.global.imageRegistry .image.repository (toString .image.tag) }}{{- end }}

{{- define "store.pullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end }}

{{/* Hardened container defaults for images that run as non-root. */}}
{{- define "store.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities:
  drop: [ALL]
seccompProfile:
  type: RuntimeDefault
{{- end }}
