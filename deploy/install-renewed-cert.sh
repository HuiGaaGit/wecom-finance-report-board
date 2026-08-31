#!/usr/bin/env bash
set -euo pipefail

domain="qiandianxiaoq.com"
cert_dir="/etc/nginx/ssl/${domain}"
next_chain="${cert_dir}/fullchain.next.pem"
next_key="${cert_dir}/privkey.next.pem"
live_chain="${cert_dir}/fullchain.pem"
live_key="${cert_dir}/privkey.pem"

openssl x509 -in "${next_chain}" -noout -checkhost "${domain}" >/dev/null
openssl x509 -in "${next_chain}" -noout -checkend 604800 >/dev/null
cert_pub="$(openssl x509 -in "${next_chain}" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)"
key_pub="$(openssl pkey -in "${next_key}" -pubout -outform DER | sha256sum | cut -d' ' -f1)"
[[ "${cert_pub}" == "${key_pub}" ]]

had_live=0
if [[ -f "${live_chain}" && -f "${live_key}" ]]; then
  had_live=1
  install -o root -g root -m 0644 "${live_chain}" "${live_chain}.previous"
  install -o root -g root -m 0600 "${live_key}" "${live_key}.previous"
fi

install -o root -g root -m 0644 "${next_chain}" "${live_chain}.new"
install -o root -g root -m 0600 "${next_key}" "${live_key}.new"
mv -f "${live_chain}.new" "${live_chain}"
mv -f "${live_key}.new" "${live_key}"

if ! nginx -t; then
  if [[ "${had_live}" -eq 1 ]]; then
    mv -f "${live_chain}.previous" "${live_chain}"
    mv -f "${live_key}.previous" "${live_key}"
  fi
  exit 1
fi

if ! systemctl reload nginx.service; then
  if [[ "${had_live}" -eq 1 ]]; then
    mv -f "${live_chain}.previous" "${live_chain}"
    mv -f "${live_key}.previous" "${live_key}"
    nginx -t
    systemctl reload nginx.service
  fi
  exit 1
fi

printf 'certificate_install=ok\n'
