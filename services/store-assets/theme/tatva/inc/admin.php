<?php
/**
 * BRD-08: TATVA look for wp-admin and the login page. Presentation only: no capability, auth or
 * login-flow changes. The colour scheme is a normal admin colour scheme, so each user can still
 * pick another one under Users → Profile.
 *
 * @package tatva
 */

defined( 'ABSPATH' ) || exit;

/** Admin colour scheme "TATVA" (palette from theme.json). */
add_action(
	'admin_init',
	static function () {
		wp_admin_css_color(
			'tatva',
			'TATVA',
			get_theme_file_uri( 'assets/css/admin-colors.css' ) . '?v=' . wp_get_theme()->get( 'Version' ),
			array( '#173D35', '#0F2C26', '#E8DCC9', '#A4532F' ),
			array( 'base' => '#C9D3C5', 'focus' => '#E8DCC9', 'current' => '#252A27' )
		);
		// Ridgeline (bike niche) gets its own scheme from the RIDGELINE palette.
		if ( function_exists( 'tatva_niche' ) && 'bike' === tatva_niche() ) {
			wp_admin_css_color(
				'ridgeline',
				'Ridgeline',
				tatva_store_uri( 'theme/admin-colors.css', 'ridgeline' ) . '?v=' . wp_get_theme()->get( 'Version' ),
				array( '#202820', '#151A15', '#D9C8A1', '#B75C3B' ),
				array( 'base' => '#D6D3C8', 'focus' => '#D9C8A1', 'current' => '#252A27' )
			);
		}
	}
);

/** The store's own admin scheme slug: ridgeline for the bike niche, tatva otherwise. */
function tatva_admin_scheme(): string {
	return function_exists( 'tatva_niche' ) && 'bike' === tatva_niche() ? 'ridgeline' : 'tatva';
}

/**
 * Ridgeline: its mark instead of the WordPress logo in the admin bar (wp-admin and storefront). Presentation only;
 * the menu under it is unchanged.
 */
function tatva_admin_bar_logo(): void {
	if ( ! function_exists( 'tatva_niche' ) || 'bike' !== tatva_niche() || ! is_admin_bar_showing() ) {
		return;
	}
	printf(
		'<style id="ridgeline-adminbar">#wpadminbar #wp-admin-bar-wp-logo>.ab-item .ab-icon:before{content:"";display:inline-block;width:26px;height:18px;margin-top:6px;background:url(%s) center/contain no-repeat}</style>' . "\n",
		esc_url( tatva_store_uri( 'brand/ridgeline-mark-light.svg', 'ridgeline' ) )
	);
}
add_action( 'admin_head', 'tatva_admin_bar_logo' );
add_action( 'wp_head', 'tatva_admin_bar_logo' );

/** New users start with the TATVA scheme (wp-init sets it once for the existing admin user). */
add_action(
	'user_register',
	static function ( int $user_id ) {
		update_user_meta( $user_id, 'admin_color', tatva_admin_scheme() );
	}
);

/** Login page: TATVA colours and wordmark instead of the WordPress logo. */
add_action(
	'login_enqueue_scripts',
	static function () {
		$bike = function_exists( 'tatva_niche' ) && 'bike' === tatva_niche();
		wp_enqueue_style( 'tatva-login', $bike ? tatva_store_uri( 'theme/login.css', 'ridgeline' ) : get_theme_file_uri( 'assets/css/login.css' ), array(), wp_get_theme()->get( 'Version' ) );
		wp_add_inline_style(
			'tatva-login',
			sprintf(
				'@font-face{font-family:Manrope;src:url(%s) format("woff2");font-weight:200 800;font-display:swap}#login h1 a{background-image:url(%s)}',
				esc_url( get_theme_file_uri( 'assets/fonts/manrope/Manrope-VariableFont_wght.woff2' ) ),
				esc_url( $bike ? tatva_store_uri( 'brand/ridgeline-logo.svg', 'ridgeline' ) : tatva_store_uri( 'brand/wordmark.svg', 'tatva' ) )
			)
		);
		// BON-11: created stores show their own name, never the TATVA wordmark.
		if ( $bike ) {
			wp_add_inline_style( 'tatva-login', '#login h1 a{width:300px;height:60px;background-size:300px 60px}' );
		} elseif ( function_exists( 'tatva_is_default' ) && ! tatva_is_default() ) {
			wp_add_inline_style( 'tatva-login', '#login h1 a{background-image:none;text-indent:0;width:auto;height:auto;font-size:1.75rem;font-weight:600;line-height:1.3}' );
		}
	}
);
add_filter( 'login_headerurl', static fn() => home_url( '/' ) );
add_filter( 'login_headertext', static fn() => get_bloginfo( 'name' ) );
