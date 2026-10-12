<?php
/**
 * Title: TATVA — brand directory
 * Slug: tatva/page-brands
 * Inserter: no
 */
?>
<!-- wp:group {"layout":{"type":"constrained","contentSize":"1240px"}} -->
<div class="wp-block-group">
	<!-- wp:paragraph {"fontSize":"large"} -->
	<p class="has-large-font-size">Explore the brands in the TATVA collection and everything we stock from each of them.</p>
	<!-- /wp:paragraph -->
	<!-- wp:paragraph {"className":"tatva-demo-note"} -->
	<p class="tatva-demo-note">Demo store: these brand names are placeholders. They are not real businesses and no partnership is implied.</p>
	<!-- /wp:paragraph -->
	<!-- wp:html -->
	<?php echo tatva_brand_cards( false ); // phpcs:ignore WordPress.Security.EscapeOutput -- escaped inside ?>
	<!-- /wp:html -->
</div>
<!-- /wp:group -->
