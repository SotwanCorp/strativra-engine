# Tracking Audit Engine worker. Playwright image tag matches playwright-core 1.64.1
# (tag verified on mcr.microsoft.com 2026-10-23). Keep the two in sync when upgrading.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8787

WORKDIR /app

# Dependencies first for layer caching. Browsers already ship in the base image,
# so never run `playwright install`.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Stable path to the image's Chromium, whatever its build number is.
RUN set -e; \
    CHROME="$(find /ms-playwright -path '*chromium-*' -name chrome -type f | head -n 1)"; \
    test -n "$CHROME"; \
    ln -s "$(dirname "$CHROME")" /opt/chromium
ENV CHROMIUM_PATH=/opt/chromium/chrome

# Non-root user shipped with the Playwright image.
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --experimental-strip-types is harmless where Node strips types by default.
# node:sqlite needs no flag on Node >= 22.13 (an ExperimentalWarning is printed).
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/worker/main.ts"]
