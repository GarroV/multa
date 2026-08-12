import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

/**
 * Сканирование QR чека камерой и из картинки (#107).
 *
 * Парсеры ФНС РФ и suf.purs.gov.rs были готовы и покрыты тестами, но содержимое QR человек
 * вставлял РУКАМИ в текстовое поле. Смысл QR-пути был ровно в обратном: чек попадает в приложение
 * за одно движение телефоном. Перепечатывать `t=20260812T1930&s=1234.56&fn=...` с бумажки никто в
 * реальной жизни не станет, а путь этот обязателен — он бесплатный, в отличие от vision.
 *
 * jsQR подгружается динамически: он нужен в момент сканирования, а не при каждом открытии
 * приложения, и в главный бандл ему попадать незачем.
 */

export type ScanState = 'idle' | 'starting' | 'scanning' | 'denied' | 'unsupported';

async function decodeImageData(data: ImageData): Promise<string | null> {
  const { default: jsQR } = await import('jsqr');
  return jsQR(data.data, data.width, data.height)?.data ?? null;
}

/** Кадр из video/картинки → пиксели. Канвас одноразовый: держать его между кадрами незачем. */
function pixelsOf(source: CanvasImageSource, width: number, height: number): ImageData | null {
  if (width === 0 || height === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

export interface QrScanner {
  readonly state: ScanState;
  /** Куда монтировать видоискатель. */
  readonly videoRef: MutableRefObject<HTMLVideoElement | null>;
  /** Включает камеру и ищет код в кадрах, пока не найдёт. */
  start: (onFound: (payload: string) => void) => Promise<void>;
  stop: () => void;
  /** Разбор кода с картинки — для снятого раньше фото или скриншота. */
  fromFile: (file: File) => Promise<string | null>;
}

export function useQrScanner(): QrScanner {
  const [state, setState] = useState<ScanState>('idle');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    // Камеру отпускаем немедленно: горящий индикатор после закрытия — это уже про доверие.
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    setState('idle');
  }, []);

  // Уход с экрана при живой камере — тот же случай: гасим, даже если «закрыть» никто не нажал.
  useEffect(() => stop, [stop]);

  const start = useCallback(
    async (onFound: (payload: string) => void) => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setState('unsupported');
        return;
      }
      setState('starting');
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // Задняя камера: чек лежит на столе, а не перед лицом.
          video: { facingMode: 'environment' },
        });
      } catch {
        setState('denied');
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stop();
        return;
      }
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play().catch(() => undefined);
      setState('scanning');

      const tick = () => {
        const el = videoRef.current;
        if (!el || !streamRef.current) return;
        const pixels = pixelsOf(el, el.videoWidth, el.videoHeight);
        if (pixels) {
          void decodeImageData(pixels).then((payload) => {
            if (!payload || !streamRef.current) return;
            stop();
            onFound(payload);
          });
        }
        frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    },
    [stop],
  );

  const fromFile = useCallback(async (file: File): Promise<string | null> => {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return null;
    const pixels = pixelsOf(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    return pixels ? await decodeImageData(pixels) : null;
  }, []);

  return { state, videoRef, start, stop, fromFile };
}
