# Атрибуция фотографий в пресете «Модерация фото товаров»

Файлы `real_*.jpg` в `batch_photo_moderation.json` — реальные фотографии со
свободными лицензиями (источник — Wikimedia Commons). Синтетические
`photo_*.png` сгенерированы скриптом `_gen_image_presets.py` и лицензий не требуют.

| Файл | Фото | Автор | Лицензия |
|---|---|---|---|
| `real_dark.jpg` | «Dark Alley ^2 (Explored)» — тёмная ночная аллея | Franck Michel (Flickr) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| `real_landscape.jpg` | «Green Mountain Landscape (Unsplash)» — горный пейзаж | Unsplash (загружено на Commons как CC0) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `real_screen.jpg` | «Lines of code (Unsplash)» — фото экрана ноутбука с кодом | Artem Sapegin | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `real_signage_text.jpg` | «Storefront of NY Central Pharmacy» — вывеска аптеки | viola.bz (Flickr) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| `real_watch.jpg` | «Black Seiko watch close-up» — предметное фото часов | автор на Flickr | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |

Изображения даунскейлены (ширина ≤ 800 px) и встроены в JSON пресета как
data URL. При повторной генерации (`_gen_image_presets.py --with-real`)
замените исходники в `/tmp/real_photos/` на файлы с совместимой лицензией
и обновите эту таблицу.
