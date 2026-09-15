# signalk-jukebox-wyoming-bridge: bridges one Snapcast zone (from a
# signalk-jukebox install) to one Wyoming voice satellite's speaker (see
# bridge.mjs for why). Same base + Snapcast version pin as signalk-
# jukebox's own image/ and image-snapclient/, plus a Node 24 runtime for
# the bridge script itself -- signalk-wyoming requires Node >=24
# (package.json engines), well past what trixie-slim's own `nodejs` apt
# package ships, hence NodeSource rather than `apt-get install nodejs`.
#
# NOT yet build-tested end-to-end against a real satellite -- see
# bridge.mjs's own header for what has and hasn't been verified.

FROM debian:trixie-slim

ARG SNAPCAST_VERSION=0.35.0
ARG NODE_MAJOR=24
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && ARCH_SUFFIX="$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64")" \
    && curl -fsSL -o /tmp/snapclient.deb \
        "https://github.com/snapcast/snapcast/releases/download/v${SNAPCAST_VERSION}/snapclient_${SNAPCAST_VERSION}-1_${ARCH_SUFFIX}_trixie.deb" \
    && apt-get install -y --no-install-recommends /tmp/snapclient.deb \
    && rm -f /tmp/snapclient.deb && apt-get purge -y curl gnupg \
    && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev

COPY bridge.mjs /app/bridge.mjs
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
