import { Link } from '@tanstack/react-router';
import { useI18n } from '../lib/i18n.tsx';

/**
 * Лендинг (Спринт 6).
 *
 * До него у холодного посетителя не было точки входа вовсе: корень редиректил в приложение, а
 * незалогиненный видел форму регистрации. То есть первое, что продукт говорил человеку, было
 * «представься» — прежде чем объяснить, зачем он нужен.
 *
 * Страница намеренно не «продающая»: никакого героя-градиента и обещаний. Вместо этого — сама
 * механика продукта на его же языке. Главный экран Multa это плотная таблица чисел, и лендинг
 * показывает ровно её фрагмент: человек, которому это нужно, узнаёт свою задачу с первого взгляда,
 * а кому не нужно — сразу понимает, что мимо. Честнее для обеих сторон.
 *
 * Демо стоит первым действием, регистрация вторым: посмотреть без регистрации — обещание продукта,
 * и оно должно быть заметнее, чем просьба завести аккаунт.
 */
export function Landing() {
  const { t } = useI18n();

  return (
    <div className="landing">
      <header className="landing-head">
        <span className="topbar-brand">{t('brand.name')}</span>
        <Link className="act" to="/login">
          {t('landing.signIn')}
        </Link>
      </header>

      <main className="landing-main">
        <h1 className="landing-title">{t('landing.title')}</h1>
        <p className="landing-lead">{t('landing.lead')}</p>

        <div className="landing-cta">
          {/* Демо — главное действие: «посмотреть без регистрации» это обещание, а не уступка. */}
          <Link className="btn act-primary" to="/demo">
            {t('landing.demo')}
          </Link>
          <Link className="act" to="/login">
            {t('landing.start')}
          </Link>
        </div>
        <span className="sub dim">{t('landing.demoNote')}</span>

        {/*
          Фрагмент настоящего экрана вместо скриншота: числа те же, что показывает продукт, и
          верстаются той же дизайн-системой — картинка не разойдётся с приложением после правки.
        */}
        <section className="landing-demo" aria-label={t('landing.preview')}>
          <div className="landing-kpi">
            <span className="micro">{t('landing.kpi.perDay')}</span>
            <b className="landing-num">1 240 ₽</b>
            <span className="sub dim">{t('landing.kpi.left')}</span>
          </div>
          <ul className="landing-rows">
            {[
              { name: t('landing.row.rent'), value: '48 000 ₽', tag: t('landing.tag.due') },
              { name: t('landing.row.exchange'), value: '620 €', tag: t('landing.tag.fx') },
              { name: t('landing.row.food'), value: '18 400 / 24 000 ₽', tag: null },
              { name: t('landing.row.debt'), value: '9 000 ₽', tag: t('landing.tag.debt') },
            ].map((row) => (
              <li key={row.name}>
                <span>{row.name}</span>
                <span className="landing-row-num">
                  <span className="num">{row.value}</span>
                  {row.tag && <span className="micro dim">{row.tag}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing-points">
          {(['plan', 'fx', 'facts'] as const).map((key) => (
            <article key={key}>
              <h2 className="landing-point-title">{t(`landing.point.${key}.title`)}</h2>
              <p className="sub">{t(`landing.point.${key}.body`)}</p>
            </article>
          ))}
        </section>
      </main>

      <footer className="landing-foot">
        <span className="sub dim">{t('landing.foot')}</span>
      </footer>
    </div>
  );
}
