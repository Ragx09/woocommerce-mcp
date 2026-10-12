<?php
/**
 * Title: TATVA home — shop by category
 * Slug: tatva/home-categories
 * Inserter: no
 */
?>
<!-- wp:group {"style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|40"}}},"layout":{"type":"constrained","contentSize":"1240px"}} -->
<div class="wp-block-group" style="padding-top:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--40)">
	<!-- wp:heading -->
	<h2 class="wp-block-heading">Shop by category</h2>
	<!-- /wp:heading -->
	<!-- wp:paragraph {"textColor":"accent-4"} -->
	<p class="has-accent-4-color has-text-color">Good things for the way you live.</p>
	<!-- /wp:paragraph -->
	<!-- wp:html -->
	<?php echo tatva_category_tiles(); // phpcs:ignore WordPress.Security.EscapeOutput -- escaped inside ?>
	<!-- /wp:html -->
</div>
<!-- /wp:group -->
