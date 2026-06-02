/**
 * Чистая (без DOM) логика AI Component Loop — единый источник правды для
 * браузера и тестов.
 *
 * UMD-обёртка: в браузере подключается обычным <script src="core.js"> и кладёт
 * API в window.AILoopCore (работает даже с file://, в отличие от ES-модулей);
 * в Node доступен через require('./core.js') — это позволяет писать юнит-тесты
 * на встроенном node:test без сборки и зависимостей.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AILoopCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Экранирование для вставки в HTML ---
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  // --- Выбор лучшего узла (аналог get_best_node): максимальный score среди ok+review ---
  function bestNode(journal) {
    const good = (journal || []).filter(n => n.status === 'ok' && n.review);
    if (!good.length) return null;
    return good.reduce((a, b) => (b.review.score > a.review.score ? b : a));
  }

  // --- Сборка srcdoc песочницы под выбранный фреймворк ---
  // Чистая функция: ошибки рендера и таймаут сообщаются наверх через postMessage.
  function buildSrcdoc(code, framework) {
    const head = `<style>body{margin:0;font-family:system-ui,sans-serif;padding:16px}</style>
    <script>window.onerror=(m)=>parent.postMessage({type:'error',error:String(m)},'*');<\/script>`;
    const okPing = `requestAnimationFrame(()=>parent.postMessage({type:'ready'},'*'));`;

    if (framework === 'vue') {
      return `<!doctype html><html><head>
      <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"><\/script>${head}</head><body>
      <div id="root"></div>
      <script>
        try { ${code}
          Vue.createApp(App).mount('#root'); ${okPing}
        } catch(e){ parent.postMessage({type:'error',error:String(e&&e.stack||e)},'*'); }
      <\/script></body></html>`;
    }
    if (framework === 'vanilla') {
      // code = готовый HTML-фрагмент с inline <style>/<script>
      return `<!doctype html><html><head>${head}</head><body>
      ${code}
      <script>${okPing}<\/script></body></html>`;
    }
    // react (по умолчанию)
    return `<!doctype html><html><head>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>${head}</head><body>
    <div id="root"></div>
    <script type="text/babel" data-presets="react">
      try { ${code}
        ReactDOM.createRoot(document.getElementById('root')).render(<App/>); ${okPing}
      } catch (e) { parent.postMessage({type:'error', error:String(e && e.stack || e)}, '*'); }
    <\/script></body></html>`;
  }

  // --- Вырезание кода из markdown-ответа LLM (```...```), иначе сырой текст ---
  function extractCode(text) {
    const m = String(text || '').match(/```(?:jsx?|tsx?|javascript|html|vue|xml)?\s*([\s\S]*?)```/i);
    return (m ? m[1] : String(text || '')).trim();
  }

  // --- Парсинг JSON-ревью с устойчивым fallback ---
  function parseReviewJson(text) {
    try {
      const m = String(text).match(/\{[\s\S]*\}/);
      const o = JSON.parse(m ? m[0] : text);
      return { score: +o.score || 5, summary: o.summary || '', issues: o.issues || [] };
    } catch {
      return { score: 5, summary: 'Не удалось распарсить ответ ревьюера: ' + String(text).slice(0, 120), issues: [] };
    }
  }

  /* --- MOCK-режим: детерминированная петля draft→debug→improve без сети --- */
  const MOCK_VUE_NICE = `const App = {
  setup() { return { price: (1990).toLocaleString('ru') }; },
  template: \`
    <div style="width:240px;border:1px solid #eee;border-radius:12px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.1)">
      <div style="height:140px;background:linear-gradient(135deg,#a5b4fc,#818cf8)"></div>
      <div style="padding:16px">
        <h3 style="margin:0 0 4px">Беспроводные наушники</h3>
        <div style="font-size:20px;font-weight:700;margin:8px 0 12px">{{ price }} ₽</div>
        <button style="width:100%;padding:10px 0;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer">В корзину</button>
      </div>
    </div>\`
};`;

  const MOCK_VANILLA_NICE = `<div style="width:240px;border:1px solid #eee;border-radius:12px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.1);font-family:system-ui">
  <div style="height:140px;background:linear-gradient(135deg,#a5b4fc,#818cf8)"></div>
  <div style="padding:16px">
    <h3 style="margin:0 0 4px">Беспроводные наушники</h3>
    <div style="font-size:20px;font-weight:700;margin:8px 0 12px">1 990 ₽</div>
    <button style="width:100%;padding:10px 0;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer">В корзину</button>
  </div>
</div>`;

  const MOCK_BUGGY = `function App() {
  return (
    <div style={{ border: '1px solid #ddd', padding: 8 }}>
      <div style={{ background:'#eee', height: 120 }} />
      <h3>Товар</h3>
      <p>{price} ₽</p>  {/* BUG: price не объявлен → ReferenceError */}
      <button>В корзину</button>
    </div>
  );
}`;

  const MOCK_FIXED = `function App() {
  const price = 1990;
  return (
    <div style={{ border: '1px solid #ddd', padding: 8 }}>
      <div style={{ background:'#eee', height: 120 }} />
      <h3>Товар</h3>
      <p>{price} ₽</p>
      <button>В корзину</button>
    </div>
  );
}`;

  const MOCK_NICE = `function App() {
  const price = 1990;
  return (
    <div style={{
      width: 240, border: '1px solid #eee', borderRadius: 12, overflow: 'hidden',
      boxShadow: '0 6px 24px rgba(0,0,0,.10)', fontFamily: 'system-ui'
    }}>
      <div style={{ background: 'linear-gradient(135deg,#a5b4fc,#818cf8)', height: 140 }} />
      <div style={{ padding: 16 }}>
        <h3 style={{ margin: '0 0 4px' }}>Беспроводные наушники</h3>
        <div style={{ fontSize: 20, fontWeight: 700, margin: '8px 0 12px' }}>{price.toLocaleString('ru')} ₽</div>
        <button style={{
          width: '100%', padding: '10px 0', border: 0, borderRadius: 8,
          background: '#4f46e5', color: '#fff', fontWeight: 600, cursor: 'pointer'
        }}>В корзину</button>
      </div>
    </div>
  );
}`;

  // Генерация mock-ответа под фреймворк и стадию (определяется по тексту запроса).
  function mockGenerate(userMsg, framework) {
    // Полноценная история draft→debug→improve есть только для React.
    // Для Vue/Vanilla mock сразу отдаёт готовый аккуратный сниппет (score 9).
    if (framework === 'vue') return '```\n' + MOCK_VUE_NICE + '\n```';
    if (framework === 'vanilla') return '```html\n' + MOCK_VANILLA_NICE + '\n```';

    const isDebug = /Ошибка при рендере/.test(userMsg);
    const isImprove = /Замечания ревьюера/.test(userMsg);
    if (isDebug) return '```jsx\n' + MOCK_FIXED + '\n```';
    if (isImprove) return '```jsx\n' + MOCK_NICE + '\n```';
    // первый draft — со специально внесённой ошибкой (price не определён)
    return '```jsx\n' + MOCK_BUGGY + '\n```';
  }

  // Mock-ревью: «починенная, но плоская» версия → 6, иначе аккуратная → 9.
  function mockReview(node) {
    if (node.code === MOCK_FIXED || /padding:\s*8/.test(node.code)) {
      return {
        score: 6, summary: 'Работает, но выглядит плоско: нет тени, скромные отступы, кнопка невзрачная.',
        issues: ['Добавить тень и скругление', 'Увеличить отступы', 'Сделать кнопку заметной'],
      };
    }
    return { score: 9, summary: 'Аккуратная карточка: тень, скругления, акцентная кнопка. Хорошо решает задачу.', issues: [] };
  }

  return {
    escapeHtml, bestNode, buildSrcdoc, extractCode, parseReviewJson,
    mockGenerate, mockReview,
    MOCK_VUE_NICE, MOCK_VANILLA_NICE, MOCK_BUGGY, MOCK_FIXED, MOCK_NICE,
  };
});
