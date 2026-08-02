import type { TourStep } from './Tour.tsx';

/**
 * Шаги тура по «Плану» (issue #28) — данные, а не разметка: новый блок дашборда добавляет сюда
 * строку и не трогает движок.
 *
 * Порядок повторяет то, как человек читает экран: сначала ответ («сколько можно тратить»), потом
 * откуда он взялся (раздача выплаты), потом то, чем этот ответ можно двигать (категории,
 * обязательства), и в конце — что впереди.
 *
 * Шаг, чьего блока на экране нет, тур пропускает сам: у человека без долгов панели долгов не будет,
 * и рассказывать про неё некому.
 */
export const PLAN_TOUR: readonly TourStep[] = [
  {
    id: 'hero',
    anchor: '.kpi-hero',
    title: 'tour.hero.title',
    body: 'tour.hero.body',
  },
  {
    id: 'cascade',
    anchor: '.kpi-cascade',
    title: 'tour.cascade.title',
    body: 'tour.cascade.body',
  },
  {
    id: 'map',
    anchor: '.pmap',
    title: 'tour.map.title',
    body: 'tour.map.body',
  },
  {
    id: 'categories',
    anchor: '[aria-label="Категории"], [aria-label="Categories"]',
    title: 'tour.categories.title',
    body: 'tour.categories.body',
  },
  {
    id: 'obligations',
    anchor: '.tab[href="/obligations"]',
    title: 'tour.obligations.title',
    body: 'tour.obligations.body',
  },
  {
    id: 'entry',
    anchor: '.topbar-right',
    title: 'tour.entry.title',
    body: 'tour.entry.body',
  },
];
