{{- define "hosted.namespace" -}}{{ .Release.Namespace }}{{- end }}

{{/* "app: hosted-server" is the stable label the NetworkPolicies and the gateway's egress rule select on. */}}
{{- define "hosted.labels" -}}
app: hosted-server
app.kubernetes.io/name: hosted-server
app.kubernetes.io/part-of: hosted
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
platform.io/hosted: {{ required "slug is required" .Values.slug }}
{{- end }}

{{- define "hosted.selector" -}}
app: hosted-server
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
