# AI Component Loop — фронтенд-демо паттернов AI-Scientist-v2

Минимальный самодостаточный прототип, переносящий ядровую идею **AI-Scientist-v2** в браузер:
итеративный агентный цикл **draft → исполнение в песочнице → vision-ревью → improve**,
с выбором лучшего результата.

Один файл, без сборки: `index.html`.

## Запуск

```bash
# из этой папки
npx serve .
# или
python -m http.server 8000
```

Откройте `http://localhost:8000`. Запускать через локальный сервер (не из `file://`),
иначе CORS заблокирует запросы к API.

### Режимы
- **Mock** (по умолчанию) — работает без ключей, детерминированно показывает всю петлю:
  draft со специально внесённой ошибкой → debug чинит → improve стилизует → «готово».
- **Anthropic / OpenAI** — вставьте свой API-ключ. Ключ остаётся в браузере и уходит
  только в API провайдера. На каждой итерации генерируется реальный компонент,
  снимается скриншот (`html2canvas`) и vision-модель его оценивает.

## Соответствие модулям оригинального проекта

| Демо (`index.html`) | AI-Scientist-v2 |
|---|---|
| `Node` / `journal[]` | `journal.py` (`Node`, `Journal`) |
| `genDraft` / `genDebug` / `genImprove` | `parallel_agent.py:453-523` (`_draft`/`_debug`/`_improve`) |
| `runInSandbox` (iframe + таймаут + postMessage) | `interpreter.py` (отдельный процесс, SIGINT→kill, очереди) |
| `visionReview` (html2canvas + vision-LLM) | `parallel_agent.py:894` (`_analyze_plots_with_vlm`) |
| `bestNode()` | `journal.py:420` (`get_best_node`) |
| `loop()` (стадии/итерации) | `agent_manager.py` (стадии) + воркеры `parallel_agent.py` |
| `callLLM` / `callVisionLLM` | `llm.py` / `vlm.py` (единая обёртка над провайдерами) |

## Ключевые идеи, перенесённые из проекта

1. **Изоляция исполнения.** Сгенерированный код запускается только в sandboxed `iframe`
   с жёстким таймаутом — никогда `eval()` в основном потоке. Это прямой аналог
   запуска кода в отдельном процессе в `interpreter.py`.
2. **Не один ответ, а дерево попыток.** Если рендер падает — узел `debug`; если работает —
   узел `improve`. Прогресс и провалы сохраняются в `journal`.
3. **Vision как сигнал качества.** Модель «смотрит» на скриншот и возвращает score+замечания,
   которые идут в следующий шаг `improve`.
4. **Structured output.** Ревью возвращается строгим JSON `{score, summary, issues}` —
   как function-calling схемы в проекте.

## Замечания по безопасности

- `iframe` использует `sandbox="allow-scripts allow-same-origin"`. `allow-same-origin`
  нужен только чтобы `html2canvas` снял скриншот содержимого. В продакшене лучше
  снимать скриншот на сервере (Playwright), а песочницу держать строже
  (`allow-scripts` без `allow-same-origin`).
- Это учебное демо. Не исполняйте произвольный недоверенный код без изоляции.
