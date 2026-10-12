<?php
/**
 * Title: TATVA — category directory
 * Slug: tatva/page-categories
 * Inserter: no
 */
?>
<!-- wp:group {"layout":{"type":"constrained","contentSize":"1240px"}} -->
<div class="wp-block-group">
	<!-- wp:paragraph {"fontSize":"large"} -->
	<p class="has-large-font-size">Good things for the way you live.</p>
	<!-- /wp:paragraph -->
	<!-- wp:html -->
	<?php echo tatva_category_tiles( true ); // phpcs:ignore WordPress.Security.EscapeOutput -- escaped inside ?>
	<!-- /wp:html -->
</div>
<!-- /wp:group -->
