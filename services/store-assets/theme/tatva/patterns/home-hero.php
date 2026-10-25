<?php
/**
 * Title: TATVA home — editorial hero
 * Slug: tatva/home-hero
 * Inserter: no
 */
$hero = tatva_image_uri( 'hero.webp' );
$d    = tatva_is_default();
?>
<!-- wp:group {"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60","left":"var:preset|spacing|50","right":"var:preset|spacing|50"}}},"layout":{"type":"constrained","contentSize":"1240px"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--60);padding-right:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--60);padding-left:var(--wp--preset--spacing--50)">
	<!-- wp:columns {"verticalAlignment":"center","style":{"spacing":{"blockGap":{"left":"var:preset|spacing|60"}}}} -->
	<div class="wp-block-columns are-vertically-aligned-center">
		<!-- wp:column {"verticalAlignment":"center","width":"44%"} -->
		<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:44%">
			<!-- wp:paragraph {"textColor":"accent-1","fontSize":"small","style":{"typography":{"letterSpacing":"0.14em","textTransform":"uppercase","fontWeight":"600"}}} -->
			<p class="has-accent-1-color has-text-color has-small-font-size" style="font-weight:600;letter-spacing:0.14em;text-transform:uppercase"><?php echo $d ? 'The Essence of Good Design.' : esc_html( tatva_copy( 'kicker' ) ); ?></p>
			<!-- /wp:paragraph -->
			<!-- wp:heading {"level":1} -->
			<h1 class="wp-block-heading"><?php echo $d ? 'Discover something different.' : esc_html( tatva_copy( 'title' ) ); ?></h1>
			<!-- /wp:heading -->
			<!-- wp:paragraph {"fontSize":"large"} -->
			<p class="has-large-font-size"><?php echo $d ? 'Distinctive products from independent Indian lifestyle brands, brought together in one place. Browse by category or brand, and check out once.' : esc_html( tatva_copy( 'text' ) ); ?></p>
			<!-- /wp:paragraph -->
			<!-- wp:buttons -->
			<div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/shop/">Explore the collection</a></div><!-- /wp:button -->
			<!-- wp:button {"className":"is-style-outline"} --><div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="/brands/">Meet the brands</a></div><!-- /wp:button --></div>
			<!-- /wp:buttons -->
		</div>
		<!-- /wp:column -->
		<!-- wp:column {"verticalAlignment":"center","className":"tatva-editorial"} -->
		<div class="wp-block-column is-vertically-aligned-center tatva-editorial">
			<!-- wp:image {"sizeSlug":"full","linkDestination":"none","style":{"border":{"radius":"2px"}}} -->
			<figure class="wp-block-image size-full has-custom-border"><img src="<?php echo esc_url( $hero ); ?>" alt="<?php echo esc_attr( tatva_image_alt( 'ed-hero', 'Ceramics and plants arranged on a table in soft daylight' ) ); ?>" width="1800" height="1200" style="border-radius:2px;aspect-ratio:3/2;object-fit:cover" fetchpriority="high"/></figure>
			<!-- /wp:image -->
		</div>
		<!-- /wp:column -->
	</div>
	<!-- /wp:columns -->
</div>
<!-- /wp:group -->
