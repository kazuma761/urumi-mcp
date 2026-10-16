{{- define "store.host" -}}{{ .Values.store.host }}.{{ .Values.global.domain }}{{- end }}

{{- define "store.url" -}}
{{ ternary "https" "http" .Values.global.tls.enabled }}://{{ include "store.host" . }}
{{- end }}

{{/* What a component's pods are selected by. Argument: (list $ "<component>"). */}}
{{- define "store.match" -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/instance: {{ (index . 0).Release.Name }}
{{- end }}

{{- define "store.labels" -}}
{{ include "store.match" . }}
app.kubernetes.io/part-of: urumi
{{- end }}

{{/*
A generated credential, base64. The value already in the cluster wins, because
it is baked into the database and into WooCommerce's key table; only a first
install generates one. Argument: (list $ "<secret>" "<key>" "<prefix>" <length>).
*/}}
{{- define "store.secretValue" -}}
{{- $ctx := index . 0 -}}{{- $key := index . 2 -}}
{{- $current := (lookup "v1" "Secret" $ctx.Release.Namespace (index . 1)).data | default dict -}}
{{- get $current $key | default (printf "%s%s" (index . 3) (randAlphaNum (index . 4)) | b64enc) -}}
{{- end }}

{{/* What wp-config.php reads at runtime, for WordPress and for the WP-CLI Job. */}}
{{- define "store.wordpressEnv" -}}
- { name: WORDPRESS_DB_HOST, value: "mariadb:3306" }
- { name: WORDPRESS_DB_NAME, value: {{ .Values.mariadb.database | quote }} }
- { name: WORDPRESS_DB_USER, value: {{ .Values.mariadb.user | quote }} }
- name: WORDPRESS_DB_PASSWORD
  valueFrom: { secretKeyRef: { name: mariadb, key: password } }
# The public address is fixed here, so links never use the in-cluster host name.
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "store.url" . }}');
    define('WP_SITEURL', '{{ include "store.url" . }}');
{{- end }}
