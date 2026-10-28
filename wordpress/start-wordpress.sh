#!/bin/sh
set -eu

/usr/local/bin/docker-entrypoint.sh apache2-foreground &
apache_pid=$!

attempt=0
until wp --allow-root --path=/var/www/html db check >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo "WordPress database did not become ready within 4 minutes" >&2
    exit 1
  fi
  sleep 2
done

# The volume keeps the files from the first boot, so refresh core and WooCommerce from the image.
cp -a /usr/src/wordpress/. /var/www/html/
rm -rf /var/www/html/wp-content/plugins/woocommerce
cp -a /usr/src/wordpress/wp-content/plugins/woocommerce /var/www/html/wp-content/plugins/

if ! wp --allow-root --path=/var/www/html core is-installed >/dev/null 2>&1; then
  : "${WORDPRESS_ADMIN_PASSWORD:?WORDPRESS_ADMIN_PASSWORD must be set}"
  wp --allow-root --path=/var/www/html core install \
    --url="${WORDPRESS_SITE_URL:-http://store.local}" \
    --title="${WORDPRESS_SITE_TITLE:-Urumi Demo Store}" \
    --admin_user="${WORDPRESS_ADMIN_USER:-store-admin}" \
    --admin_password="$WORDPRESS_ADMIN_PASSWORD" \
    --admin_email="${WORDPRESS_ADMIN_EMAIL:-admin@example.invalid}" \
    --skip-email
fi

wp --allow-root --path=/var/www/html core update-db

wp --allow-root --path=/var/www/html plugin activate woocommerce
touch /tmp/wordpress-ready
wait "$apache_pid"
