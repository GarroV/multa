import { useCallback, useRef, useState } from 'react';

/**
 * Запись короткой диктовки с микрофона (#107).
 *
 * Ручка `/transactions/voice` жила с самого начала и была покрыта тестами, но кнопки к ней не
 * было: во фронте не существовало ни записи, ни хука. Ручка оплачивалась и не приносила пользы.
 *
 * Хук намеренно не знает, что делать с записью, — он отдаёт data-URL и на этом заканчивается.
 * Отправка, разбор и раскладка по полям формы живут в компоненте ввода, где уже есть тот же путь
 * для текстовой фразы: два разных места для «понял так» неизбежно разъехались бы.
 */

export type VoiceState = 'idle' | 'recording' | 'encoding' | 'denied' | 'unsupported';

/** Потолок диктовки. Фраза «кофе 250 продукты» — секунды; минута уже означает, что забыли выключить. */
const MAX_MS = 60_000;

export interface VoiceCapture {
  readonly state: VoiceState;
  /** Начинает запись; спрашивает разрешение при первом вызове. */
  start: () => Promise<void>;
  /** Останавливает запись и отдаёт data-URL, либо null, если писать было нечего. */
  stop: () => Promise<string | null>;
}

export function useVoiceCapture(): VoiceCapture {
  const [state, setState] = useState<VoiceState>('idle');
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState('unsupported');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
      rec.start();
      recorder.current = rec;
      setState('recording');
      // Страховка от забытой записи: сам себя не остановит ни вкладка в фоне, ни ушедший человек.
      timer.current = setTimeout(() => rec.state === 'recording' && rec.stop(), MAX_MS);
    } catch {
      // Отказ в доступе — не сбой: человек мог нажать «запретить» осознанно, и сказать надо об этом.
      setState('denied');
    }
  }, []);

  const stop = useCallback(async (): Promise<string | null> => {
    const rec = recorder.current;
    if (!rec) return null;
    if (timer.current) clearTimeout(timer.current);
    setState('encoding');

    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' }));
      if (rec.state === 'recording') rec.stop();
      else resolve(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' }));
    });
    // Микрофон отпускаем сразу: индикатор записи в браузере не должен гореть после нажатия «стоп».
    for (const track of rec.stream.getTracks()) track.stop();
    recorder.current = null;
    setState('idle');

    if (blob.size === 0) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.readAsDataURL(blob);
    });
  }, []);

  return { state, start, stop };
}
