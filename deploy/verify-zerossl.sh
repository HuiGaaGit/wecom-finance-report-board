#!/usr/bin/env bash
set -euo pipefail

cert_dir="/etc/acme-sh/certs/qiandianxiaoq.com"
cert_file="${cert_dir}/qiandianxiaoq.com.cer"
key_file="${cert_dir}/qiandianxiaoq.com.key"

printf 'CERT_FILES\n'
find "${cert_dir}" -maxdepth 2 -type f -printf '%f %m\n' | sort

cert_pub="$(openssl x509 -in "${cert_file}" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)"
key_pub="$(openssl pkey -in "${key_file}" -pubout -outform DER | sha256sum | cut -d' ' -f1)"
if [[ "${cert_pub}" != "${key_pub}" ]]; then
  printf 'KEY_MATCH=no\n'
  exit 1
fi
printf 'KEY_MATCH=yes\n'
ca_bundle="/etc/ssl/certs/ca-certificates.crt"
if [[ ! -f "${ca_bundle}" ]]; then
  ca_bundle="/etc/pki/tls/certs/ca-bundle.crt"
fi
openssl verify \
  -CAfile "${ca_bundle}" \
  -untrusted "${cert_dir}/ca.cer" \
  "${cert_file}"

printf 'CERTIFICATE\n'
openssl x509 -in "${cert_file}" -noout -subject -issuer -dates -ext subjectAltName

printf 'NGINX_CERT_REFERENCES\n'
nginx -T 2>/dev/null \
  | grep -E 'ssl_certificate(_key)?|listen .*443|server_name' \
  | grep -E 'qiandianxiaoq|wecom|172\.23\.117\.56|100\.100\.69\.78|ssl_certificate' \
  | sed -E 's#(ssl_certificate_key[[:space:]]+).*#\1[redacted-path];#' || true

printf 'UNIT_STATE\n'
printf 'project17=%s\n' "$(systemctl is-active wecom-finance-report-board.service)"
printf 'project14=%s\n' "$(systemctl is-active hermes-ledger.service || true)"
printf 'certbot_timer=%s\n' "$(systemctl is-active certbot-renew.timer || true)"
