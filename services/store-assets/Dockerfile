# Build context: repository root.  docker build -f services/store-assets/Dockerfile .
# Files only: the TATVA theme, catalogue, product/editorial images and the importer. The wp-init Job
# copies /assets into a shared volume (initContainer), then WP-CLI installs the theme and imports the
# catalogue. Images are too large for a ConfigMap (1 MiB), hence an image (D-016).
FROM busybox:1.37.0
COPY services/store-assets/catalogue /assets/catalogue
COPY services/store-assets/import /assets/import
COPY services/store-assets/images /assets/images
COPY services/store-assets/theme /assets/theme
# Editorial images and alt text used directly by the theme's patterns.
COPY services/store-assets/images/editorial /assets/theme/tatva/assets/images
COPY services/store-assets/images/manifest.json /assets/theme/tatva/assets/image-meta.json
USER 65534:65534
CMD ["cp", "-r", "/assets/.", "/out/"]
