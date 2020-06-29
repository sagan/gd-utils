## Docker

docker build -t gdutils .

```
docker run -d --name gdutils \
 -v /root/files/appdata/gdutils/sa:/usr/src/app/sa \
 -v /root/files/appdata/gdutils/gdurl.sqlite:/usr/src/app/gdurl.sqlite \
 -v /root/files/appdata/gdutils/config.js:/usr/src/app/config.js \
 --env "VIRTUAL_HOST=gdutils.example.com" \
 --env "LETSENCRYPT_HOST=gdutils.example.com" \
 --env "VIRTUAL_PORT=23333" \
 --env "LETSENCRYPT_EMAIL=youremail@example.com" \
 gdutils
```

以上挂载了 sa 目录和 gdurl.sqlite, config.js；配合 [nginx-proxy](https://github.com/nginx-proxy/nginx-proxy) 和 [letsencrypt-nginx-proxy-companion](https://github.com/nginx-proxy/docker-letsencrypt-nginx-proxy-companion) 一起使用。

Test

```
curl 'https://gdutils.example.com/api/gdurl/count?fid=124pjM5LggSuwI1n40bcD5tQ13wS0M6wg'
```

Register telegram webhook

```
curl -F "url=https://gdutils.example.com/api/gdurl/tgbot" 'https://api.telegram.org/bot[YOUR_BOT_TOKEN]/setWebhook'
```
