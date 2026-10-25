<?php
/**
 * Title: TATVA home — curated collection
 * Slug: tatva/home-collection
 * Inserter: no
 */
$tag = get_term_by( 'slug', (string) get_option( 'platform_collection_tag', 'the-morning-table' ), 'product_tag' );
if ( ! $tag ) {
	return; // collection not imported yet: show nothing rather than an empty section
}
$img = tatva_image_uri( 'collection.webp' );
?>
<!-- wp:group {"align":"full","backgroundColor":"accent-2","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60","left":"var:preset|spacing|50","right":"var:preset|spacing|50"}}},"layout":{"type":"constrained","contentSize":"1240px"}} -->
<div class="wp-block-group alignfull has-accent-2-background-color has-background" style="padding-top:var(--wp--preset--spacing--60);padding-right:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--60);padding-left:var(--wp--preset--spacing--50)">
	<!-- wp:columns {"verticalAlignment":"center","style":{"spacing":{"blockGap":{"left":"var:preset|spacing|60"}}}} -->
	<div class="wp-block-columns are-vertically-aligned-center">
		<!-- wp:column {"verticalAlignment":"center","width":"38%"} -->
		<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:38%">
			<!-- wp:paragraph {"textColor":"accent-1","fontSize":"small","style":{"typography":{"letterSpacing":"0.14em","textTransform":"uppercase","fontWeight":"600"}}} -->
			<p class="has-accent-1-color has-text-color has-small-font-size" style="font-weight:600;letter-spacing:0.14em;text-transform:uppercase">Curated collection</p>
			<!-- /wp:paragraph -->
			<!-- wp:heading -->
			<h2 class="wp-block-heading"><?php echo esc_html( $tag->name ); ?></h2>
			<!-- /wp:heading -->
			<!-- wp:paragraph -->
			<p><?php echo esc_html( $tag->description ); ?></p>
			<!-- /wp:paragraph -->
			<!-- wp:paragraph -->
			<p><a href="<?php echo esc_url( get_term_link( $tag ) ); ?>">See the whole collection</a></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:column -->
		<!-- wp:column {"verticalAlignment":"center","className":"tatva-editorial"} -->
		<div class="wp-block-column is-vertically-aligned-center tatva-editorial">
			<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} -->
			<figure class="wp-block-image size-full"><img src="<?php echo esc_url( $img ); ?>" alt="<?php echo esc_attr( tatva_image_alt( 'ed-collection', 'A breakfast table with coffee in the morning light' ) ); ?>" width="1800" height="1200" loading="lazy" style="aspect-ratio:3/2;object-fit:cover"/></figure>
			<!-- /wp:image -->
		</div>
		<!-- /wp:column -->
	</div>
	<!-- /wp:columns -->
	<!-- wp:woocommerce/product-collection {"queryId":12,"query":{"perPage":6,"pages":1,"offset":0,"postType":"product","order":"asc","orderBy":"menu_order","search":"","exclude":[],"inherit":false,"taxQuery":{"product_tag":[<?php echo (int) $tag->term_id; ?>]},"isProductCollectionBlock":true,"featured":false,"woocommerceOnSale":false,"woocommerceStockStatus":["instock","outofstock","onbackorder"],"woocommerceAttributes":[],"woocommerceHandPickedProducts":[]},"tagName":"div","displayLayout":{"type":"flex","columns":6,"shrinkColumns":true},"queryContextIncludes":["collection"],"style":{"spacing":{"margin":{"top":"var:preset|spacing|50"}}}} -->
	<div class="wp-block-woocommerce-product-collection" style="margin-top:var(--wp--preset--spacing--50)">
		<!-- wp:woocommerce/product-template -->
			<!-- wp:woocommerce/product-image {"showSaleBadge":false,"imageSizing":"thumbnail","isDescendentOfQueryLoop":true,"aspectRatio":"4/5","scale":"cover"} /-->
			<!-- wp:post-title {"level":3,"isLink":true,"fontSize":"medium","style":{"spacing":{"margin":{"top":"0.75rem","bottom":"0.15rem"}},"typography":{"fontWeight":"600"}},"fontFamily":"manrope","__woocommerceNamespace":"woocommerce/product-collection/product-title"} /-->
			<!-- wp:post-terms {"term":"product_brand","style":{"spacing":{"margin":{"top":"0","bottom":"0.35rem"}}}} /-->
			<!-- wp:woocommerce/product-price {"isDescendentOfQueryLoop":true,"fontSize":"medium"} /-->
			<!-- /wp:woocommerce/product-template -->
	</div>
	<!-- /wp:woocommerce/product-collection -->
</div>
<!-- /wp:group -->
