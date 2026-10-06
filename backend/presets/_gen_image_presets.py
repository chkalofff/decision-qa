"""Генерация пресетов с изображениями (этап 4).

PIL в окружении нет — картинки рисуются чистым stdlib: RGB-буфер → PNG
(struct + zlib), текст — встроенным bitmap-шрифтом 5x7 (цифры, знаки, часть
латиницы — хватает для вотермарка-телефона и подписей).

Запуск из корня проекта:
    .venv-test/bin/python backend/presets/_gen_image_presets.py [--with-real]

Перезаписывает ugc_post_moderation.json и batch_photo_moderation.json
рядом со скриптом.

--with-real: добавляет в batch_photo_moderation.json после 5 синтетических
PNG до 5 реальных JPEG из /tmp/real_photos/real_*.jpg (уже даунскейленных),
встраивая их как data:image/jpeg;base64 data URL.
"""

from __future__ import annotations

import base64
import json
import math
import struct
import sys
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent
REAL_DIR = Path("/tmp/real_photos")
W, H = 400, 300

# ---------------------------------------------------------------- bitmap-шрифт 5x7

FONT = {
    " ": ["00000"] * 7,
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    "+": ["00000", "00100", "00100", "01110", "00100", "00100", "00000"],
    "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
    ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
    ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
    "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
}


# ---------------------------------------------------------------- холст

class Canvas:
    def __init__(self, w=W, h=H, bg=(255, 255, 255)):
        self.w, self.h = w, h
        self.px = bytearray(bg * (w * h))

    def set(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            i = (y * self.w + x) * 3
            self.px[i:i + 3] = bytes(color)

    def rect(self, x0, y0, x1, y1, color):
        for y in range(max(0, y0), min(self.h, y1)):
            for x in range(max(0, x0), min(self.w, x1)):
                self.set(x, y, color)

    def circle(self, cx, cy, r, color, fill=True, width=3):
        for y in range(cy - r - 1, cy + r + 2):
            for x in range(cx - r - 1, cx + r + 2):
                d = math.hypot(x - cx, y - cy)
                if (fill and d <= r) or (not fill and abs(d - r) <= width / 2):
                    self.set(x, y, color)

    def line(self, x0, y0, x1, y1, color, width=3):
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        for i in range(steps + 1):
            t = i / steps
            x, y = round(x0 + (x1 - x0) * t), round(y0 + (y1 - y0) * t)
            self.rect(x - width // 2, y - width // 2,
                      x + width // 2 + 1, y + width // 2 + 1, color)

    def text(self, x, y, s, color, scale=3):
        cx = x
        for ch in s.upper():
            glyph = FONT.get(ch, FONT[" "])
            for gy, row in enumerate(glyph):
                for gx, bit in enumerate(row):
                    if bit == "1":
                        self.rect(cx + gx * scale, y + gy * scale,
                                  cx + (gx + 1) * scale, y + (gy + 1) * scale, color)
            cx += 6 * scale

    def dim(self, factor):
        for i in range(len(self.px)):
            self.px[i] = int(self.px[i] * factor)

    def to_png(self) -> bytes:
        raw = b"".join(b"\x00" + bytes(self.px[y * self.w * 3:(y + 1) * self.w * 3])
                       for y in range(self.h))
        def chunk(tag, data):
            return (struct.pack(">I", len(data)) + tag + data +
                    struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
        return (b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9))
                + chunk(b"IEND", b""))

    def data_url(self) -> str:
        return "data:image/png;base64," + base64.b64encode(self.to_png()).decode()


# ---------------------------------------------------------------- сцены

def scene_bicycle(watermark: bool) -> Canvas:
    """«Фото товара»: велосипед на фоне неба и травы; опционально вотермарк."""
    c = Canvas(bg=(188, 224, 245))                    # небо
    c.rect(0, 210, W, H, (96, 172, 96))               # трава
    c.circle(330, 50, 28, (250, 225, 90))             # солнце
    frame, tire = (40, 90, 160), (30, 30, 30)
    c.circle(120, 190, 42, tire, fill=False, width=6)  # колёса
    c.circle(280, 190, 42, tire, fill=False, width=6)
    c.line(120, 190, 190, 130, frame, 5)               # рама
    c.line(190, 130, 280, 190, frame, 5)
    c.line(120, 190, 205, 190, frame, 5)
    c.line(205, 190, 190, 130, frame, 5)
    c.line(205, 190, 280, 190, frame, 5)
    c.line(190, 130, 182, 112, tire, 5)                # седло
    c.line(168, 112, 196, 112, tire, 5)
    c.line(280, 190, 266, 118, frame, 5)               # руль
    c.line(266, 118, 292, 108, tire, 5)
    if watermark:
        c.rect(0, 258, W, 292, (250, 235, 120))        # жёлтая плашка
        c.rect(0, 258, W, 261, (200, 60, 40))
        c.text(52, 266, "+7 900 123-45-67", (200, 60, 40), scale=3)
    return c


def scene_screenshot() -> Canvas:
    """Скриншот переписки/объявления: белый фон, «браузерная» рамка, текст."""
    c = Canvas(bg=(255, 255, 255))
    c.rect(0, 0, W, 26, (224, 228, 234))               # верхняя панель
    c.circle(14, 13, 5, (235, 95, 85))
    c.circle(32, 13, 5, (245, 190, 80))
    c.circle(50, 13, 5, (100, 200, 90))
    c.rect(70, 6, 380, 20, (255, 255, 255))
    c.text(20, 48, "SALE", (30, 30, 30), scale=5)
    c.text(20, 100, "+7 900 123-45-67", (60, 90, 170), scale=3)
    for i, wln in enumerate((340, 360, 300, 355, 250)):  # строки «текста»
        c.rect(20, 150 + i * 24, 20 + wln, 160 + i * 24, (205, 210, 218))
    for y in range(H):                     # рамка в 1px по периметру
        for x in range(W):
            if x in (0, W - 1) or y in (0, H - 1):
                c.set(x, y, (120, 120, 120))
    return c


def scene_not_product() -> Canvas:
    """Не товар: абстрактный смайл на градиентном фоне."""
    c = Canvas(bg=(255, 255, 255))
    for y in range(H):                                 # вертикальный градиент
        t = y / H
        color = (int(250 - 120 * t), int(200 - 60 * t), int(120 + 100 * t))
        c.rect(0, y, W, y + 1, color)
    c.circle(200, 140, 80, (255, 225, 120))            # лицо
    c.circle(172, 120, 10, (60, 40, 20))               # глаза
    c.circle(228, 120, 10, (60, 40, 20))
    for i in range(41):                                # улыбка — дуга
        a = math.pi * (0.15 + 0.7 * i / 40)
        x = round(200 + 52 * math.cos(a))
        y = round(130 + 52 * math.sin(a))
        c.rect(x - 2, y - 2, x + 3, y + 3, (60, 40, 20))
    return c


# ---------------------------------------------------------------- пресеты

UGC_INPUT = (
    "ПРОДАМ ВЕЛОСИПЕД!!! 🚲🔥🔥 Stels Navigator, почти НОВЫЙ, катался 1 сезон!! "
    "Смотрите ФОТО, там всё видно 📸 Цена 15000, ТОРГ уместен 💰💰 ЗВОНИТЕ, "
    "номер на фото 📞📞 Отправлю Авито-доставкой 🚚 ПИШИТЕ В ЛС!!! 😎"
)

PRESET_A_QUESTIONS = [
    {"id": "topic", "type": "choice",
     "question": "Тематика объявления?",
     "options": [
         {"name": "Продажа товара", "description": "Объявление о продаже конкретной вещи."},
         {"name": "Услуга", "description": "Предложение услуги, а не товара."},
         {"name": "Знакомства", "description": "Пост про знакомства/общение."},
         {"name": "Другое", "description": "Ничего из перечисленного."}]},
    {"id": "contacts_on_image", "type": "yes_no",
     "question": "Есть ли на изображении наложенная надпись или плашка с текстом (вотермарк, номер телефона)?",
     "yes": "На изображение наложена полоса или плашка с напечатанным текстом — например, номером телефона.",
     "no": "Изображение чистое, без наложенного текста."},
    {"id": "spam_signs", "type": "yes_no",
     "question": "Есть ли в тексте признаки спама?",
     "yes": "КАПС, повторы эмодзи, давление «звоните/пишите», навязчивые призывы — несколько признаков сразу.",
     "no": "Текст написан спокойно, без капса и навязчивых призывов."},
    {"id": "needs_edit", "type": "yes_no",
     "question": "Нужна ли редактура текста перед публикацией?",
     "yes": "Текст стоит привести к нейтральному виду: убрать капс, лишние эмодзи и повторы.",
     "no": "Текст в порядке, редактура не требуется."},
    {"id": "image_quality", "type": "score",
     "question": "Качество изображения для карточки товара?",
     "direction": "up",
     "levels": ["Не годится", "Слабое", "Среднее", "Хорошее", "Отличное"]},
    {"id": "image_matches_text", "type": "yes_no",
     "question": "Показан ли на изображении товар из текста объявления?",
     "yes": "На картинке изображён тот тип товара, который продаётся в тексте (велосипед), даже если картинка схематичная.",
     "no": "На картинке другой предмет или товара нет вовсе."},
    {"id": "decision", "type": "choice",
     "question": "Решение модерации?",
     "options": [
         {"name": "Одобрить", "description": "Нарушений нет, публикуем как есть."},
         {"name": "Отправить на редактуру", "description": "Публикуемо после правок текста или фото (вотермарк, капс)."},
         {"name": "Отклонить", "description": "Грубое нарушение правил, публиковать нельзя."}]},
]

PRESET_B_QUESTIONS = [
    {"id": "product_in_frame", "type": "yes_no",
     "question": "Есть ли товар в кадре?",
     "yes": "На изображении отчётливо виден товар (вещь, которую продают).",
     "no": "Товара в кадре нет — абстракция, пейзаж, скриншот и т.п."},
    {"id": "watermark", "type": "yes_no",
     "question": "Есть ли на изображении надписи: вотермарк, контакты, вывеска или текст?",
     "yes": "Виден вотермарк, номер телефона, ссылка, логотип, вывеска с названием или читаемый текст (в том числе на экране).",
     "no": "Изображение чистое, без надписей, текста и вотермарков."},
    {"id": "photo_quality", "type": "score",
     "question": "Техническое качество фото (свет, читаемость)?",
     "direction": "up",
     "levels": ["Не годится", "Слабое", "Среднее", "Хорошее", "Отличное"]},
    {"id": "main_photo_ok", "type": "yes_no",
     "question": "Подходит ли изображение для главного фото объявления?",
     "yes": "Товар виден, фото светлое и чистое — можно ставить главным.",
     "no": "Есть дефект (темно, вотермарк, скриншот, нет товара) — главным не ставить."},
    {"id": "defect", "type": "choice",
     "question": "Категория основного дефекта?",
     "options": [
         {"name": "Нет дефекта", "description": "Обычное фото товара: товар виден, нормальная яркость, без надписей."},
         {"name": "Вотермарк или контакты", "description": "На фото надписи: телефон, ссылка, водяной знак."},
         {"name": "Слишком тёмное", "description": "Фото сильно недоэкспонировано, товар не разглядеть."},
         {"name": "Скриншот, а не фото", "description": "Снимок экрана или фотография экрана монитора/телефона: видны строки текста, элементы интерфейса, кнопки, панели окон."},
         {"name": "На изображении не товар", "description": "В кадре пейзаж, люди, животное или абстракция — товара как предмета продажи нет."}]},
]


def jpeg_data_url(path: Path) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode()


def main() -> None:
    with_real = "--with-real" in sys.argv[1:]
    photo_ok = scene_bicycle(watermark=False)
    photo_wm = scene_bicycle(watermark=True)
    dark = scene_bicycle(watermark=False)
    dark.dim(0.14)
    screenshot = scene_screenshot()
    not_product = scene_not_product()

    preset_a = {
        "name": "UGC-модерация поста",
        "description": "Объявление + фото с вотермарком × тематика, контакты, спам (vision)",
        "page": "single",
        "input_format": "text",
        "input": UGC_INPUT,
        "images": [photo_wm.data_url()],
        "questions": PRESET_A_QUESTIONS,
    }
    files = [
        {"name": "photo_ok.png", "image": photo_ok.data_url()},
        {"name": "photo_watermark.png", "image": photo_wm.data_url()},
        {"name": "photo_dark.png", "image": dark.data_url()},
        {"name": "photo_screenshot.png", "image": screenshot.data_url()},
        {"name": "photo_notitem.png", "image": not_product.data_url()},
    ]
    if with_real:
        real = sorted(REAL_DIR.glob("real_*.jpg"))
        if len(real) != 5:
            raise SystemExit(
                f"--with-real: ожидается ровно 5 файлов real_*.jpg в {REAL_DIR}, найдено {len(real)}")
        files += [{"name": p.name, "image": jpeg_data_url(p)} for p in real]
    preset_b = {
        "name": "Модерация фото товаров",
        "description": ("10 фото товаров × проверка главного фото: товар в кадре, вотермарк, качество, дефект (vision)" if with_real else
                        "5 фото × модерация главного фото: товар в кадре, вотермарк, качество, дефект (vision)"),
        "page": "batch",
        "questions": PRESET_B_QUESTIONS,
        "files": files,
    }
    for name, preset in (("ugc_post_moderation.json", preset_a),
                         ("batch_photo_moderation.json", preset_b)):
        path = OUT_DIR / name
        with open(path, "w", encoding="utf-8") as f:
            json.dump(preset, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"{name}: {path.stat().st_size / 1024:.1f} КБ")


if __name__ == "__main__":
    main()
