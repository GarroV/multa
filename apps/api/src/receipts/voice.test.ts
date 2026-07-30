import { describe, expect, it } from 'vitest';
import { decodeAudioDataUrl, MAX_AUDIO_BYTES } from './voice.ts';

describe('decodeAudioDataUrl — приём голосовой заметки', () => {
  it('вытаскивает mime и байты из data URL', () => {
    // «hi» в base64 = aGk=
    const r = decodeAudioDataUrl('data:audio/webm;codecs=opus;base64,aGk=');

    expect(r?.mime).toBe('audio/webm');
    expect(r?.bytes.byteLength).toBe(2);
    expect(r?.filename.endsWith('.webm')).toBe(true);
  });

  it('расширение выводится из mime — Whisper требует понятное имя файла', () => {
    expect(decodeAudioDataUrl('data:audio/mp4;base64,aGk=')?.filename).toBe('voice.mp4');
    expect(decodeAudioDataUrl('data:audio/mpeg;base64,aGk=')?.filename).toBe('voice.mp3');
    expect(decodeAudioDataUrl('data:audio/ogg;base64,aGk=')?.filename).toBe('voice.ogg');
    expect(decodeAudioDataUrl('data:audio/wav;base64,aGk=')?.filename).toBe('voice.wav');
  });

  it('не-аудио и мусор отвергаются', () => {
    expect(decodeAudioDataUrl('data:image/png;base64,aGk=')).toBeNull();
    expect(decodeAudioDataUrl('https://example.com/a.mp3')).toBeNull();
    expect(decodeAudioDataUrl('')).toBeNull();
  });

  it('битый base64 не роняет разбор', () => {
    expect(decodeAudioDataUrl('data:audio/webm;base64,!!!!')).toBeNull();
  });

  it('пустая запись отвергается: тратить платный вызов на тишину незачем', () => {
    expect(decodeAudioDataUrl('data:audio/webm;base64,')).toBeNull();
  });

  it('слишком большая запись отвергается до отправки — защита от случайного гигабайта', () => {
    const huge = 'A'.repeat(Math.ceil((MAX_AUDIO_BYTES + 1024) * 4 / 3));
    expect(decodeAudioDataUrl(`data:audio/webm;base64,${huge}`)).toBeNull();
  });

  it('неизвестный аудио-mime отвергается: Whisper его всё равно не примет', () => {
    expect(decodeAudioDataUrl('data:audio/flac;base64,aGk=')).toBeNull();
  });
});
