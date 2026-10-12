<?php
/**
 * TATVA child theme. Presentation only: products, brands, categories and images live in WooCommerce
 * (imported from services/store-assets/catalogue/catalogue.json by wp-init). Nothing here invents
 * product facts, reviews or stock levels.
 *
 * @package tatva
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'wp_enqueue_scripts',
	static function () {
		$v = wp_get_theme()->get( 'Version' );
		wp_enqueue_style( 'tatva', get_stylesheet_uri(), array(), $v );
		wp_enqueue_script( 'tatva-images', get_theme_file_uri( 'assets/js/images.js' ), array(), $v, array( 'strategy' => 'defer' ) );
	}
);

/** Alt text for theme images, shipped with the theme (built from images/manifest.json). */
function tatva_manifest(): array {
	static $m = null;
	if ( null === $m ) {
		$file = get_theme_file_path( 'assets/image-meta.json' );
		$m    = is_readable( $file ) ? (array) json_decode( (string) file_get_contents( $file ), true ) : array(); // phpcs:ignore WordPress.WP.AlternativeFunctions
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

/** No reviews exist in this demo, so do not offer "Sort by average rating". */
add_filter(
	'woocommerce_catalog_orderby',
	static function ( array $options ): array {
		unset( $options['rating'] );
		return $options;
	}
);

