# Nikto 2.5.0 from its release tag (no maintained official image). docker build -f scripts/sec/nikto.Dockerfile -t local/nikto:2.5.0 scripts/sec
FROM perl:5.40.2-slim
# Test-only scanner image, never deployed.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libnet-ssleay-perl libjson-perl libxml-writer-perl \
 && git clone --depth 1 --branch 2.5.0 https://github.com/sullo/nikto.git /opt/nikto \
 && apt-get purge -y git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /opt/nikto/.git
RUN useradd -m scan
USER scan
WORKDIR /opt/nikto/program
ENTRYPOINT ["perl", "nikto.pl"]
