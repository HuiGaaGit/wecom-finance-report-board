#!/usr/bin/env bash
set -euo pipefail

domain="qiandianxiaoq.com"
acme_home="/opt/acme.sh"
config_home="/etc/acme-sh"
cert_home="/etc/acme-sh/certs"
ssl_dir="/etc/nginx/ssl/${domain}"
active_nginx="/etc/nginx/conf.d/wecom-finance.conf"
staged_nginx="/etc/wecom-finance/wecom-finance.nginx.conf"
timestamp="$(date -u +%Y%m%d%H%M%S)"

for required in \
  "${acme_home}/acme.sh" \
  "${cert_home}/${domain}/${domain}.cer" \
  "${cert_home}/${domain}/${domain}.key" \
  "${active_nginx}" \
  "${staged_nginx}" \
  /tmp/wecom-finance-install-renewed-cert \
  /tmp/acme-sh-renew.service \
  /tmp/acme-sh-renew.timer; do
  [[ -f "${required}" ]]
done

install -d -o root -g root -m 0700 "${ssl_dir}"
install -o root -g root -m 0750 \
  /tmp/wecom-finance-install-renewed-cert \
  /usr/local/sbin/wecom-finance-install-renewed-cert

"${acme_home}/acme.sh" --install-cert \
  --domain "${domain}" \
  --key-file "${ssl_dir}/privkey.next.pem" \
  --fullchain-file "${ssl_dir}/fullchain.next.pem" \
  --reloadcmd /usr/local/sbin/wecom-finance-install-renewed-cert \
  --home "${acme_home}" \
  --config-home "${config_home}" \
  --cert-home "${cert_home}"

openssl x509 -in "${ssl_dir}/fullchain.pem" -noout -checkhost "${domain}" >/dev/null
openssl x509 -in "${ssl_dir}/fullchain.pem" -noout -checkend 604800 >/dev/null

cp -a "${active_nginx}" "${active_nginx}.pre-zerossl-${timestamp}"
cp -a "${staged_nginx}" "${staged_nginx}.pre-zerossl-${timestamp}"

rollback_nginx() {
  cp -a "${active_nginx}.pre-zerossl-${timestamp}" "${active_nginx}"
  cp -a "${staged_nginx}.pre-zerossl-${timestamp}" "${staged_nginx}"
  nginx -t
  systemctl reload nginx.service
}
trap rollback_nginx ERR

sed -i \
  -e "s#/etc/letsencrypt/live/${domain}/fullchain.pem#${ssl_dir}/fullchain.pem#g" \
  -e "s#/etc/letsencrypt/live/${domain}/privkey.pem#${ssl_dir}/privkey.pem#g" \
  "${active_nginx}" "${staged_nginx}"

grep -Fq "ssl_certificate ${ssl_dir}/fullchain.pem;" "${active_nginx}"
grep -Fq "ssl_certificate_key ${ssl_dir}/privkey.pem;" "${active_nginx}"
nginx -t
systemctl reload nginx.service
trap - ERR

install -o root -g root -m 0644 /tmp/acme-sh-renew.service /etc/systemd/system/acme-sh-renew.service
install -o root -g root -m 0644 /tmp/acme-sh-renew.timer /etc/systemd/system/acme-sh-renew.timer
systemctl daemon-reload
systemctl enable --now acme-sh-renew.timer
systemctl start acme-sh-renew.service
systemctl disable --now certbot-renew.timer

printf 'acme_timer=%s\n' "$(systemctl is-active acme-sh-renew.timer)"
printf 'certbot_timer=%s\n' "$(systemctl is-active certbot-renew.timer || true)"
printf 'certificate_renewal_install=ok\n'
