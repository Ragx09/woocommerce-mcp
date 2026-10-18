<?php
/**
 * TATVA catalogue import (BRD-05/06). Run by wp-init:  wp eval-file /assets/import/import-catalogue.php
 *
 * Idempotent: categories/brands/tags by slug, products by SKU, images by key + checksum. Re-running
 * changes nothing when the catalogue and images are unchanged. Single source of truth:
 * /assets/catalogue/catalogue.json (services/store-assets/catalogue/catalogue.json in git).
 * Uses the normal WooCommerce data model and media library; no direct SQL.
 */

defined( 'ABSPATH' ) || exit;

require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/image.php';

$assets = getenv( 'ASSETS_DIR' ) ?: '/assets';
$cat    = json_decode( (string) file_get_contents( "$assets/catalogue/catalogue.json" ), true );
$meta   = json_decode( (string) file_get_contents( "$assets/images/manifest.json" ), true );
if ( ! is_array( $cat ) || ! is_array( $meta ) ) {
	WP_CLI::error( 'catalogue.json or manifest.json missing or invalid' );
}
if ( ! taxonomy_exists( 'product_brand' ) ) {
	WP_CLI::error( 'WooCommerce Brands (product_brand) is not available' );
}
$stats  = array( 'created' => 0, 'updated' => 0, 'unchanged' => 0, 'images' => 0, 'trashed' => 0 );
$fields = array(); // product fields that changed in this run (logged for transparency)

/** Media library attachment for an image slot; re-uploaded only when the file changed. */
function tatva_attachment( string $key, string $file, string $alt, array &$stats ): int {
	if ( ! is_readable( $file ) ) {
		WP_CLI::warning( "image missing for $key: $file" );
		return 0;
	}
	$sha = sha1_file( $file );
	$ids = get_posts( array( 'post_type' => 'attachment', 'post_status' => 'inherit', 'fields' => 'ids', 'numberposts' => 1,
		'meta_key' => '_tatva_image_key', 'meta_value' => $key ) ); // phpcs:ignore WordPress.DB.SlowDBQuery
	if ( $ids && get_post_meta( $ids[0], '_tatva_sha1', true ) === $sha ) {
		update_post_meta( $ids[0], '_wp_attachment_image_alt', $alt );
		return (int) $ids[0];
	}
	$tmp = wp_tempnam( basename( $file ) );
	copy( $file, $tmp ); // media_handle_sideload moves the file; keep the source intact
	$id = media_handle_sideload( array( 'name' => basename( $file ), 'tmp_name' => $tmp ), 0, $alt );
	if ( is_wp_error( $id ) ) {
		@unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
		WP_CLI::warning( "upload failed for $key: " . $id->get_error_message() );
		return $ids ? (int) $ids[0] : 0;
	}
	if ( $ids ) {
		wp_delete_attachment( $ids[0], true ); // replaced by the new file
	}
	update_post_meta( $id, '_tatva_image_key', $key );
	update_post_meta( $id, '_tatva_sha1', $sha );
	update_post_meta( $id, '_wp_attachment_image_alt', $alt );
	$stats['images']++;
	return (int) $id;
}

function tatva_term( string $taxonomy, string $slug, string $name, string $description ): int {
	$t = get_term_by( 'slug', $slug, $taxonomy );
	if ( ! $t ) {
		$r = wp_insert_term( $name, $taxonomy, array( 'slug' => $slug, 'description' => $description ) );
		if ( is_wp_error( $r ) ) {
			WP_CLI::error( "$taxonomy $slug: " . $r->get_error_message() );
		}
		return (int) $r['term_id'];
	}
	if ( $t->name !== $name || $t->description !== $description ) {
		wp_update_term( $t->term_id, $taxonomy, array( 'name' => $name, 'description' => $description ) );
	}
	return (int) $t->term_id;
}

// Store presentation: INR with two decimals so prices are never rounded (₹12.50 is shown and charged as 12.50);
// the tatva theme hides a zero fraction, so whole prices still read ₹1,299. Reviews off (no review data exists).
update_option( 'woocommerce_price_num_decimals', 2 );
update_option( 'woocommerce_price_thousand_sep', ',' );
update_option( 'woocommerce_price_decimal_sep', '.' );
update_option( 'woocommerce_currency_pos', 'left' );
update_option( 'woocommerce_enable_reviews', 'no' );
update_option( 'blogdescription', $cat['store']['tagline'] );

// Categories (ordered as in the catalogue; image = editorial category tile).
$cat_ids = array();
foreach ( $cat['categories'] as $i => $c ) {
	$id = tatva_term( 'product_cat', $c['slug'], $c['name'], $c['description'] );
	update_term_meta( $id, 'order', $i + 1 );
	$key = 'ed-category-' . $c['slug'];
	$img = tatva_attachment( $key, "$assets/images/{$c['image']}", $meta[ $key ]['alt'] ?? $c['name'], $stats );
	if ( $img ) {
		update_term_meta( $id, 'thumbnail_id', $img );
	}
	$cat_ids[ $c['slug'] ] = $id;
}

// Brands: placeholder names; the four with the most products are featured on the homepage.
$brand_ids = array();
$counts    = array_count_values( array_column( $cat['products'], 'brand' ) );
arsort( $counts );
$featured_brands = array_slice( array_keys( $counts ), 0, 4 );
foreach ( $cat['brands'] as $b ) {
	$id = tatva_term( 'product_brand', $b['slug'], $b['name'], $b['description'] );
	update_term_meta( $id, 'tatva_featured', in_array( $b['name'], $featured_brands, true ) ? '1' : '0' );
	$brand_ids[ $b['name'] ] = $id;
}

$tag_ids = array();
foreach ( $cat['collections'] as $col ) {
	$tag_ids[ $col['tag'] ] = tatva_term( 'product_tag', $col['tag'], $col['name'], $col['description'] );
}

// Products by SKU.
$skus = array();
foreach ( $cat['products'] as $order => $p ) {
	$skus[] = $p['sku'];
	$key    = strtolower( $p['sku'] );
	$id     = wc_get_product_id_by_sku( $p['sku'] );
	$is_new = ! $id;
	$prod   = $id ? wc_get_product( $id ) : new WC_Product_Simple();
	$prod->set_name( $p['name'] );
	$prod->set_slug( $p['slug'] );
	$prod->set_sku( $p['sku'] );
	$prod->set_regular_price( $p['regular_price'] );
	$prod->set_short_description( $p['short_description'] );
	$prod->set_description( $p['short_description'] );
	$prod->set_category_ids( array( $cat_ids[ $p['category'] ] ) );
	$prod->set_tag_ids( array_map( static fn( $t ) => $tag_ids[ $t ], $p['tags'] ) );
	$prod->set_featured( (bool) $p['featured'] );
	$prod->set_status( 'publish' );
	$prod->set_catalog_visibility( 'visible' );
	$prod->set_manage_stock( false ); // no invented stock quantities
	$prod->set_stock_status( 'instock' );
	$prod->set_reviews_allowed( false );
	$prod->set_menu_order( $order );
	$img = tatva_attachment( $key, "$assets/images/{$p['image']}", $meta[ $key ]['alt'] ?? $p['name'], $stats );
	if ( (int) $prod->get_image_id( 'edit' ) !== $img ) { // stored as a string: compare as numbers
		$prod->set_image_id( $img ); // 0 = no image → WooCommerce placeholder, theme shows its fallback
	}
	// WC_Data only records real differences, so an unchanged product is not saved (no modified-date churn).
	$changed = $is_new || $prod->get_changes();
	if ( ! $is_new ) {
		foreach ( array_keys( $prod->get_changes() ) as $f ) {
			$fields[ $f ] = ( $fields[ $f ] ?? 0 ) + 1;
		}
	}
	if ( $changed ) {
		$id = $prod->save();
	}
	$brand_before = wp_get_object_terms( $id, 'product_brand', array( 'fields' => 'ids' ) );
	if ( $brand_before !== array( $brand_ids[ $p['brand'] ] ) ) {
		wp_set_object_terms( $id, array( $brand_ids[ $p['brand'] ] ), 'product_brand' );
		$changed                 = true;
		$fields['brand'] = ( $fields['brand'] ?? 0 ) + 1;
	}
	if ( $img && (int) get_post_field( 'post_parent', $img ) !== $id ) {
		wp_update_post( array( 'ID' => $img, 'post_parent' => $id ) );
	}
	$stats[ $is_new ? 'created' : ( $changed ? 'updated' : 'unchanged' ) ]++;
}

// Retire products that are not in the catalogue: the old sample products and removed TATVA SKUs.
// Trash, not delete: orders keep their line items and an admin can restore them.
$stale = get_posts( array( 'post_type' => 'product', 'post_status' => array( 'publish', 'draft', 'private' ), 'fields' => 'ids', 'numberposts' => -1 ) );
foreach ( $stale as $pid ) {
	$sku = (string) get_post_meta( $pid, '_sku', true );
	$old_sample = in_array( get_the_title( $pid ), array( 'Urumi Mug', 'Urumi T-Shirt', 'Urumi Sticker Pack' ), true );
	if ( $old_sample || ( str_starts_with( $sku, 'TAT-' ) && ! in_array( $sku, $skus, true ) ) ) {
		wp_trash_post( $pid );
		$stats['trashed']++;
	}
}

// Content pages; their bodies are theme patterns, so the text lives in git, not in the database.
$pages = array(
	'brands'      => array( 'Brands', 'tatva/page-brands' ),
	'categories'  => array( 'Categories', 'tatva/page-categories' ),
	'our-concept' => array( 'Our Concept', 'tatva/page-concept' ),
);
foreach ( $pages as $slug => [ $title, $pattern ] ) {
	$content = '<!-- wp:pattern {"slug":"' . $pattern . '"} /-->';
	$page    = get_page_by_path( $slug );
	if ( ! $page ) {
		wp_insert_post( array( 'post_type' => 'page', 'post_status' => 'publish', 'post_name' => $slug, 'post_title' => $title, 'post_content' => $content ) );
	} elseif ( $page->post_content !== $content || $page->post_title !== $title ) {
		wp_update_post( array( 'ID' => $page->ID, 'post_title' => $title, 'post_content' => $content ) );
	}
}

// Site icon (favicon) from the brand mark.
$icon = tatva_attachment( 'site-icon', "$assets/images/brand/site-icon.png", 'TATVA', $stats );
if ( $icon ) {
	update_option( 'site_icon', $icon );
}

if ( $fields ) {
	WP_CLI::log( 'changed fields: ' . wp_json_encode( $fields ) );
}
wc_delete_product_transients();
WP_CLI::success( sprintf( 'catalogue: %d products (%d created, %d updated, %d unchanged), %d images uploaded, %d retired',
	count( $cat['products'] ), $stats['created'], $stats['updated'], $stats['unchanged'], $stats['images'], $stats['trashed'] ) );
