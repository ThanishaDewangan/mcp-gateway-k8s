FROM wordpress:7.0-apache

ARG WOOCOMMERCE_VERSION=11.2.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip mariadb-client \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip -o /tmp/woocommerce.zip \
  && unzip -q /tmp/woocommerce.zip -d /usr/src/wordpress/wp-content/plugins \
  && rm /tmp/woocommerce.zip \
  && curl -fsSL https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o /usr/local/bin/wp \
  && chmod +x /usr/local/bin/wp

COPY wordpress/start-wordpress.sh /usr/local/bin/start-wordpress
RUN sed -i 's/\r$//' /usr/local/bin/start-wordpress \
  && chmod +x /usr/local/bin/start-wordpress

ENTRYPOINT ["/usr/local/bin/start-wordpress"]
