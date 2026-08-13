/**
 * Общая подготовка компонентных тестов (issue #17).
 *
 * `jest-dom` добавляет матчеры про смысл (`toBeInTheDocument`, `toHaveTextContent`), а не про
 * структуру: тест, написанный через них, читается как утверждение о поведении и не ломается от
 * перестановки узлов.
 *
 * Уборка после каждого теста — руками, потому что глобальные хуки vitest здесь выключены: без неё
 * отрисованные компоненты копятся в одном документе, и поиск по роли находит их сразу несколько.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
