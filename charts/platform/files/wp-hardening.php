<?php
/**
 * Plugin Name: Platform hardening
 * Description: SEC findings F-WEB-1/3/5 — no user enumeration for anonymous visitors. Mounted by the
 *              chart as a must-use plugin (ConfigMap), so it cannot be disabled from wp-admin.
 *
 * - REST: /wp/v2/users only for users who may list users (wp-admin, block editor keep working).
 * - Author archives and ?author=N: 404 for visitors who are not logged in, without the canonical
 *   redirect to /author/<login>/ that revealed the admin's login name.
 * - The users sitemap is not generated.
 * woo-mcp uses the WooCommerce REST API (wc/v3) only, so none of this affects it.
 */
defined('ABSPATH') || exit;

add_filter('rest_request_before_callbacks', function ($response, $handler, $request) {
	if (preg_match('#^/wp/v2/users(/|$)#', $request->get_route()) && !current_user_can('list_users')) {
		return new WP_Error('rest_forbidden', 'Sorry, you are not allowed to list users.', ['status' => rest_authorization_required_code()]);
	}
	return $response;
}, 10, 3);

add_filter('wp_sitemaps_add_provider', function ($provider, $name) {
	return $name === 'users' ? false : $provider;
}, 10, 2);

/** True for a visitor asking for an author archive (pretty URL or ?author=). */
function platform_hardening_author_probe(): bool {
	return !is_user_logged_in() && (isset($_GET['author']) || isset($_GET['author_name']) || is_author());
}

add_filter('redirect_canonical', function ($redirect) {
	return platform_hardening_author_probe() ? false : $redirect;
});

add_action('template_redirect', function () {
	if (!platform_hardening_author_probe()) return;
	global $wp_query;
	$wp_query->set_404();
	status_header(404);
	nocache_headers();
}, 0);
