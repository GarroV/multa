/**
 * Окружение интеграционных тестов. Выполняется до импорта модулей приложения, потому что
 * `env.ts` разбирает process.env в момент импорта — задать переменные позже уже поздно.
 *
 * DATABASE_URL перезаписывается ЖЁСТКО, а не через `??=`: тесты чистят таблицы, и переменная,
 * случайно оставшаяся в шелле от дев-запуска, стёрла бы дев-данные. Своя база — только через
 * TEST_DATABASE_URL, у которой имя обязано заканчиваться на `_test` (проверка в global-setup).
 */

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://multa:multa_dev_password@localhost:5432/multa_test';
process.env.BETTER_AUTH_SECRET = 'integration_tests_secret_at_least_32_chars';
process.env.BETTER_AUTH_URL = 'http://localhost:3000';
process.env.WEB_ORIGIN = 'http://localhost:5173';
// Ключа OpenAI в тестах нет намеренно: платные пути обязаны честно отказывать, а не молчать.
delete process.env.OPENAI_API_KEY;
