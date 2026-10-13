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
	}
);

/** New users start with the TATVA scheme (wp-init sets it once for the existing admin user). */
add_action(
	'user_register',
	static function ( int $user_id ) {
		update_user_meta( $user_id, 'admin_color', 'tatva' );
	}
);

/** Login page: TATVA colours and wordmark instead of the WordPress logo. */
add_action(
	'login_enqueue_scripts',
	static function () {
		wp_enqueue_style( 'tatva-login', get_theme_file_uri( 'assets/css/login.css' ), array(), wp_get_theme()->get( 'Version' ) );
		wp_add_inline_style(
			'tatva-login',
			sprintf(
				'@font-face{font-family:Manrope;src:url(%s) format("woff2");font-weight:200 800;font-display:swap}#login h1 a{background-image:url(%s)}',
				esc_url( get_theme_file_uri( 'assets/fonts/manrope/Manrope-VariableFont_wght.woff2' ) ),
				esc_url( get_theme_file_uri( 'assets/images/tatva-wordmark.svg' ) )
			)
		);
	}
);
add_filter( 'login_headerurl', static fn() => home_url( '/' ) );
add_filter( 'login_headertext', static fn() => get_bloginfo( 'name' ) );
