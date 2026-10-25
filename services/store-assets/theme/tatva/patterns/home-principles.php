<?php
/**
 * Title: TATVA home — curation principles
 * Slug: tatva/home-principles
 * Inserter: no
 */
// Only claims the store can substantiate: these describe how the demo store is put together.
$points = array(
	array( 'Curated, not crowded', 'A small selection, with a reason for every item.' ),
	array( 'Design with purpose', 'Useful, well-considered everyday objects.' ),
	array( 'Clear information', 'We show what we know about a product and leave out what we cannot confirm.' ),
	array( 'One cart, one checkout', 'Shop several brands together without leaving the store.' ),
);
?>
<!-- wp:group {"align":"full","backgroundColor":"accent-2","style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50","left":"var:preset|spacing|50","right":"var:preset|spacing|50"}}},"layout":{"type":"constrained","contentSize":"1240px"}} -->
<div class="wp-block-group alignfull has-accent-2-background-color has-background" style="padding-top:var(--wp--preset--spacing--50);padding-right:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--50);padding-left:var(--wp--preset--spacing--50)">
	<!-- wp:html -->
	<ul class="tatva-principles" aria-label="<?php echo esc_attr( 'How ' . get_bloginfo( 'name' ) . ' curates' ); ?>">
	<?php foreach ( $points as $p ) : ?>
		<li><strong><?php echo esc_html( $p[0] ); ?></strong><span><?php echo esc_html( $p[1] ); ?></span></li>
	<?php endforeach; ?>
	</ul>
	<!-- /wp:html -->
</div>
<!-- /wp:group -->
