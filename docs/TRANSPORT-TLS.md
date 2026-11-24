# TLS транспортного портала

APK 0.6.1 использует HTTPS API `transport.orgp.spb.ru` для автобусных маршрутов
и остановок. Для этого домена добавлена проверенная цепочка CA через Android
Network Security Configuration. Проверка сертификатов и имени сервера не
отключается; глобальное доверие устройства не изменяется.

## Причина ошибки

При диагностике 16 ноября 2026 года портал присылал старый промежуточный
сертификат Russian Trusted Sub CA 2022, хотя сертификат сайта подписан ключом
Russian Trusted Sub CA 2024. Совпадение имени issuer не делает разные ключи
взаимозаменяемыми. Кроме неверной промежуточной цепочки, российский root CA
отсутствует в стандартном наборе доверия части окружений.

Новый intermediate получен из `CA Issuers` AIA сертификата сайта, его подпись
проверена root CA из официального HTTPS-источника. Это исправление цепочки,
а не игнорирование ошибки TLS или закрепление текущего leaf-сертификата.

## Источники и fingerprints

- Root: [официальный HTTPS-файл gu-st.ru](https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt).
- Intermediate 2024: [официальный AIA/CDP digital.gov.ru](http://nuc-cdp.digital.gov.ru/cdp/subca_ssl_rsa2024.crt).

HTTP во второй ссылке — адрес публикации подписанного CA-сертификата из AIA.
Его подлинность устанавливается проверкой подписи доверенным root, полученным
по HTTPS. Приложение обращается к транспортному API по HTTPS; HTTP-трафик для
домена не разрешён.

| Встроенный файл | Сертификат | Срок окончания UTC |
| --- | --- | --- |
| `app/src/main/res/raw/transit_root_ca.pem` | Russian Trusted Root CA, serial `1000` | 27 февраля 2032, 21:04:15 |
| `app/src/main/res/raw/transit_sub_ca_2024.pem` | Russian Trusted Sub CA, serial `1005` | 19 июля 2029, 12:50:41 |

SHA-256 root:

```text
D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
```

SHA-256 intermediate 2024:

```text
21:55:78:50:36:C9:00:DB:B5:F1:BB:2A:15:69:C8:0C:55:59:5B:D6:BF:94:86:7A:29:BB:DD:BC:7D:88:A3:F2
```

Fingerprints и сроки получены через `openssl x509` из фактических PEM-файлов
репозитория. Root повторно получен из указанного HTTPS-источника и совпал с
файлом приложения; `openssl verify` подтвердил подпись intermediate этим root.

## Область доверия Android

`app/src/main/AndroidManifest.xml` подключает
`app/src/main/res/xml/network_security_config.xml`. Базовая конфигурация
оставляет системные trust anchors и запрещает cleartext-трафик. Дополнительная
конфигурация действует только для `transport.orgp.spb.ru` с
`includeSubdomains="false"` и содержит:

- системные trust anchors;
- `@raw/transit_root_ca`;
- `@raw/transit_sub_ca_2024`.

Другие домены не получают эти дополнительные anchors. Нет trust-all
TrustManager, собственного разрешения неверного hostname, `onReceivedSslError`
с продолжением подключения или отключения проверки TLS. Загрузка CA в системное
хранилище ОС не требуется. Настольный браузер может по-прежнему отвергать портал:
Android-конфигурация APK на его доверие не влияет.

При изменении цепочки портала или истечении CA нужно заново получить
официальные сертификаты, проверить подписи, сроки и fingerprints, затем
обновить ресурсы. Имя CA само по себе недостаточно для такой замены.

## Проверка

Из корня репозитория:

```bash
openssl x509 -in app/src/main/res/raw/transit_root_ca.pem \
  -noout -subject -issuer -serial -dates -fingerprint -sha256
openssl x509 -in app/src/main/res/raw/transit_sub_ca_2024.pem \
  -noout -subject -issuer -serial -dates -fingerprint -sha256
openssl verify -CAfile app/src/main/res/raw/transit_root_ca.pem \
  app/src/main/res/raw/transit_sub_ca_2024.pem
```

Ожидаемый результат последней команды — `OK`. Проверка подписи локального
intermediate отдельно не доказывает сетевой запрос WebView: его нужно
проверять установленным APK без подставленных ответов.

16 ноября 2026 года такой запрос проверен в Android WebView APK 0.6.1:
`moduleHost.enable('spb-bus')` завершился состоянием `ready`, `error: null` и
89 GeoJSON-объектами. Границы полученных данных:
`[[30.292103, 59.829613], [30.361209, 59.936718]]`. Ответы API не подменялись.
Это подтверждает работу конкретного маршрута и текущей конфигурации доверия,
но не все маршруты и будущую доступность портала. Модуль показывает маршрут
и остановки; текущих позиций движущихся автобусов в нём нет.
