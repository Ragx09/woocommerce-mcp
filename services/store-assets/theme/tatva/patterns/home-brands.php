<?php
/**
 * Title: TATVA home — featured brands
 * Slug: tatva/home-brands
 * Inserter: no
 */
?>
<!-- wp:group {"style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|40"}}},"layout":{"type":"constrained","contentSize":"1240px"}} -->
<div class="wp-block-group" style="padding-top:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--40)">
	<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","flexWrap":"wrap"}} -->
	<div class="wp-block-group">
		<!-- wp:heading -->
		<h2 class="wp-block-heading">Featured brands</h2>
		<!-- /wp:heading -->
		<!-- wp:paragraph -->
		<p><a href="/brands/">All brands</a></p>
		<!-- /wp:paragraph -->
	</div>
	<!-- /wp:group -->
	<!-- wp:paragraph {"textColor":"accent-4"} -->
	<p class="has-accent-4-color has-text-color">Meet the makers and ideas behind the products.</p>
	<!-- /wp:paragraph -->
	<!-- wp:html -->
	<?php echo tatva_brand_cards( true ); // phpcs:ignore WordPress.Security.EscapeOutput -- escaped inside ?>
	<!-- /wp:html -->
</div>
<!-- /wp:group -->
