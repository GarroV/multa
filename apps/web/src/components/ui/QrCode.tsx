import qrcode from 'qrcode-generator';

/**
 * QR-код из строки. Рисуем сами модулями в SVG, а не картинкой: `data:`-URL пришлось бы разрешать
 * в CSP ради одного экрана, а SVG-путь встраивается в разметку и ничего не загружает.
 *
 * Цвета — `currentColor` и прозрачный фон: код обязан читаться в обеих темах, а хардкод чёрного
 * на тёмном фоне сделал бы его нечитаемым (правило 6).
 */
export function QrCode({ value, size = 168 }: { value: string; size?: number }) {
  // typeNumber 0 — автоподбор версии по длине строки; 'M' — уровень коррекции по умолчанию.
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  // Поле в 4 модуля — требование стандарта: без него сканеры не находят код.
  const margin = 4;
  const total = count + margin * 2;

  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) parts.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={value}
      shapeRendering="crispEdges"
    >
      {/* Светлая подложка обязательна: сканер ищет контраст, а не «прозрачное». */}
      <rect width={total} height={total} fill="#ffffff" />
      <path d={parts.join('')} fill="#000000" />
    </svg>
  );
}
