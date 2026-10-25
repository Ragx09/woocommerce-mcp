#!/bin/sh
# Idempotent store bootstrap (WC-03). Every step checks state before changing it, so the Job
# can run on every helm install/upgrade. No secret value is ever printed.
# Env: SITE_URL TITLE ADMIN_USER ADMIN_PASSWORD ADMIN_EMAIL WC_VERSION STORE_* WOO_CONSUMER_KEY WOO_CONSUMER_SECRET
set -eu
WP="wp --path=/var/www/html"
q() { $WP --quiet "$@"; }

echo "waiting for WordPress files and database"
i=0; until [ -f /var/www/html/wp-config.php ] && $WP db check --quiet >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 150 ] && { echo "timed out waiting for wp-config.php / database" >&2; exit 1; }; sleep 2
done

if ! $WP core is-installed 2>/dev/null; then
  q core install --url="$SITE_URL" --title="$TITLE" --admin_user="$ADMIN_USER" \
    --admin_password="$ADMIN_PASSWORD" --admin_email="$ADMIN_EMAIL" --skip-email
  echo "core installed"
fi
q rewrite structure '/%postname%/' --hard

$WP plugin is-installed woocommerce || q plugin install woocommerce --version="$WC_VERSION"
$WP plugin is-active woocommerce || q plugin activate woocommerce
echo "woocommerce $($WP plugin get woocommerce --field=version)"

q option update timezone_string "$STORE_TIMEZONE"
q option update woocommerce_currency "$STORE_CURRENCY"
q option update woocommerce_default_country "$STORE_COUNTRY"
q option update woocommerce_coming_soon no
q option update woocommerce_store_pages_only no
q option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
q option update woocommerce_cod_settings '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' --format=json
# Guest checkout keeps the demo order flow short.
q option update woocommerce_enable_guest_checkout yes
echo "store settings applied (COD enabled)"

if [ "${BRAND_ENABLED:-false}" = "true" ]; then
  # BRD-06: TATVA theme (replaced on every run so updates apply) + idempotent catalogue import.
  T=/var/www/html/wp-content/themes
  rm -rf "$T/.tatva-new" "$T/.tatva-old" && cp -r /assets/theme/tatva "$T/.tatva-new"
  [ -d "$T/tatva" ] && mv "$T/tatva" "$T/.tatva-old"; mv "$T/.tatva-new" "$T/tatva"; rm -rf "$T/.tatva-old"
  [ "$($WP option get stylesheet)" = "tatva" ] || q theme activate tatva
  q option update blogname "$TITLE"
  # BRD-08: TATVA admin colour scheme for the admin user, only while it is still the default
  # (a scheme the user picked under Users → Profile is kept). WordPress 7 creates users with "modern",
  # older versions with "fresh" (found by the 2026-10-24 clean install).
  # BON-11: the bike niche (Ridgeline) has its own scheme; a scheme the user picked is still kept.
  SCHEME=tatva; [ "${STORE_NICHE:-}" = bike ] && SCHEME=ridgeline
  case "$($WP user meta get "$ADMIN_USER" admin_color 2>/dev/null || true)" in
    ''|fresh|modern|tatva) [ "$($WP user meta get "$ADMIN_USER" admin_color 2>/dev/null || true)" = "$SCHEME" ] || { q user meta update "$ADMIN_USER" admin_color "$SCHEME" && echo "admin colour scheme: $SCHEME"; } ;;
  esac
  ASSETS_DIR=/assets $WP eval-file /assets/import/import-catalogue.php
elif [ "$($WP post list --post_type=product --post_status=any --format=count)" = "0" ]; then
  for p in "Urumi Mug|12.00" "Urumi T-Shirt|25.00" "Urumi Sticker Pack|5.00"; do
    q wc product create --user="$ADMIN_USER" --name="${p%|*}" --regular_price="${p#*|}" --status=publish
  done
  echo "sample products created"
fi

# Service user + REST key for woo-mcp. The key comes from a Kubernetes Secret; we store its hash
# (as WooCommerce does) and update it when the Secret was rotated.
$WP user get mcp-service >/dev/null 2>&1 || \
  q user create mcp-service mcp-service@example.invalid --role=shop_manager --user_pass="$(head -c 32 /dev/urandom | base64)"
$WP eval '
global $wpdb;
$ck = getenv("WOO_CONSUMER_KEY"); $cs = getenv("WOO_CONSUMER_SECRET");
if (!$ck || !$cs) { fwrite(STDERR, "WOO_CONSUMER_KEY/SECRET missing\n"); exit(1); }
$uid = get_user_by("login", "mcp-service")->ID;
$t = $wpdb->prefix . "woocommerce_api_keys";
$row = ["user_id"=>$uid, "description"=>"woo-mcp", "permissions"=>"read_write",
        "consumer_key"=>wc_api_hash($ck), "consumer_secret"=>$cs, "truncated_key"=>substr($ck, -7)];
$id = $wpdb->get_var($wpdb->prepare("SELECT key_id FROM $t WHERE description=%s", "woo-mcp"));
if (!$id) { $wpdb->insert($t, $row); echo "rest key created\n"; }
elseif ($wpdb->get_var($wpdb->prepare("SELECT consumer_key FROM $t WHERE key_id=%d", $id)) !== wc_api_hash($ck)) {
  $wpdb->update($t, $row, ["key_id"=>$id]); echo "rest key rotated\n";
} else { echo "rest key up to date\n"; }'
echo "wp-init done"
