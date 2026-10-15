# Ассистент v2 — макеты виджетов чата

Макеты к концепции [assistant-v2-concept.md](assistant-v2-concept.md).
Базовый HTML с инлайн-стилями — рендерится прямо из MD в просмотрщиках
(VS Code preview, Typora, Obsidian). Состояния показаны статично; реальные
виджеты — интерактивные (hover, клики, сворачивание).

Общие принципы во всех макетах:

- карточка вместо простыни текста; текстовый вывод — 1–3 строки над/под ней;
- детали («почему», трейс шагов) — за сворачиваемыми блоками;
- упоминания вопросов/файлов/моделей — ссылки-подсветки в основном UI;
- вердикты: зелёный ✓ / красный ✗ / янтарный ?; никаких новых шкал;
- всё, что стоит ресурсов, — с оценкой времени диапазоном и scope-чипами.

---

## 0. Шапка панели: чип «что ассистент видит» (§7.3 концепции)

Снимает недоверие «бот не знает, что я смотрю». Обновляется при любом
изменении состояния. Клик → тултип со списком того, что вошло в снапшот
(и что обрезано).

<table style="border-collapse:collapse; width:340px; font:13px -apple-system, sans-serif;">
<tr><td style="border:1px solid #d8dce3; border-radius:10px 10px 0 0; padding:8px 10px; background:#f6f7f9;">
<b>✨ Ассистент</b> <span style="color:#8a8f98; font-size:11px;">qwen3-flash-next ☁</span>
<span style="float:right; color:#8a8f98;">⟳ Сброс</span>
</td></tr>
<tr><td style="border:1px solid #d8dce3; border-top:none; border-radius:0 0 10px 10px; padding:6px 10px; background:#fff;">
<span style="display:inline-block; background:#eef3fe; color:#2456c4; border-radius:10px; padding:2px 9px; font-size:11px;">
Пакет · 8 файлов · 2 модели · разметка 14 · результаты свежие</span>
</td></tr>
</table>

---

## 1. Карточка «Разбор прогона» (§4.1)

Частоты и группировку считает код; модель называет категории и причину.
Каждая категория — ссылка: клик подсвечивает ячейки в результатах.
«Рассуждение и шаги» — свернуто по умолчанию.

<table style="border-collapse:collapse; width:560px; font:13px -apple-system, sans-serif;">
<tr><td style="border:1px solid #d8dce3; border-radius:10px; padding:10px 12px; background:#fff;">

<div style="font-size:12px; color:#8a8f98;">Разбор прогона · пакет «интервью-Q3» · 8 файлов × 2 модели · по 14 пометкам</div>
<div style="font-weight:600; margin:4px 0 8px;">Нашёл 3 категории проблем — начните с первой, она даёт 60% ошибок</div>

<table style="border-collapse:collapse; width:100%; font-size:12.5px;">
<tr style="border-top:1px solid #eceff3;">
<td style="padding:6px 4px;"><span style="color:#c4320a; font-weight:700;">✗ 6</span></td>
<td style="padding:6px 4px;"><a href="#" style="color:#2456c4;">Порог «релевантность ≥ 70» режет пограничные score</a><br>
<span style="color:#8a8f98; font-size:11.5px;">в 6 случаях score 62–68 при ✗-разметке · вопрос <a href="#" style="color:#2456c4;">№4</a> · обе модели</span></td>
<td style="padding:6px 4px; text-align:right; white-space:nowrap;"><span style="background:#eef3fe; color:#2456c4; border-radius:9px; padding:2px 8px; font-size:11px;">предложить правку →</span></td>
</tr>
<tr style="border-top:1px solid #eceff3;">
<td style="padding:6px 4px;"><span style="color:#b54708; font-weight:700;">⚡ 4</span></td>
<td style="padding:6px 4px;"><a href="#" style="color:#2456c4;">Модели расходятся на вопросе №2 «тональность»</a><br>
<span style="color:#8a8f98; font-size:11.5px;">4 файла из 8 · уверенность обеих &lt;60% — формулировка двусмысленна</span></td>
<td style="padding:6px 4px; text-align:right;"><span style="background:#eef3fe; color:#2456c4; border-radius:9px; padding:2px 8px; font-size:11px;">разметить →</span></td>
</tr>
<tr style="border-top:1px solid #eceff3;">
<td style="padding:6px 4px;"><span style="color:#c4320a; font-weight:700;">✗ 2</span></td>
<td style="padding:6px 4px;"><a href="#" style="color:#2456c4;">Qwen игнорирует картинки в файлах 5 и 7</a><br>
<span style="color:#8a8f98; font-size:11.5px;">ваш комментарий: «ответ про скриншот, а он его не видел» · vision не включён в прогоне</span></td>
<td style="padding:6px 4px; text-align:right;"><span style="background:#eef3fe; color:#2456c4; border-radius:9px; padding:2px 8px; font-size:11px;">включить vision →</span></td>
</tr>
</table>

<div style="margin-top:8px; font-size:11.5px; color:#8a8f98;">▸ Почему я так решил (метрики и расчёты) &nbsp;&nbsp; ▸ Шаги и вызовы инструментов (4)</div>

</td></tr>
</table>

---

## 2. Карточка «Что разметить дальше» (§4.2)

Очередь по ценности метки. Клик по строке → скролл и подсветка ячейки.
Кнопка «размечено» убирает из очереди.

<table style="border-collapse:collapse; width:560px; font:13px -apple-system, sans-serif;">
<tr><td style="border:1px solid #d8dce3; border-radius:10px; padding:10px 12px; background:#fff;">

<div style="font-weight:600; margin-bottom:6px;">Самые информативные кандидаты на разметку <span style="color:#8a8f98; font-weight:400; font-size:11.5px;">— эти 5 меток изменят больше всего</span></div>

<table style="border-collapse:collapse; width:100%; font-size:12.5px;">
<tr><td style="padding:5px 4px; border-top:1px solid #eceff3;"><a href="#" style="color:#2456c4;">файл №3 · вопрос №2 · Qwen</a></td>
<td style="padding:5px 4px; border-top:1px solid #eceff3; color:#8a8f98; font-size:11.5px;">⚡ модели расходятся · score 68 при пороге 70</td>
<td style="padding:5px 4px; border-top:1px solid #eceff3; text-align:right;"><span style="color:#2456c4; font-size:11.5px;">разметить →</span></td></tr>
<tr><td style="padding:5px 4px; border-top:1px solid #eceff3;"><a href="#" style="color:#2456c4;">файл №7 · вопрос №4 · Laya</a></td>
<td style="padding:5px 4px; border-top:1px solid #eceff3; color:#8a8f98; font-size:11.5px;">уверенность 52% · вы раньше правили похожие</td>
<td style="padding:5px 4px; border-top:1px solid #eceff3; text-align:right;"><span style="color:#2456c4; font-size:11.5px;">разметить →</span></td></tr>
<tr><td style="padding:5px 4px; border-top:1px solid #eceff3;"><a href="#" style="color:#2456c4;">файл №1 · решение · обе модели</a></td>
<td style="padding:5px 4px; border-top:1px solid #eceff3; color:#8a8f98; font-size:11.5px;">исход сработал с запасом &lt;5% по двум условиям</td>
<td style="padding:5px 4px; border-top:1px solid #eceff3; text-align:right;"><span style="color:#2456c4; font-size:11.5px;">разметить →</span></td></tr>
</table>

<div style="margin-top:6px; font-size:11.5px; color:#8a8f98;">ещё 7 кандидатов · <a href="#" style="color:#2456c4;">показать все</a> &nbsp;·&nbsp; или: <span style="background:#eef3fe; color:#2456c4; border-radius:9px; padding:2px 8px; font-size:11px;">✨ предразметь сам — я проверю</span></div>

</td></tr>
</table>

---

## 3. Предразметка от ассистента (§4.3, suggestions)

Предложенные метки: пунктирная кромка + ✨ — визуально отличимы от ручных.
Подтверждённые становятся полноценным ground truth.

<table style="border-collapse:collapse; width:560px; font:13px -apple-system, sans-serif;">
<tr><td style="border:1px solid #d8dce3; border-radius:10px; padding:10px 12px; background:#fff;">

<div style="font-weight:600; margin-bottom:6px;">Предразметила 5 кандидатов <span style="color:#8a8f98; font-weight:400; font-size:11.5px;">— проверьте, подтверждённые станут вашей разметкой</span></div>

<table style="border-collapse:collapse; width:100%; font-size:12.5px;">
<tr>
<td style="padding:5px 4px; border-top:1px solid #eceff3; width:24px;"><span style="border:1.5px dashed #c4320a; color:#c4320a; border-radius:6px; padding:0 5px; font-weight:700;">✗</span></td>
<td style="padding:5px 4px; border-top:1px solid #eceff3;"><a href="#" style="color:#2456c4;">файл №3 · вопрос №2 · Qwen</a><br><span style="color:#8a8f98; font-size:11.5px;">✨ «модель засчитала оффтоп-абзац как релевантный — вы такие помечали ✗»</span></td>
<td style="padding:5px 4px; border-top:1px solid #eceff3; text-align:right; white-space:nowrap; font-size:11.5px;"><span style="color:#067647;">✓ принять</span> · <span style="color:#8a8f98;">отклонить</span></td>
</tr>
<tr>
<td style="padding:5px 4px; border-top:1px solid #eceff3;"><span style="border:1.5px dashed #067647; color:#067647; border-radius:6px; padding:0 5px; font-weight:700;">✓</span></td>
<td style="padding:5px 4px; border-top:1px solid #eceff3;"><a href="#" style="color:#2456c4;">файл №7 · вопрос №4 · Laya</a><br><span style="color:#8a8f98; font-size:11.5px;">✨ «ответ совпал с эталоном из файла №2, обе модели согласны»</span></td>
<td style="padding:5px 4px; border-top:1px solid #eceff3; text-align:right; white-space:nowrap; font-size:11.5px;"><span style="color:#067647;">✓ принять</span> · <span style="color:#8a8f98;">отклонить</span></td>
</tr>
</table>

<div style="margin-top:6px; font-size:11.5px; color:#8a8f98;">ещё 3 · <a href="#" style="color:#2456c4;">показать</a> &nbsp;·&nbsp; <span style="color:#2456c4;">принять все 5</span> <span style="color:#b42318;">(не рекомендую: 2 из 5 я сама сомневаюсь)</span></div>

</td></tr>
</table>

---

## 4. Карточка правки правила с дельтой (§5.2 дешёвая, §5.4)

**Без прогона моделей** — пересчёт исходов из уже полученных ответов.
Показывает измеренный эффект, а не убедительный текст.

<table style="border-collapse:collapse; width:560px; font:13px -apple-system, sans-serif;">
<tr><td style="border:1px solid #d8dce3; border-radius:10px; padding:10px 12px; background:#fff;">

<div style="font-size:12px; color:#8a8f98;">Предложение · правила решения · проверено на размеченных мгновенно</div>
<div style="font-weight:600; margin:4px 0 8px;">Порог «релевантность»: 70 → 65 — уберёт 5 из 6 ошибок категории «пограничные»</div>

<table style="border-collapse:collapse; width:100%; font-size:12.5px; margin-bottom:8px;">
<tr style="color:#8a8f98; font-size:11px; text-align:left;">
<th style="padding:3px 6px; font-weight:400;">исход «отклонить»</th><th style="padding:3px 6px; font-weight:400;">было</th><th style="padding:3px 6px; font-weight:400;">станет</th></tr>
<tr><td style="padding:3px 6px;">условие</td>
<td style="padding:3px 6px; color:#8a8f98;"><s>вопрос №4 ≥ 70</s></td>
<td style="padding:3px 6px; font-weight:600;">вопрос №4 ≥ 65</td></tr>
</table>

<div style="background:#f6f7f9; border-radius:8px; padding:7px 10px; font-size:12.5px;">
На 14 размеченных ячейках: <b>ошибок 6 → 1</b> &nbsp; <span style="color:#067647;">✗→✓ 5</span> · <span style="color:#c4320a;">✓→✗ 0</span> · <a href="#" style="color:#2456c4;">показать ячейки</a><br>
<span style="font-size:11.5px; color:#8a8f98;">⚠ выборка 14 ячеек — эффект ±1 ошибка шума; после применения стоит перепрогнать и доразметить</span>
</div>

<div style="margin-top:8px; font-size:12.5px;">
<span style="background:#2456c4; color:#fff; border-radius:7px; padding:4px 12px;">Принять</span>
<span style="border:1px solid #d8dce3; border-radius:7px; padding:3px 11px; margin-left:6px;">Отклонить</span>
<span style="border:1px solid #d8dce3; border-radius:7px; padding:3px 11px; margin-left:6px;">Изменить порог…</span>
</div>

</td></tr>
</table>

Состояние «после принятия»: кнопки заменяются строкой
`✓ Применено · [Отменить]` (один undo на карточку).

---

## 5. Пакет «План исправления» (§5.1, bundle)

Секции принимаются независимо; «Отменить» откатывает все принятые секции
пакета разом.

<table style="border-collapse:collapse; width:560px; font:13px -apple-system, sans-serif;">
<tr><td style="border:1px solid #d8dce3; border-radius:10px; padding:10px 12px; background:#fff;">

<div style="font-size:12px; color:#8a8f98;">План исправления · 3 секции · дельта посчитана на размеченных</div>
<div style="font-weight:600; margin:4px 0 8px;">Починить «пограничные» и двусмысленную «тональность»: ошибок 6 → 1</div>

<div style="border:1px solid #e4e7ec; border-radius:8px; padding:7px 10px; margin-bottom:6px;">
<b style="font-size:12.5px;">1. Правило: порог 70 → 65</b> <span style="color:#067647; font-size:11.5px;">✗→✓ 5</span><br>
<span style="font-size:11.5px; color:#8a8f98;">вопрос №4 · было→станет · проверено на 14 ячейках</span><br>
<span style="font-size:11.5px;"><span style="color:#2456c4;">принять</span> · <span style="color:#8a8f98;">отклонить</span></span>
</div>

<div style="border:1px solid #e4e7ec; border-radius:8px; padding:7px 10px; margin-bottom:6px;">
<b style="font-size:12.5px;">2. Вопрос №2: переформулировать «тональность»</b> <span style="color:#8a8f98; font-size:11.5px;">требует прогона</span><br>
<span style="font-size:11.5px; color:#8a8f98;">было: «Положительная ли тональность?» → станет: «Есть ли в тексте негатив к продукту (жалобы, разочарование)?» · <a href="#" style="color:#2456c4;">полный diff</a></span><br>
<span style="font-size:11.5px;"><span style="color:#2456c4;">принять</span> · <span style="color:#8a8f98;">отклонить</span> · <span style="color:#2456c4;">сначала what-if (≈1 мин)</span></span>
</div>

<div style="border:1px solid #e4e7ec; border-radius:8px; padding:7px 10px;">
<b style="font-size:12.5px;">3. Прогон для проверки: 8 файлов × 2 модели ≈ 3–6 мин</b><br>
<span style="font-size:11.5px; color:#8a8f98;">запустится после применения принятых секций · scope: <span style="background:#eef3fe; color:#2456c4; border-radius:8px; padding:1px 7px;">только размеченные файлы (−60% времени)</span></span><br>
<span style="font-size:11.5px;"><span style="color:#2456c4;">включить в план</span> · <span style="color:#8a8f98;">не надо</span></span>
</div>

<div style="margin-top:8px; font-size:12.5px;">
<span style="background:#2456c4; color:#fff; border-radius:7px; padding:4px 12px;">Применить выбранное (2)</span>
<span style="border:1px solid #d8dce3; border-radius:7px; padding:3px 11px; margin-left:6px;">Отклонить всё</span>
</div>

</td></tr>
</table>

---

## 6. Карточка-план длинного действия (§6, гейт)

Единственный случай, когда ассистент спрашивает разрешения на прогон.
Оценка — диапазоном, scope-чипы удешевляют.

<table style="border-collapse:collapse; width:560px; font:13px -apple-system, sans-serif;">
<tr><td style="border:1px solid #fdb022; border-radius:10px; padding:10px 12px; background:#fffcf5;">

<div style="font-weight:600; margin-bottom:4px;">⏱ Длинная задача — нужно разрешение</div>
<div style="font-size:12.5px; margin-bottom:6px;">Проверить гипотезу «другая модель лучше читает скриншоты»: прогон 8 файлов на Qwen-VL, сравнение с текущими результатами.</div>
<div style="font-size:12.5px; margin-bottom:8px;">≈ <b>4–9 минут</b> (по метрикам прошлых прогонов) · модель не запущена — запущу сама, потом остановлю<br>
scope: <span style="background:#fff; border:1px solid #d8dce3; border-radius:8px; padding:1px 8px; font-size:11.5px;">✓ только файлы 5 и 7 (−75% времени)</span> <span style="background:#fff; border:1px solid #d8dce3; border-radius:8px; padding:1px 8px; font-size:11.5px;">все 8 файлов</span></div>
<div style="font-size:12.5px;">
<span style="background:#2456c4; color:#fff; border-radius:7px; padding:4px 12px;">Запустить</span>
<span style="border:1px solid #d8dce3; background:#fff; border-radius:7px; padding:3px 11px; margin-left:6px;">Не сейчас</span>
</div>

</td></tr>
</table>

Во время выполнения карточка превращается в прогресс:
`Шаг 2/4: прогон файла 5… ▮▮▮▯▯ · [Прервать]` — и по завершении сворачивается
в строку-итог со ссылкой на результат.

---

## 7. Карточка запуска модели (§6.1)

Обёртка над существующим менеджером моделей; всегда с апрувом.

<table style="border-collapse:collapse; width:560px; font:13px -apple-system, sans-serif;">
<tr><td style="border:1px solid #d8dce3; border-radius:10px; padding:10px 12px; background:#fff;">
<div style="font-weight:600; margin-bottom:4px;">Запустить Qwen3.5-27B?</div>
<div style="font-size:12.5px; color:#555; margin-bottom:8px;">≈ 9 ГБ RAM · свободно 22 ГБ · запуск 1–2 мин, остановлю после сравнения</div>
<div style="font-size:12.5px;">
<span style="background:#2456c4; color:#fff; border-radius:7px; padding:4px 12px;">Запустить</span>
<span style="border:1px solid #d8dce3; border-radius:7px; padding:3px 11px; margin-left:6px;">Не надо</span>
</div>
<div style="font-size:11.5px; color:#8a8f98; margin-top:6px;">на Windows недоступно — там покажу инструкцию для ручного запуска</div>
</td></tr>
</table>

---

## 8. Quick-chips после ответа (§7.2)

Контекстные, меняются от состояния страницы. Показан набор «есть результаты
и разметка» (самый богатый).

<div style="font:13px -apple-system, sans-serif; width:560px;">
<span style="display:inline-block; border:1px solid #d8dce3; border-radius:14px; padding:4px 11px; font-size:12px; margin:2px;">🔍 Разобрать прогон</span>
<span style="display:inline-block; border:1px solid #d8dce3; border-radius:14px; padding:4px 11px; font-size:12px; margin:2px;">✎ Что разметить дальше (5)</span>
<span style="display:inline-block; border:1px solid #d8dce3; border-radius:14px; padding:4px 11px; font-size:12px; margin:2px;">⚖ Сравнить модели</span>
<span style="display:inline-block; border:1px solid #d8dce3; border-radius:14px; padding:4px 11px; font-size:12px; margin:2px;">🎚 Подобрать пороги</span>
</div>

Другие состояния: пустой проект — «Сгенерируй вопросы по материалу» /
«Помоги с правилами»; результаты без разметки — «Что разметить (10)» /
«✨ Предразметь сам».

---

## 9. Три слоя раскрытия ответа (§7.1)

Как выглядит один и тот же ответ на трёх уровнях:

<table style="border-collapse:collapse; width:560px; font:13px -apple-system, sans-serif;">
<tr><td style="border:1px solid #d8dce3; border-radius:10px; padding:10px 12px; background:#fff; font-size:12.5px;">
<b>Слой 1 — всегда виден:</b> вывод в 1–3 строки + карточка действия (макеты выше).<br>
<span style="color:#8a8f98;">«Основная проблема — порог релевантности, он даёт 60% ошибок. Предлагаю правку, эффект измерен на вашей разметке:»</span><br>
<br>
<b>Слой 2 — по клику:</b> <span style="color:#2456c4;">▾ Почему я так решил</span> — таблица метрик: trace условий, распределения score, частоты ✗ по категориям (то, что посчитал код).<br>
<br>
<b>Слой 3 — для аудита:</b> <span style="color:#2456c4;">▸ Шаги (4)</span> — вызовы инструментов, сырой трейс, время каждого шага.
</td></tr>
</table>

---

## Что смотреть при оценке

- Достаточно ли наглядна дельта «было → стало» (макет 4) — это главный
  аргумент при принятии решения.
- Не перегружен ли пакет (макет 5) тремя секциями — альтернатива: секции
  сворачиваются по умолчанию.
- Удобно ли, что гейт-действия (макет 6) жёлтые — отличаются от обычных
  предложений.
- Понятно ли отличие suggestions (макет 3, пунктир) от ручной разметки.
- Нужна ли строка «ещё N кандидатов» в макетах 2–3 или лучше сразу
  полный список.
