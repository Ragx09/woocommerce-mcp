<?php
/**
 * TATVA child theme. Presentation only: products, brands, categories and images live in WooCommerce
 * (imported from services/store-assets/stores/<store>/catalogue.json by wp-init). Nothing here invents
 * product facts, reviews or stock levels.
 *
 * @package tatva
 */

defined( 'ABSPATH' ) || exit;

require_once __DIR__ . '/inc/admin.php'; // wp-admin colour scheme and login page (BRD-08)

add_action(
	'wp_enqueue_scripts',
	static function () {
		$v = wp_get_theme()->get( 'Version' );
		wp_enqueue_style( 'tatva', get_stylesheet_uri(), array(), $v );
		wp_enqueue_script( 'tatva-images', get_theme_file_uri( 'assets/js/images.js' ), array(), $v, array( 'strategy' => 'defer' ) );
	}
);

/*
 * BON-11 (A-11): created stores share this theme but are independent shops: their own name (blogname) and
 * tagline (blogdescription), a niche set by wp-init (option platform_store_niche), the niche's accent colour
 * and, where the niche has them, its own editorial images. The default store has no niche and stays TATVA.
 */
const TATVA_NICHES = array(
	// accent-1 (headings, buttons) and accent-6 (counters, highlights): dark enough for white button text
	// and for text on the light base (WCAG AA), from the same muted family as the TATVA palette.
	'stationery'    => array( 'accent' => '#1F3A5F', 'accent6' => '#A4532F', 'kicker' => 'Stationery & desk', 'title' => 'Tools for a well-kept desk.', 'text' => 'Notebooks, pens and desk objects from independent makers, in one place. Browse by category or brand and check out once.' ),
	'tea-coffee'    => array( 'accent' => '#5A3A22', 'accent6' => '#8C4A2F', 'kicker' => 'Tea & coffee', 'title' => 'A better cup, every day.', 'text' => 'Teas, coffees and the things you brew them with, from small producers. Browse by category or brand and check out once.' ),
	'home-ceramics' => array( 'accent' => '#7A3E2B', 'accent6' => '#173D35', 'kicker' => 'Home & ceramics', 'title' => 'Everyday pieces for the home.', 'text' => 'Ceramics, textiles and home objects from independent studios. Browse by category or brand and check out once.' ),
	'bags'          => array( 'accent' => '#3B3355', 'accent6' => '#A4532F', 'kicker' => 'Bags & accessories', 'title' => 'Carry what matters.', 'text' => 'Bags and everyday accessories from independent labels. Browse by category or brand and check out once.' ),
	'bike'          => array( 'accent' => '#202820', 'accent6' => '#B75C3B', 'kicker' => 'Ride. Drive. Explore.', 'title' => 'Built for better journeys.', 'text' => 'Riding gear, motorcycle and car accessories and travel essentials, curated in one store. Fitment and specifications are listed only where confirmed.' ),
	'custom'        => array( 'accent' => '#173D35', 'accent6' => '#A4532F', 'kicker' => '', 'title' => 'Welcome to our store.', 'text' => 'Products are on their way. Browse by category once they are listed, and check out in one cart.' ),
);

function tatva_niche(): string {
	$n = (string) get_option( 'platform_store_niche', '' );
	return isset( TATVA_NICHES[ $n ] ) ? $n : '';
}

/** True for the original TATVA store (no niche); its copy and images stay exactly as designed. */
function tatva_is_default(): bool {
	return '' === tatva_niche();
}

/** Niche texts for the hero; the kicker falls back to the store's tagline. */
function tatva_copy( string $key ): string {
	$n = tatva_niche();
	if ( '' === $n ) {
		return '';
	}
	$v = TATVA_NICHES[ $n ][ $key ] ?? '';
	if ( 'kicker' === $key ) {
		$tagline = trim( (string) get_bloginfo( 'description' ) );
		return '' !== $tagline ? $tagline : $v;
	}
	return $v;
}

/** Which store's own files to use (services/store-assets/stores/<store>/): ridgeline for bike, tatva otherwise. */
function tatva_store_dir(): string {
	return 'bike' === tatva_niche() ? 'ridgeline' : 'tatva';
}

/** A file shipped for a store (assets/stores/<store>/...). */
function tatva_store_uri( string $path, string $store = '' ): string {
	return get_theme_file_uri( 'assets/stores/' . ( '' !== $store ? $store : tatva_store_dir() ) . '/' . $path );
}

/** An editorial image: the store's own version when it ships one, else TATVA's. */
function tatva_image_uri( string $file ): string {
	$dir = tatva_store_dir();
	if ( is_readable( get_theme_file_path( "assets/stores/$dir/editorial/$file" ) ) ) {
		return tatva_store_uri( "editorial/$file", $dir );
	}
	return tatva_store_uri( "editorial/$file", 'tatva' );
}

/** The niche accent replaces the TATVA greens in the palette variables (presentation only). */
add_action(
	'wp_head',
	static function () {
		$n = tatva_niche();
		if ( '' === $n ) {
			return;
		}
		printf( '<style id="tatva-niche">:root{--wp--preset--color--accent-1:%s;--wp--preset--color--accent-6:%s}</style>' . "\n", esc_html( TATVA_NICHES[ $n ]['accent'] ), esc_html( TATVA_NICHES[ $n ]['accent6'] ) );
	},
	20
);

/** Ridgeline: its mark in front of the store name in the header (the name stays text, so it is read out once). */
add_filter(
	'render_block_core/site-title',
	static function ( string $html ): string {
		if ( 'bike' !== tatva_niche() ) {
			return $html;
		}
		$mark = '<img class="tatva-site-mark" src="' . esc_url( tatva_store_uri( 'brand/ridgeline-mark.svg', 'ridgeline' ) ) . '" alt="" width="40" height="25" aria-hidden="true">';
		return (string) preg_replace( '/(<a[^>]*>)/', '$1' . $mark, $html, 1 );
	}
);

/** Alt text for theme images, shipped with the theme (built from images/manifest.json, plus the niche's own). */
function tatva_manifest(): array {
	static $m = null;
	if ( null === $m ) {
		$m = array();
		$files = array_unique( array( get_theme_file_path( 'assets/stores/tatva/image-meta.json' ), get_theme_file_path( 'assets/stores/' . tatva_store_dir() . '/image-meta.json' ) ) );
		foreach ( $files as $file ) {
			if ( is_readable( $file ) ) {
				$m = array_merge( $m, (array) json_decode( (string) file_get_contents( $file ), true ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions
			}
		}
	}
	return $m;
}

function tatva_image_alt( string $key, string $fallback ): string {
	$m = tatva_manifest();
	return isset( $m[ $key ]['alt'] ) ? (string) $m[ $key ]['alt'] : $fallback;
}

/** Category tiles from WooCommerce categories that actually have products (V1 spec §4.4). */
function tatva_category_tiles( bool $with_description = false ): string {
	$terms = get_terms(
		array(
			'taxonomy'   => 'product_cat',
			'hide_empty' => true,
			'exclude'    => array( (int) get_option( 'default_product_cat' ) ),
			'meta_key'   => 'order', // phpcs:ignore WordPress.DB.SlowDBQuery -- 5 terms
			'orderby'    => 'meta_value_num',
		)
	);
	if ( is_wp_error( $terms ) || ! $terms ) {
		return '<p class="tatva-empty">Categories will appear here once products are available.</p>';
	}
	$out = '<ul class="tatva-grid tatva-grid--categories" role="list">';
	foreach ( $terms as $t ) {
		$thumb = (int) get_term_meta( $t->term_id, 'thumbnail_id', true );
		$img   = $thumb ? wp_get_attachment_image( $thumb, 'large', false, array( 'loading' => 'lazy', 'sizes' => '(max-width: 600px) 100vw, 33vw' ) ) : '<div class="tatva-img-fallback">' . esc_html( $t->name ) . '</div>';
		$out  .= '<li class="tatva-card tatva-card--category"><a href="' . esc_url( get_term_link( $t ) ) . '">'
			. '<div class="tatva-card__media tatva-editorial">' . $img . '</div>'
			. '<div class="tatva-card__body"><h3>' . esc_html( $t->name ) . '</h3>'
			. '<p class="tatva-brand">' . esc_html( sprintf( _n( '%d product', '%d products', $t->count, 'tatva' ), $t->count ) ) . '</p>'
			. ( $with_description && $t->description ? '<p>' . esc_html( $t->description ) . '</p>' : '' )
			. '</div></a></li>';
	}
	return $out . '</ul>';
}

/** Brand cards (V1 spec §6): mark, name, one-line description, "Explore brand". No logos are invented. */
function tatva_brand_cards( bool $featured_only ): string {
	$args = array(
		'taxonomy'   => 'product_brand',
		'hide_empty' => true,
		'orderby'    => 'name',
	);
	if ( $featured_only ) {
		$args['meta_query'] = array( array( 'key' => 'tatva_featured', 'value' => '1' ) ); // phpcs:ignore WordPress.DB.SlowDBQuery -- few terms
		$args['number']     = 4;
	}
	$terms = get_terms( $args );
	if ( is_wp_error( $terms ) || ! $terms ) {
		return '<p class="tatva-empty">Brands will appear here once products are available.</p>';
	}
	$out = '<ul class="tatva-grid tatva-grid--brands" role="list">';
	foreach ( $terms as $t ) {
		$url  = get_term_link( $t );
		$out .= '<li class="tatva-card tatva-card--brand">'
			. '<div class="tatva-brand-mark" aria-hidden="true">' . esc_html( $t->name ) . '</div>'
			. '<div class="tatva-card__body"><h3>' . esc_html( $t->name ) . '</h3>'
			. '<p>' . esc_html( $t->description ) . '</p>'
			. '<p class="tatva-brand">' . esc_html( sprintf( _n( '%d product', '%d products', $t->count, 'tatva' ), $t->count ) ) . '</p>'
			. '<a class="tatva-link-arrow" href="' . esc_url( $url ) . '" aria-label="' . esc_attr( 'Explore brand: ' . $t->name ) . '">Explore brand</a>'
			. '</div></li>';
	}
	return $out . '</ul>';
}

/** Brand on cart and checkout line items, so brand information is consistent across the journey. */
add_filter(
	'woocommerce_get_item_data',
	static function ( array $data, array $item ): array {
		$terms = get_the_terms( $item['product_id'] ?? 0, 'product_brand' );
		if ( $terms && ! is_wp_error( $terms ) ) {
			$data[] = array( 'key' => 'Brand', 'value' => esc_html( implode( ', ', wp_list_pluck( $terms, 'name' ) ) ) );
		}
		return $data;
	},
	10,
	2
);

/** Whole prices without ".00" (₹1,299), fractional prices exact (₹12.50): the store keeps two decimals. */
add_filter( 'woocommerce_price_trim_zeros', '__return_true' );

/** No reviews exist in this demo, so do not offer "Sort by average rating". */
add_filter(
	'woocommerce_catalog_orderby',
	static function ( array $options ): array {
		unset( $options['rating'] );
		return $options;
	}
);

