#!/bin/sh
# Idempotent store bootstrap (prototype of the WC-03 Job). Every step checks before it changes.
# Env: SITE_URL, ADMIN_USER, ADMIN_PASSWORD, ADMIN_EMAIL, WC_VERSION. Prints the REST key ONLY when newly created.
set -eu
wp() { command wp --path=/var/www/html --quiet "$@"; }

# The wordpress container copies core files into the volume on first start; wait for it.
i=0; until [ -f /var/www/html/wp-config.php ]; do i=$((i+1)); [ $i -gt 60 ] && { echo "wp-config.php missing" >&2; exit 1; }; sleep 2; done

if ! wp core is-installed 2>/dev/null; then
  wp core install --url="$SITE_URL" --title="Urumi Demo Store" --admin_user="$ADMIN_USER" \
    --admin_password="$ADMIN_PASSWORD" --admin_email="$ADMIN_EMAIL" --skip-email
  echo "core installed"
fi
wp option update home "$SITE_URL"; wp option update siteurl "$SITE_URL"
wp rewrite structure '/%postname%/' --hard

wp plugin is-installed woocommerce || wp plugin install woocommerce --version="$WC_VERSION"
wp plugin is-active woocommerce || wp plugin activate woocommerce
echo "woocommerce $(command wp --path=/var/www/html plugin get woocommerce --field=version)"

wp option update timezone_string "${STORE_TIMEZONE:-UTC}"
wp option update woocommerce_currency "${STORE_CURRENCY:-USD}"
wp option update woocommerce_default_country "${STORE_COUNTRY:-US:CA}"
wp option update woocommerce_coming_soon no
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp option update woocommerce_cod_settings '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' --format=json

# Sample products only on an empty catalogue (re-runs must not duplicate).
if [ "$(command wp --path=/var/www/html post list --post_type=product --format=count)" = "0" ]; then
  for p in "Urumi Mug|12.00" "Urumi T-Shirt|25.00" "Urumi Sticker Pack|5.00"; do
    wp wc product create --user="$ADMIN_USER" --name="${p%|*}" --regular_price="${p#*|}" --status=publish
  done
  echo "sample products created"
fi

# Service user + REST key (read_write) for woo-mcp. Created once; secret is printed once.
command wp --path=/var/www/html user get mcp-service >/dev/null 2>&1 || \
  wp user create mcp-service mcp-service@example.invalid --role=shop_manager --user_pass="$(head -c 24 /dev/urandom | base64)"
command wp --path=/var/www/html eval '
global $wpdb;
$uid = get_user_by("login", "mcp-service")->ID;
$t = $wpdb->prefix . "woocommerce_api_keys";
if ($wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $t WHERE user_id=%d AND description=%s", $uid, "woo-mcp"))) { echo "rest key exists\n"; return; }
$ck = "ck_" . wc_rand_hash(); $cs = "cs_" . wc_rand_hash();
$wpdb->insert($t, ["user_id"=>$uid, "description"=>"woo-mcp", "permissions"=>"read_write",
  "consumer_key"=>wc_api_hash($ck), "consumer_secret"=>$cs, "truncated_key"=>substr($ck, -7)]);
echo "WOO_CONSUMER_KEY=$ck\nWOO_CONSUMER_SECRET=$cs\n";'
