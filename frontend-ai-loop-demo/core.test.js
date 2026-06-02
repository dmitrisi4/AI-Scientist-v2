'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./core.js');

const {
  escapeHtml, bestNode, buildSrcdoc, extractCode, parseReviewJson,
  mockGenerate, mockReview, MOCK_BUGGY, MOCK_FIXED, MOCK_NICE,
  MOCK_VUE_NICE, MOCK_VANILLA_NICE,
} = core;

test('escapeHtml экранирует & < > и не падает на null/undefined', () => {
  assert.equal(escapeHtml('<div class="a" & b>'), '&lt;div class="a" &amp; b&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), ''); // String(0||'') === ''
});

test('extractCode вырезает код из markdown-блока с разными языками', () => {
  assert.equal(extractCode('```jsx\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(extractCode('бла\n```html\n<b>hi</b>\n```\nбла'), '<b>hi</b>');
  assert.equal(extractCode('```\nplain\n```'), 'plain');
});

test('extractCode без markdown возвращает обрезанный текст', () => {
  assert.equal(extractCode('  const a = 1;  '), 'const a = 1;');
  assert.equal(extractCode(''), '');
  assert.equal(extractCode(null), '');
});

test('parseReviewJson разбирает валидный JSON, в т.ч. внутри текста', () => {
  assert.deepEqual(
    parseReviewJson('{"score":8,"summary":"ок","issues":["a","b"]}'),
    { score: 8, summary: 'ок', issues: ['a', 'b'] },
  );
  // JSON, обёрнутый текстом — берём первый {...}
  assert.deepEqual(
    parseReviewJson('Вот мой ответ: {"score":3,"summary":"плохо","issues":[]} конец'),
    { score: 3, summary: 'плохо', issues: [] },
  );
});

test('parseReviewJson подставляет дефолты для отсутствующих полей', () => {
  assert.deepEqual(parseReviewJson('{}'), { score: 5, summary: '', issues: [] });
  // score 0 / нечисловой → 5 (через `+o.score || 5`)
  assert.equal(parseReviewJson('{"score":0}').score, 5);
});

test('parseReviewJson на мусоре отдаёт устойчивый fallback', () => {
  const r = parseReviewJson('совсем не json');
  assert.equal(r.score, 5);
  assert.deepEqual(r.issues, []);
  assert.match(r.summary, /Не удалось распарсить/);
});

test('bestNode: пустой/без подходящих узлов → null', () => {
  assert.equal(bestNode([]), null);
  assert.equal(bestNode(undefined), null);
  // есть ok, но без review — не считается
  assert.equal(bestNode([{ status: 'ok' }]), null);
  // есть review, но статус error — не считается
  assert.equal(bestNode([{ status: 'error', review: { score: 10 } }]), null);
});

test('bestNode выбирает узел с максимальным score среди ok+review', () => {
  const a = { id: 'a', status: 'ok', review: { score: 6 } };
  const b = { id: 'b', status: 'ok', review: { score: 9 } };
  const c = { id: 'c', status: 'error', review: { score: 10 } }; // игнор
  assert.equal(bestNode([a, b, c]).id, 'b');
});

test('buildSrcdoc(react) подключает React/Babel и рендерит App', () => {
  const html = buildSrcdoc('function App(){return null}', 'react');
  assert.match(html, /react\.production\.min\.js/);
  assert.match(html, /@babel\/standalone/);
  assert.match(html, /type="text\/babel"/);
  assert.match(html, /ReactDOM\.createRoot/);
  assert.match(html, /function App\(\)\{return null\}/);
  // проброс ошибок наверх
  assert.match(html, /postMessage\(\{type:'error'/);
});

test('buildSrcdoc(vue) подключает Vue и монтирует App', () => {
  const html = buildSrcdoc('const App={template:`<i/>`}', 'vue');
  assert.match(html, /vue\.global\.prod\.js/);
  assert.match(html, /Vue\.createApp\(App\)\.mount\('#root'\)/);
  assert.ok(!html.includes('@babel/standalone'), 'во vue не должно быть babel');
});

test('buildSrcdoc(vanilla) вставляет HTML-фрагмент как есть, без фреймворков', () => {
  const html = buildSrcdoc('<button>Hi</button>', 'vanilla');
  assert.match(html, /<button>Hi<\/button>/);
  assert.ok(!html.includes('react'), 'vanilla без react');
  assert.ok(!html.includes('vue.global'), 'vanilla без vue');
  // ready-пинг всё равно есть
  assert.match(html, /type:'ready'/);
});

test('mockGenerate(react): стадия определяется по тексту запроса', () => {
  assert.match(mockGenerate('Задача: ... Сделай простую версию', 'react'), /BUG: price не объявлен/); // draft → buggy
  assert.ok(mockGenerate('... Ошибка при рендере: ReferenceError', 'react').includes(MOCK_FIXED)); // debug → fixed
  assert.ok(mockGenerate('... Замечания ревьюера: добавь тень', 'react').includes(MOCK_NICE)); // improve → nice
});

test('mockGenerate(vue|vanilla) сразу отдаёт готовый сниппет', () => {
  assert.ok(mockGenerate('что угодно', 'vue').includes(MOCK_VUE_NICE));
  assert.ok(mockGenerate('что угодно', 'vanilla').includes(MOCK_VANILLA_NICE));
});

test('mockReview: "плоский" код → 6 с замечаниями, аккуратный → 9 без', () => {
  const flat = mockReview({ code: MOCK_FIXED });
  assert.equal(flat.score, 6);
  assert.ok(flat.issues.length > 0);

  // эвристика padding:8 тоже срабатывает на 6
  assert.equal(mockReview({ code: 'div { padding: 8px }' }).score, 6);

  const nice = mockReview({ code: MOCK_NICE });
  assert.equal(nice.score, 9);
  assert.deepEqual(nice.issues, []);
});

test('mock-петля целиком: draft(buggy) → debug(fixed,6) → improve(nice,9)', () => {
  // draft
  const draftCode = extractCode(mockGenerate('Сделай простую версию', 'react'));
  assert.ok(draftCode.includes('{price}'), 'draft содержит баг с price');
  // debug (узел упал — генерируем по ключевому слову "Ошибка при рендере")
  const debugCode = extractCode(mockGenerate('Ошибка при рендере: price is not defined', 'react'));
  assert.equal(mockReview({ code: debugCode }).score, 6);
  // improve
  const improveCode = extractCode(mockGenerate('Замечания ревьюера: добавь тень', 'react'));
  assert.equal(mockReview({ code: improveCode }).score, 9);
});
