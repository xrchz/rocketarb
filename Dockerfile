FROM node:19-bullseye-slim

COPY . /app

RUN set -eu \
    && cd /app \
    # Save list of currently-installed packages so install dependencies can be cleanly removed later
    && apt_mark="$(apt-mark showmanual)" \
    # Docker
    && apt-get update \
    && apt-get install -y --no-install-suggests --no-install-recommends \
        curl \
        ca-certificates \
        gpg \
    # Reset apt-mark's "manual" list so that "purge --auto-remove" will remove all install dependencies
    && apt-mark showmanual | xargs apt-mark auto > /dev/null \
    && { [ -z "$apt_mark" ] || apt-mark manual $apt_mark; } \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(grep ^VERSION_CODENAME /etc/os-release | cut -d '=' -f 2) stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-suggests --no-install-recommends \
        docker-ce-cli \
        tini \
    # rocketarb
    && npm install \
    && chmod 0755 /app/*.js \
    # Cleanup
    && apt-get remove --purge --auto-remove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work

ENTRYPOINT ["/usr/bin/tini", "--", "/app/rocketarb.js"]
