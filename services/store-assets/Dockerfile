# Build context: repository root.  docker build -f services/store-assets/Dockerfile .
# Files only: the shared theme, the importer and each store's own data (stores/<store>/: catalogue, images, brand,
# theme extras). The wp-init Job copies /assets into a shared volume (initContainer), then WP-CLI installs the
# theme and imports the store's catalogue. Images are too large for a ConfigMap (1 MiB), hence an image (D-016).
FROM busybox:1.37.0
COPY services/store-assets/import /assets/import
COPY services/store-assets/stores /assets/stores
COPY services/store-assets/theme /assets/theme
# What the theme shows directly (editorial images + alt texts, brand marks, store CSS), per store, inside the theme.
COPY services/store-assets/stores/tatva/images/editorial /assets/theme/tatva/assets/stores/tatva/editorial
COPY services/store-assets/stores/tatva/images/manifest.json /assets/theme/tatva/assets/stores/tatva/image-meta.json
COPY services/store-assets/stores/tatva/brand /assets/theme/tatva/assets/stores/tatva/brand
COPY services/store-assets/stores/ridgeline/images/editorial /assets/theme/tatva/assets/stores/ridgeline/editorial
COPY services/store-assets/stores/ridgeline/images/manifest.json /assets/theme/tatva/assets/stores/ridgeline/image-meta.json
COPY services/store-assets/stores/ridgeline/brand /assets/theme/tatva/assets/stores/ridgeline/brand
COPY services/store-assets/stores/ridgeline/theme /assets/theme/tatva/assets/stores/ridgeline/theme
USER 65534:65534
CMD ["cp", "-r", "/assets/.", "/out/"]
