<?php
/**
 * Plugin Name: Platform hardening
 * Description: SEC findings F-WEB-1/3/5/6/7 — no user enumeration or version strings for anonymous visitors. Mounted by the
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

/*
 * F-WEB-6 (WPScan): the login name also leaked through the feeds' <dc:creator>, oEmbed author fields,
 * and login / lost-password errors that tell "unknown user" apart from "wrong password".
 */
add_filter('the_author', function ($name) {
	return is_feed() ? get_bloginfo('name') : $name;
});

add_filter('oembed_response_data', function ($data) {
	unset($data['author_name'], $data['author_url']);
	return $data;
});

// One message for every credential failure (wp-login.php and the WooCommerce login form use wp_signon).
add_filter('authenticate', function ($user) {
	if (is_wp_error($user) && array_intersect($user->get_error_codes(), ['invalid_username', 'invalid_email', 'incorrect_password'])) {
		return new WP_Error('authentication_failed', '<strong>Error:</strong> Invalid username, email address or password.');
	}
	return $user;
}, 99);

// Lost password for an unknown account: show the same "check your email" result as for a real one.
add_action('lostpassword_post', function ($errors, $user_data) {
	if ($user_data || $errors->has_errors()) return;
	$to = isset($_POST['wc_reset_password']) && function_exists('wc_get_account_endpoint_url')
		? add_query_arg('reset-link-sent', 'true', wc_get_account_endpoint_url('lost-password'))
		: add_query_arg('checkemail', 'confirm', wp_login_url());
	wp_safe_redirect($to);
	exit;
}, 10, 2);

/*
 * F-WEB-7: no version strings for scanners — the generator tag (feeds, OPML, <head>), X-Redirect-By, and the
 * WordPress / WooCommerce version as ?ver= on their own assets (replaced by a hash: browsers still get a new
 * URL after an upgrade, scanners no longer read the version).
 */
add_filter('the_generator', '__return_empty_string');
add_filter('x_redirect_by', '__return_false');
add_action('init', function () {
	remove_action('wp_head', 'wp_generator');
	remove_action('wp_head', 'wc_generator_tag');
	remove_action('get_the_generator_html', 'wc_generator_tag', 10);
	remove_action('get_the_generator_xhtml', 'wc_generator_tag', 10);
});
function platform_hardening_mask_ver($src) {
	if (!is_string($src) || strpos($src, 'ver=') === false) return $src;
	$versions = array_filter([get_bloginfo('version'), defined('WC_VERSION') ? WC_VERSION : null]);
	parse_str((string) parse_url($src, PHP_URL_QUERY), $q);
	if (!isset($q['ver']) || !in_array($q['ver'], $versions, true)) return $src;
	return add_query_arg('ver', substr(hash_hmac('sha256', $q['ver'], wp_salt('auth')), 0, 10), $src);
}
add_filter('style_loader_src', 'platform_hardening_mask_ver', 99);
add_filter('script_loader_src', 'platform_hardening_mask_ver', 99);
