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

# Атрибуция фотографий в пресете «Возвраты: претензии с фото»

Файлы `claim_*.txt` в `batch_returns_claims.json` — текстовые претензии
(написаны для пресета), к каждой прикреплено 0–3 реальных фотографии с
Wikimedia Commons (поле `images`). Сгенерировано скриптом
`_gen_returns_preset.py` из `/tmp/returns_photos/`.

| Исходник (/tmp/returns_photos) | Фото | Автор | Лицензия | Файлы претензий |
|---|---|---|---|---|
| `box_intact.jpg` | «Colorblends wholesale flower bulbs cardboard box» — целая картонная коробка | Bob Jenkins (Flickr) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) ([страница](https://commons.wikimedia.org/wiki/File:Colorblends_wholesale_flower_bulbs_cardboard_box.jpg)) | `claim_01.txt` |
| `phone_cracked_wide.jpg` | «Broken Samsung Galaxy A7 (2018)» — треснувший корпус смартфона, общий вид | 01x07x2022000 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) ([страница](https://commons.wikimedia.org/wiki/File:Broken_Samsung_Galaxy_A7_(2018).JPG)) | `claim_01.txt` |
| `crack_closeup.jpg` | «MyPhone my27 front panel» — треснувший экран, крупный план | JGBlue1509 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ([страница](https://commons.wikimedia.org/wiki/File:MyPhone_my27_front_panel.jpg)) | `claim_01.txt` |
| `tshirt.jpg` | «Hanukkah t-shirt, printed in the Metallica font» — футболка | Theodore.shouse | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) ([страница](https://commons.wikimedia.org/wiki/File:Hanukkah_t-shirt,_printed_in_the_Metallica_font.jpg)) | `claim_02.txt` |
| `box_dented.jpg` | «Damaged fragile parcel delivered to doorstep» — помятая посылка | Meanwell Packaging | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) ([страница](https://commons.wikimedia.org/wiki/File:Damaged_fragile_parcel_delivered_to_doorstep.jpg)) | `claim_04.txt` |
| `product_headphones.jpg` | «Headphones on white background» — наушники, товар цел | Sprinno | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) ([страница](https://commons.wikimedia.org/wiki/File:Headphones_on_white_background.jpg)) | `claim_04.txt` |
| `watch_wide.jpg` | «Casio DATA BANK watch (edited)» — наручные часы, общий вид | cisnky (кроп: Pittigrilli) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) ([страница](https://commons.wikimedia.org/wiki/File:Casio_DATA_BANK_watch_(edited).jpg)) | `claim_05.txt` |
| `watch_closeup1.jpg` | «Kijkshop Ectron dual watch close-up» — часы крупным планом | Wickey | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) ([страница](https://commons.wikimedia.org/wiki/File:Kijkshop_Ectron_dual_watch_close-up.jpg)) | `claim_05.txt` |
| `watch_closeup2.jpg` | «Ice watch cropped» — часы с потёртостями корпуса | homard.net | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) ([страница](https://commons.wikimedia.org/wiki/File:Ice_watch_cropped.jpg)) | `claim_05.txt` |

Все фото даунскейлены (длинная сторона ≤ 500 px) и встроены в JSON как
data URL. При повторной генерации замените исходники в `/tmp/returns_photos/`
на файлы с совместимой лицензией и обновите эту таблицу.
