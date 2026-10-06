// Белый список поддерживаемых форматов изображений.
// HEIC/HEIF/AVIF/TIFF/BMP не поддерживаются моделями и превью в браузере —
// такие файлы отклоняются заранее с понятным сообщением, а не падают в прогоне.

export const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
export const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif";

// true, если файл — изображение поддерживаемого формата: либо MIME из белого
// списка, либо (когда MIME пуст/неизвестен) расширение из списка.
export function isSupportedImageFile(file) {
  if (file.type) return SUPPORTED_IMAGE_TYPES.includes(file.type.toLowerCase());
  return IMAGE_EXT_RE.test(file.name || "");
}

// Человекочитаемое сообщение об отклонённых файлах; пустая строка, если все ок.
export function rejectedImagesMessage(rejected) {
  if (!rejected.length) return "";
  const names = rejected.map(f => f.name || "файл").join(", ");
  return `Пропущены файлы в неподдерживаемом формате: ${names}. Нужны PNG/JPEG/WebP/GIF — HEIC и другие форматы сконвертируйте в JPEG.`;
}
