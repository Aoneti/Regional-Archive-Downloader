# Regional Archive Downloader

[![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)](https://github.com)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

## 📖 Описание

**Regional Archive Downloader** — расширение для браузера, которое позволяет скачивать страницы архивных документов в виде изображений или собирать их в единый PDF-файл.

Расширение поддерживает три архивных платформы:

- **ЭЛАР-Архив** — тайловый DeepZoom-просмотрщик (одно- и многотайловый режим)
- **КАИСА-Архив** — просмотрщик на базе viewer.js; изображения встроены в DOM страницы
- **Стандартный режим** — прямые URL изображений, бинарный поиск числа страниц

> ⚠️ **Важно:** Расширение находится в активной разработке и не проверено на большинстве поддерживаемых архивов. Часть функций может работать иначе, чем ожидается. **Если что-то не работает или работает неправильно — пожалуйста, напишите об этом:**
> 👉 **https://t.me/orsegen**
> Ваша обратная связь напрямую определяет, что будет исправлено и добавлено.

---

## ✨ Возможности

### Основные
- **Скачать документ** — все страницы одним нажатием
- **Скачать PDF** — сборка в единый файл через Web Worker (нет лимита страниц, вкладка не замерзает)
- **Скачать текущую страницу**
- **Диапазон страниц** — двойной слайдер с вводом с клавиатуры, диапазон сохраняется между сессиями
- **Пауза / Продолжение / Стоп**
- **Продолжение после прерывания** — расширение запоминает прогресс

### Дополнительно
- 📁 Папки для каждого документа
- 📊 Экспорт метаданных: CSV, JSON, BibTeX
- 📝 Заметки с тегами (`#хештег`) и полнотекстовым поиском по всем делам
- 📂 Проекты — группировка дел в исследование, статусы, кликабельные ссылки на документы
- 📜 История загрузок: фильтр по формату, статистика, экспорт в CSV
- 🔔 Прогресс на иконке, уведомление по завершении
- 🌓 Тёмная / светлая / системная тема
- ⚡ Адаптивная скорость

---

## 📦 Установка

1. Скачайте ZIP и распакуйте
2. Откройте `chrome://extensions/`, включите **Режим разработчика**
3. Нажмите **«Загрузить распакованное расширение»**, выберите папку

При обновлении: удалите старую версию, установите новую.

---

## 🏛️ Поддерживаемые архивы

### Стандартный режим

| Архив | Ссылка | ✅ |
|-------|--------|---|
| Государственный архив Ярославской области | [af.yar-archives.ru](https://af.yar-archives.ru) | ✅ |
| Государственный архив Вологодской области | [gosarchive.gov35.ru](https://gosarchive.gov35.ru) | ✅ |
| Государственный архив Пермского края | [archives.permkrai.ru](https://archives.permkrai.ru) | ✅ |
| Государственный архив Саратовской области | [archivesaratov.ru](https://archivesaratov.ru) | ✅ |
| Государственный архив Тверской области | [archives.tverreg.ru](https://archives.tverreg.ru) | ✅ |
| Архив Югры | [archivesugra.ru](https://archivesugra.ru) | ✅ |
| Государственный исторический архив Чувашской Республики | [giachr.archives21.ru](https://giachr.archives21.ru) | ✅ |
| Государственный архив Красноярского края | [catalog.krasarh.ru](https://catalog.krasarh.ru) | ✅ |
| Государственный архив Архангельской области | [archives.dvinaland.ru](https://archives.dvinaland.ru) | ✅ |
| Государственный архив Брянской области | [el.archive-bryansk.ru](https://el.archive-bryansk.ru) | ✅ |
| Государственный архив Ивановской области | [af.ivarh.ru](https://af.ivarh.ru) | ✅ |
| Государственный архив Калужской области | [archive.admoblkaluga.ru](https://archive.admoblkaluga.ru) | ✅ |
| Архив Ленинградской области | [archiveslo.ru](https://archiveslo.ru) | ✅ |
| Архив Новосибирской области | [gisarchive.nso.ru](https://gisarchive.nso.ru) | ✅ |
| Государственный архив Омской области | [lk.iaoo.ru](https://lk.iaoo.ru) | ✅ |
| Коми-Пермяцкий окружной государственный архив | [komi-permarchiv.ru](https://www.komi-permarchiv.ru) | ✅ |
| Государственный архив Псковской области | [archpskov.kaisa.ru](http://archpskov.kaisa.ru) | ✅ |
| Государственный архив Тульской области | [gato.tularegion.ru](https://gato.tularegion.ru) | ✅ |
| Государственный архив Тамбовской области | [kaisa.tambovarchiv.ru](https://kaisa.tambovarchiv.ru) | ✅ |
| Государственный архив Ульяновской области | [ogugauo.ru](https://ogugauo.ru) · [ulian.kaisa.ru](https://ulian.kaisa.ru) | ✅ |
| Государственный архив Иркутской области | [гаио.рф](https://гаио.рф) | ✅ |

### ЭЛАР-Архив

| Архив | Ссылка | ✅ |
|-------|--------|---|
| Государственный архив Тюменской области | [gato.72to.ru](https://gato.72to.ru) | ✅ |
| Объединённый государственный архив Челябинской области | [ais.archive74.ru](https://ais.archive74.ru) | ✅ |
| Государственный архив Республики Крым | [188.191.26.35:52152](http://188.191.26.35:52152) | ✅ |
| Государственный архив ЯНАО | [ea.yanao.ru](https://ea.yanao.ru) | ✅ |
| Государственный архив города Севастополя | [aisarhiv.sev.gov.ru](https://aisarhiv.sev.gov.ru) | ✅ |
| Государственный архив Курской области | [kga.rkursk.ru](https://kga.rkursk.ru) | ✅ |
| Государственный архив Мурманской области | [aisdafmo.gov-murman.ru](https://aisdafmo.gov-murman.ru) | ✅ |
| ЦГА Самарской области | [cgaso.regsamarh.ru](https://cgaso.regsamarh.ru) | ✅ |
| Государственный архив Сахалинской области | [eais.sakhalin.gov.ru](https://eais.sakhalin.gov.ru) | ✅ |
| Национальный архив Республики Саха (Якутия) | [archive.sakha.gov.ru](https://archive.sakha.gov.ru) | ✅ |
| Государственный архив Ставропольского края | [gisais.stavkomarchiv.ru](https://gisais.stavkomarchiv.ru) | ✅ |
| Государственный архив Республики Татарстан | [chitzal.eais.tatar.ru](https://chitzal.eais.tatar.ru) | ✅ |
| Государственный архив Пензенской области | [ais.arhivpnz.ru](https://ais.arhivpnz.ru) | ✅ |
| Государственный архив Воронежской области | [arsvo.ru](https://arsvo.ru) · [gavo.arsvo.ru](https://gavo.arsvo.ru) | ✅ |

### КАИСА-Архив

| Архив | Ссылка | ✅ |
|-------|--------|---|
| Государственный архив Тульской области | [gato.tularegion.ru](https://gato.tularegion.ru) | ✅ |
| Архивы Московской области | [arch.mosreg.ru](http://arch.mosreg.ru) | ✅ |
| Государственный архив Владимирской области | [vladimir.kaisa.ru](https://vladimir.kaisa.ru) | ✅ |
| Государственный архив Псковской области | [archpskov.kaisa.ru](http://archpskov.kaisa.ru) | ✅ |
| Государственный архив Томской области | [archtomsk.tomica.ru](http://archtomsk.tomica.ru) | ✅ |
| Государственный архив Республики Бурятия | [garb.kaisa.ru](https://garb.kaisa.ru) | ✅ |
| Государственный архив Хабаровского края | [gakhk.khabkrai.ru](https://gakhk.khabkrai.ru) | ✅ |
| Архивы Чувашской Республики | [giachr.kaisa.ru](http://giachr.kaisa.ru) | ✅ |
| Государственный архив Сахалинской области | [giaso.ru](https://www.giaso.ru) | ✅ |
| Государственный архив Новгородской области | [gano.altsoft.spb.ru](http://gano.altsoft.spb.ru) | ✅ |
| Государственный архив Пермского края | [catalog.archive.perm.ru](http://catalog.archive.perm.ru) | ✅ |
| Государственный архив Красноярского края | [catalog.krasarh.ru](https://catalog.krasarh.ru) | ✅ |
| Государственный архив Орловской области | [catalog.gaorel.ru](https://catalog.gaorel.ru) | ✅ |
| Государственный архив Республики Тыва | [catalog.gosarhivrt.ru](https://catalog.gosarhivrt.ru) | ✅ |
| Красноярский городской архив | [mkukga.admkrsk.ru](https://mkukga.admkrsk.ru) | ✅ |
| Муниципальные архивы Красноярского края | [krasmun.krasarh.ru](https://krasmun.krasarh.ru) | ✅ |
| Архивы Алтайского края | [altarchives.ru](https://altarchives.ru) | ✅ |
| Архивы Ульяновской области | [ulian.kaisa.ru](https://ulian.kaisa.ru) | ✅ |

### VRR

| Архив | Ссылка | Примечание | ✅ |
|-------|--------|-----------|---|
| Государственный архив Костромской области | [kosarchive.ru](https://kosarchive.ru) | Прокрутите документ до конца | ✅ |
| Государственный архив Приморского края | [reading-room.arhiv-25.ru](https://reading-room.arhiv-25.ru) | Прокрутите документ до конца | ✅ |

### Специальные адаптеры

| Архив / Сервис | Ссылка | Тип | ✅ |
|--------------|--------|-----|---|
| Яндекс Архив | [ya.ru/archive](https://ya.ru/archive) · [yandex.ru/archive](https://yandex.ru/archive) | SPA + canvas | ✅ |
| ЦГА Москвы / МНА | [cgamos.ru](https://cgamos.ru) · [mos-nha.ru](https://mos-nha.ru) | ЭЛАР + SPA-вьювер | ✅ |

---

## ⚙️ Технические детали

### Требования
- **Браузер**: Google Chrome 88+ или совместимый Chromium
- **Разрешения**: `downloads`, `activeTab`, `storage`, `notifications`

### Архитектура
```
├── manifest.json          # Конфигурация MV3
├── background.js          # Service Worker: загрузки, бейдж, уведомления
├── content-script.js      # Адаптеры архивов, скачивание, PDF
├── pdf-worker.js          # Web Worker: сборка PDF без лимита страниц
├── popup.html / popup.js  # Интерфейс попапа
├── options.html / options.js  # Настройки
└── options-archives.js    # Список архивов для страницы настроек
```

---

## ⚠️ Особенности отдельных архивов

- **VRR (Кострома, Приморье)** — прокрутите ленту миниатюр до конца перед скачиванием
- **Яндекс Архив** — откройте нужную страницу документа перед запуском
- **ЭЛАР-архивы** — первый запуск может занять несколько секунд (зондирование сетки тайлов)
- **Для работы расшрения требуется авторизация в большинстве архивов**