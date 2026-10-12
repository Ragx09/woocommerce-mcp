// Missing or failed images: replace with a calm sand panel naming the item, instead of a broken icon.
(function () {
	function fallback(img) {
		if (img.dataset.tatvaFallback) return;
		img.dataset.tatvaFallback = '1';
		img.classList.add('tatva-img-missing');
		var box = document.createElement('div');
		box.className = 'tatva-img-fallback';
		box.setAttribute('role', 'img');
		box.setAttribute('aria-label', img.alt || 'Image not available');
		box.textContent = 'Image not available';
		img.replaceWith(box);
	}
	document.addEventListener('error', function (e) {
		if (e.target && e.target.tagName === 'IMG') fallback(e.target);
	}, true);
	document.querySelectorAll('img').forEach(function (img) {
		if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) fallback(img);
	});
})();
