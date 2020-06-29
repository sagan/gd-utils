#!/bin/sh

docker run -d --name gdutils \
 -v /root/files/appdata/gdutils/sa:/usr/src/app/sa \
 -v /root/files/appdata/gdutils/gdurl.sqlite:/usr/src/app/gdurl.sqlite \
 -v /root/files/appdata/gdutils/config.js:/usr/src/app/config.js \
 --env "VIRTUAL_HOST=gdutils.example.com"" \
 --env "LETSENCRYPT_HOST=gdutils.example.com" \
 --env "VIRTUAL_PORT=23333" \
 --env "LETSENCRYPT_EMAIL=youremail@example.com" \
 gdutils