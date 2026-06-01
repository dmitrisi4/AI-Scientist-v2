#!/usr/bin/env node
/**
 * Локальный мост для AI Component Loop — даёт демо работать БЕЗ API-ключа,
 * используя уже авторизованный Claude CLI (Claude Code).
 *
 * Браузер не может шеллить CLI напрямую, поэтому этот крошечный сервер:
 *   1. отдаёт статические файлы демо (тот же origin → без CORS);
 *   2. POST /api/llm    {system,user,model} → запускает `claude -p` → {text}
 *   3. POST /api/vision {prompt,image,model} → пишет PNG во временный файл,
 *      запускает `claude -p "...Read the image at <path>..."` (Read tool) → {text}
 *
 * Запуск:   node bridge.mjs        (затем открыть http://localhost:5173)
 * Зависимостей нет — только встроенные модули Node.
 * Сервер слушает ТОЛЬКО 127.0.0.1 и запускает claude с --allowedTools Read
 * (никаких записей/шелла), так что он может лишь читать временный скриншот.
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 5173;
const CLAUDE_TIMEOUT_MS = 180_000;

const MIME = { '.html': 'text/html', '.md': 'text/markdown', '.js': 'text/javascript', '.css': 'text/css' };

// --- Вызов claude CLI в headless-режиме ---
// ВАЖНО: запускаем из нейтральной tmp-директории, иначе claude подхватит
// контекст текущего проекта (CLAUDE.md, git-статус) и поведёт себя как
// агент Claude Code, а не как чистая генерация. allowRead для vision
// работает по абсолютному пути независимо от cwd.
function runClaude(prompt, { model = 'sonnet', allowRead = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--model', model];
    args.push('--allowedTools', allowRead ? 'Read' : ''); // text-режим: без инструментов
    execFile('claude', args, { cwd: tmpdir(), timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      try {
        const json = JSON.parse(stdout);
        if (json.is_error) return reject(new Error(json.result || 'claude returned an error'));
        resolve(json.result ?? '');
      } catch (e) {
        reject(new Error('Не удалось разобрать ответ claude: ' + stdout.slice(0, 200)));
      }
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 30 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    // --- API: генерация текста/кода ---
    if (req.method === 'POST' && req.url === '/api/llm') {
      const { system = '', user = '', model } = JSON.parse(await readBody(req));
      const prompt = system ? `${system}\n\n${user}` : user;
      const text = await runClaude(prompt, { model });
      return sendJson(res, 200, { text });
    }

    // --- API: vision-ревью скриншота ---
    if (req.method === 'POST' && req.url === '/api/vision') {
      const { prompt = '', image, model } = JSON.parse(await readBody(req));
      if (!image) return sendJson(res, 400, { error: 'no image' });
      const file = join(tmpdir(), `ai-loop-${randomUUID()}.png`);
      await writeFile(file, Buffer.from(image, 'base64'));
      try {
        const fullPrompt = `Read the image at ${file}\n\n${prompt}`;
        const text = await runClaude(fullPrompt, { model, allowRead: true });
        return sendJson(res, 200, { text });
      } finally {
        unlink(file).catch(() => {});
      }
    }

    // --- Статика (index.html, README.md) ---
    let path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    path = normalize(path).replace(/^(\.\.[/\\])+/, ''); // защита от path traversal
    const full = join(HERE, path);
    if (!full.startsWith(HERE)) { res.writeHead(403); return res.end('forbidden'); }
    try {
      const buf = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  AI Component Loop — мост запущен`);
  console.log(`  → откройте  http://localhost:${PORT}`);
  console.log(`  → провайдер: «Claude CLI (локальный мост)» — без ключа\n`);
});
