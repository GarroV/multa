#!/usr/bin/env node
/**
 * Полная проверка перед пушем — та же, что делал CI (issue #143).
 *
 * GitHub Actions с 20.08.2026 не запускается вовсе: job падает через три секунды с «recent account
 * payments have failed». Статус при этом «failure», то есть выглядит как обычное красное — и легко
 * приучиться считать его шумом. Фактически в main попадает всё, что угодно, без единой автоматической
 * проверки.
 *
 * Пока это не решено, проверку делаем сами, и не «по памяти прогнать три команды», а механизмом:
 * `pnpm verify` и pre-push хук, который её вызывает. Дисциплина ловит девять раз из десяти, а
 * подводит именно тогда, когда торопишься — то есть когда ошибка дороже всего.
 *
 * Шаги те же и в том же порядке, что в `.github/workflows/ci.yml`: формат дешевле типов, типы дешевле
 * тестов, браузерный прогон последний. Останавливаемся на первом падении: дальше всё равно чинить это.
 */
import { execSync, spawnSync } from 'node:child_process';

const STEPS = [
  { name: 'формат', cmd: 'pnpm format:check' },
  { name: 'типы', cmd: 'pnpm typecheck' },
  { name: 'тесты', cmd: 'pnpm test' },
  { name: 'прод-сборка', cmd: 'pnpm build' },
  { name: 'смоук бандла', cmd: 'pnpm --filter @multa/web test:bundle' },
  { name: 'браузерный прогон', cmd: 'pnpm --filter @multa/web test:e2e' },
];

/*
 * Fail-closed. Интеграционные тесты и E2E ходят в настоящий Postgres; без него они падают не
 * проверкой, а отсутствием базы — и «красное» перестаёт означать «код сломан». Лучше сказать прямо и
 * до начала, чем через четыре минуты в середине прогона.
 */
function postgresReady() {
  const probe = spawnSync('pg_isready', ['-q'], { stdio: 'ignore' });
  return probe.status === 0;
}

if (!postgresReady()) {
  console.error(
    [
      '',
      'Postgres не отвечает, а без него интеграционные тесты и браузерный прогон',
      'падают не проверкой, а отсутствием базы.',
      '',
      'Подними и повтори:  brew services start postgresql@16',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const started = Date.now();
for (const [i, step] of STEPS.entries()) {
  process.stdout.write(`\n── ${i + 1}/${STEPS.length} ${step.name} ─────────────────────\n`);
  try {
    execSync(step.cmd, { stdio: 'inherit' });
  } catch {
    console.error(
      [
        '',
        `Проверка остановлена на шаге «${step.name}».`,
        `Повторить только его:  ${step.cmd}`,
        '',
        'Если пуш всё же нужен (например, чинишь сломанный main из другой машины):',
        '  git push --no-verify',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

const mins = Math.round((Date.now() - started) / 60_000);
console.log(`\nВсё зелёное за ~${mins} мин. Можно пушить.\n`);
