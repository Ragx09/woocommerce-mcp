<?php
/**
 * Title: TATVA home — featured products
 * Slug: tatva/home-featured
 * Inserter: no
 */
// "Featured" is set deliberately by the store operator (catalogue.json → WooCommerce featured flag).
?>
<!-- wp:group {"style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|40"}}},"layout":{"type":"constrained","contentSize":"1240px"}} -->
<div class="wp-block-group" style="padding-top:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--40)">
	<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","flexWrap":"wrap"}} -->
	<div class="wp-block-group">
		<!-- wp:heading -->
		<h2 class="wp-block-heading">Featured products</h2>
		<!-- /wp:heading -->
		<!-- wp:paragraph -->
		<p><a href="/shop/">Shop all</a></p>
		<!-- /wp:paragraph -->
	</div>
	<!-- /wp:group -->
	<!-- wp:woocommerce/product-collection {"queryId":11,"query":{"perPage":8,"pages":1,"offset":0,"postType":"product","order":"asc","orderBy":"menu_order","search":"","exclude":[],"inherit":false,"taxQuery":{},"isProductCollectionBlock":true,"featured":true,"woocommerceOnSale":false,"woocommerceStockStatus":["instock","outofstock","onbackorder"],"woocommerceAttributes":[],"woocommerceHandPickedProducts":[]},"tagName":"div","displayLayout":{"type":"flex","columns":4,"shrinkColumns":true},"collection":"woocommerce/product-collection/featured","hideControls":["inherit","featured"],"queryContextIncludes":["collection"]} -->
	<div class="wp-block-woocommerce-product-collection">
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
