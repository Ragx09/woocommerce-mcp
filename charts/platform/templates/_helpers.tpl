{{/* Common labels. "app" is the stable selector used by Services and NetworkPolicies. */}}
{{- define "platform.labels" -}}
app: {{ .app }}
app.kubernetes.io/name: {{ .app }}
app.kubernetes.io/part-of: platform
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end }}

{{- define "platform.selector" -}}
app: {{ .app }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{/* Fails the render when a container has no requests/limits (INF-08). */}}
{{- define "platform.resources" -}}
{{- $r := required (printf "resources are required for %s" .name) .resources -}}
{{- if not (and $r.requests $r.limits) -}}{{- fail (printf "%s needs both resources.requests and resources.limits" .name) -}}{{- end -}}
{{- toYaml $r -}}
{{- end }}

{{/* Host and public URL for a component, e.g. store.127.0.0.1.nip.io */}}
{{- define "platform.host" -}}{{ printf "%s.%s" .host .root.Values.global.domain }}{{- end }}
{{- define "platform.url" -}}{{ printf "%s://%s.%s" .root.Values.global.scheme .host .root.Values.global.domain }}{{- end }}

{{/* Our own images get the registry prefix; third-party images are used as written. */}}
{{- define "platform.image" -}}{{ printf "%s%s:%s" .root.Values.global.imageRegistry .image.repository (toString .image.tag) }}{{- end }}

{{/* Pull secrets for our own images from a private registry (prod: GHCR packages that are not public). */}}
{{- define "platform.pullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end }}

{{/* Hardened container defaults for images that run as non-root. */}}
{{- define "platform.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities:
  drop: [ALL]
seccompProfile:
  type: RuntimeDefault
{{- end }}
