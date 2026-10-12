<?php
/**
 * Title: TATVA home — our concept
 * Slug: tatva/home-concept
 * Inserter: no
 */
$img = get_theme_file_uri( 'assets/images/concept.webp' );
?>
<!-- wp:group {"style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60"}}},"layout":{"type":"constrained","contentSize":"1240px"}} -->
<div class="wp-block-group" style="padding-top:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--60)">
	<!-- wp:columns {"verticalAlignment":"center","style":{"spacing":{"blockGap":{"left":"var:preset|spacing|60"}}}} -->
	<div class="wp-block-columns are-vertically-aligned-center">
		<!-- wp:column {"verticalAlignment":"center","className":"tatva-editorial"} -->
		<div class="wp-block-column is-vertically-aligned-center tatva-editorial">
			<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} -->
			<figure class="wp-block-image size-full"><img src="<?php echo esc_url( $img ); ?>" alt="<?php echo esc_attr( tatva_image_alt( 'ed-concept', 'Hands shaping clay on a pottery wheel' ) ); ?>" width="1800" height="1200" loading="lazy" style="aspect-ratio:3/2;object-fit:cover"/></figure>
			<!-- /wp:image -->
		</div>
		<!-- /wp:column -->
		<!-- wp:column {"verticalAlignment":"center","width":"44%"} -->
		<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:44%">
			<!-- wp:paragraph {"textColor":"accent-1","fontSize":"small","style":{"typography":{"letterSpacing":"0.14em","textTransform":"uppercase","fontWeight":"600"}}} -->
			<p class="has-accent-1-color has-text-color has-small-font-size" style="font-weight:600;letter-spacing:0.14em;text-transform:uppercase">Our concept</p>
			<!-- /wp:paragraph -->
			<!-- wp:heading -->
			<h2 class="wp-block-heading">A more thoughtful way to discover brands.</h2>
			<!-- /wp:heading -->
			<!-- wp:paragraph -->
			<p>Good independent brands are spread across many websites and social profiles. TATVA brings a selection of them into one store, presents each product with clear information, and lets you buy from several brands in a single checkout.</p>
			<!-- /wp:paragraph -->
			<!-- wp:paragraph -->
			<p><a href="/our-concept/">Read about our concept</a></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:column -->
	</div>
	<!-- /wp:columns -->
</div>
<!-- /wp:group -->
