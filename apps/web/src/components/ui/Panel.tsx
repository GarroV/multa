import type { ReactNode } from 'react';

/**
 * Панель — единица содержания плотной раскладки (прототип, issue #30): цветная засечка,
 * caps-лейбл, сумма периода и инструменты справа. Засечка кодирует роль раздела, а не украшает:
 * cyan — деньги на жизнь, mag — риск и долги, vio — другая валюта, lime — доход и накопление,
 * amber — внимание.
 */

export type Accent = 'cyan' | 'mag' | 'vio' | 'lime' | 'amber';

interface PanelProps {
  label: string;
  /**
   * Имя роли панели. Нужно телефону: там панели выстраиваются по важности (сначала картинки,
   * потом ведомости), и порядок задаётся в CSS по этим именам, а не второй разметкой под мобильный.
   */
  slot?: string;
  /** Сумма раздела за период — вторая строка заголовка, всегда в колонке моно. */
  sum?: string;
  accent?: Accent;
  tools?: ReactNode;
  children: ReactNode;
  /** Строка под содержимым: «добавить», подсказка, итог. */
  foot?: ReactNode;
}

export function Panel({ label, sum, accent = 'cyan', tools, children, foot, slot }: PanelProps) {
  return (
    <section className={slot ? `panel panel-${slot}` : 'panel'} aria-label={label}>
      <header className="panel-head">
        <span className={`panel-mark ${accent}`} aria-hidden />
        <span className="panel-name">{label}</span>
        {sum && <span className="panel-sum">{sum}</span>}
        {tools && <span className="panel-tools">{tools}</span>}
      </header>
      <div className="panel-body">{children}</div>
      {foot && <div className="panel-foot">{foot}</div>}
    </section>
  );
}

interface TagProps {
  tone?: Accent | 'quiet';
  children: ReactNode;
}

/** Метка состояния: читается, но не нажимается — для действий есть `.act`. */
export function Tag({ tone = 'quiet', children }: TagProps) {
  return <span className={tone === 'quiet' ? 'tag' : `tag ${tone}`}>{children}</span>;
}

interface BarProps {
  /** Доля заполнения, проценты. Значения вне 0–100 обрезаются: полоса не вылезает за трек. */
  share: number;
  tone?: Accent;
  label?: string;
}

export function Bar({ share, tone = 'cyan', label }: BarProps) {
  const width = Math.min(100, Math.max(0, share));
  return (
    <div className={tone === 'cyan' ? 'bar' : `bar ${tone}`} role="img" aria-label={label}>
      <i style={{ ['--w' as string]: `${width}%` }} />
    </div>
  );
}
