const express  = require('express');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const { exec, spawn } = require('child_process');

// ─── Inicialización ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = require('socket.io')(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT       = 3000;
const MASTER_PIN = "1234";

// Matar procesos osascript huérfanos de sesiones anteriores
exec('pkill -f osascript', () => {});
exec('pkill -f "fab_"', () => {});

// ─── Auth ─────────────────────────────────────────────────────────
io.use((socket, next) => {
  if (socket.handshake.auth.token === MASTER_PIN) return next();
  console.warn(`[Motor] Acceso denegado: ${socket.handshake.address}`);
  return next(new Error("Acceso denegado: PIN incorrecto"));
});

// ─── Static ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'frontend_vps', 'public')));

// ─── Estados de la Fábrica ────────────────────────────────────────
const S = {
  IDLE:           'idle',
  GEMINI_WORKING: 'gemini_working',
  GEMINI_DONE:    'gemini_done',
  MANUS_WORKING:  'manus_working',
  MANUS_DONE:     'manus_done',
  CLAUDE_WORKING: 'claude_working',
  CLAUDE_DONE:    'claude_done',
  DEPLOYING:      'deploying',
  DONE:           'done'
};

// ─── Estado global de la fábrica ──────────────────────────────────
let fab = {
  state:          S.IDLE,
  idea:           '',
  geminiResult:   '',
  geminiConvUrl:  '',
  manusResult:    '',
  manusConvUrl:   '',
  claudeResult:   '',
  deployUrl:      '',
  monitor:        null,
  socket:         null,
  customAction:   null,
  projectId:      null,
  createdAt:      null
};

function resetFab() {
  if (fab.monitor) clearInterval(fab.monitor);
  const sock = fab.socket;
  fab = { state: S.IDLE, idea: '', geminiResult: '', geminiConvUrl: '',
          manusResult: '', manusConvUrl: '', claudeResult: '', deployUrl: '',
          monitor: null, socket: sock, customAction: null, projectId: null, createdAt: null };
}

// ─── Proyectos: guardar/cargar historial ──────────────────────────────────
const PROJECTS_FILE = path.join(process.env.HOME, 'orquestador', 'fab_projects.json');

function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
  } catch(e) {}
  return [];
}

function saveCurrentProject() {
  if (!fab.idea) return;
  if (!fab.projectId) { fab.projectId = `proj_${Date.now()}`; fab.createdAt = new Date().toISOString(); }
  const projects = loadProjects();
  const project = {
    id: fab.projectId, name: fab.idea.slice(0, 80),
    idea: fab.idea, createdAt: fab.createdAt, updatedAt: new Date().toISOString(),
    state: fab.state, geminiResult: fab.geminiResult, geminiConvUrl: fab.geminiConvUrl,
    manusResult: fab.manusResult, manusConvUrl: fab.manusConvUrl,
    claudeResult: fab.claudeResult, deployUrl: fab.deployUrl
  };
  const idx = projects.findIndex(p => p.id === fab.projectId);
  if (idx >= 0) projects[idx] = project; else projects.unshift(project);
  projects.splice(50); // max 50 projects
  try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf8'); } catch(e) {}
}

async function getCurrentTabUrl(urlFragment) {
  try {
    return await runScript(`
tell application "Safari"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "${urlFragment}" then return URL of t
    end repeat
  end repeat
end tell
return ""
    `);
  } catch(e) { return ''; }
}

// ─── Helpers de emisión ───────────────────────────────────────────
function emitState(state, message, data = {}) {
  fab.state = state;
  if (fab.socket) fab.socket.emit('fab:state', { state, message, data });
  console.log(`[Motor] ▶ ${state} — ${message}`);
  saveCurrentProject();
}

function emitProgress(message) {
  if (fab.socket) fab.socket.emit('fab:progress', { message });
  console.log(`[Motor] ⏳ ${message}`);
}

// ─── AppleScript: ejecutar archivo temporal ───────────────────────
function runScript(content) {
  return new Promise((resolve, reject) => {
    const tmp = `/tmp/fab_${Date.now()}_${Math.random().toString(36).slice(2)}.applescript`;
    fs.writeFileSync(tmp, content, 'utf8');
    exec(`osascript "${tmp}"`, { timeout: 15000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch(e) {}
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ─── AppleScript: ejecutar JS en una pestaña de Safari por URL ────
function runSafariJS(urlFragment, jsCode) {
  const jsTmp = `/tmp/fab_js_${Date.now()}.js`;
  fs.writeFileSync(jsTmp, jsCode, 'utf8');
  return runScript(`
set jsFile to "${jsTmp}"
set jsCode to read POSIX file jsFile
tell application "Safari"
  repeat with w in windows
    try
      repeat with t in tabs of w
        if URL of t contains "${urlFragment}" then
          set result to do JavaScript jsCode in t
          do shell script "rm -f " & quoted form of jsFile
          return result
        end if
      end repeat
    end try
  end repeat
end tell
do shell script "rm -f " & quoted form of jsFile
return ""
  `);
}

// ─── Cambiar a pestaña de Safari por URL ─────────────────────────
async function switchToTab(urlFragment) {
  await runScript(`
tell application "Safari"
  activate
  set found to false
  repeat with w in windows
    if found then exit repeat
    repeat with t in tabs of w
      if URL of t contains "${urlFragment}" then
        set current tab of w to t
        set index of w to 1
        set found to true
        exit repeat
      end if
    end repeat
  end repeat
end tell
delay 0.8
  `);
}

// ─── Inyectar texto: coordenadas exactas del input vía window.screenX/Y ──────
async function focusAndType(urlFragment, text) {
  console.log(`[Motor] focusAndType → "${text.slice(0, 80)}"`);

  // 1. Copiar texto al portapapeles
  await new Promise((resolve, reject) => {
    const proc = exec('pbcopy', (err) => err ? reject(err) : resolve());
    proc.stdin.write(text, 'utf8');
    proc.stdin.end();
  });
  console.log('[Motor] ✅ pbcopy ok');

  // 2. Activar Safari
  await runScript(`tell application "Safari"\n  activate\nend tell\ndelay 0.5`);

  // 3. Buscar input con múltiples selectores (Gemini usa contenteditable, Manus puede usar otros)
  const posResult = await runScript(`
tell application "Safari"
  set coords to do JavaScript "(function(){var ss=['[contenteditable=\\"true\\"]','textarea','[role=\\"textbox\\"]','[contenteditable]','[data-placeholder]','[class*=\\"editor\\"]','input[type=\\"text\\"]'];for(var i=0;i<ss.length;i++){var els=document.querySelectorAll(ss[i]);if(els.length){var el=els[els.length-1];var r=el.getBoundingClientRect();if(r.width>0&&r.height>0){var sx=Math.round(window.screenX+r.left+r.width/2);var sy=Math.round(window.screenY+r.top+r.height/2);return sx+'|'+sy;}}}return 'NOTFOUND';})()" in current tab of window 1
  return coords
end tell
  `);
  console.log(`[Motor] Posición input en pantalla: ${posResult}`);

  // Fallback: si no encontró el elemento, usar parte inferior central de la ventana
  let sx, sy;
  if (!posResult || posResult === 'NOTFOUND' || !posResult.includes('|')) {
    console.log('[Motor] ⚠️ Input no encontrado via JS, usando fallback por coordenadas de ventana');
    const winInfo = await runScript(`
tell application "System Events"
  tell process "Safari"
    set p to position of front window
    set s to size of front window
    return ((item 1 of p) + (item 1 of s) / 2) as integer & "|" & ((item 2 of p) + (item 2 of s) - 110) as integer
  end tell
end tell
    `);
    [sx, sy] = winInfo.split('|').map(Number);
  } else {
    [sx, sy] = posResult.split('|').map(Number);
  }

  // 4. Clic físico en las coordenadas exactas del input
  await runScript(`
tell application "System Events"
  tell process "Safari"
    click at {${sx}, ${sy}}
  end tell
end tell
  `);
  console.log(`[Motor] ✅ Clic en ${sx},${sy}`);

  await new Promise(r => setTimeout(r, 500));

  // 5. Seleccionar todo + pegar desde portapapeles
  await runScript(`
tell application "System Events"
  tell process "Safari"
    keystroke "a" using command down
    delay 0.3
    keystroke "v" using command down
    delay 0.8
  end tell
end tell
  `);
  console.log('[Motor] ✅ Pegado');

  // 6. Enter para enviar
  await runScript(`
tell application "System Events"
  tell process "Safari"
    key code 36
  end tell
end tell
  `);
  console.log('[Motor] ✅ Enter');
}

// ─────────────────────────────────────────────────────────────────
//  GEMINI
// ─────────────────────────────────────────────────────────────────
async function injectGemini(text) {
  await switchToTab('gemini.google.com');
  if (!fab.geminiConvUrl) {
    fab.geminiConvUrl = await getCurrentTabUrl('gemini.google.com');
    console.log(`[Motor] Gemini conv URL: ${fab.geminiConvUrl}`);
  }
  emitProgress('Gemini abierto, enviando prompt...');
  await focusAndType('gemini.google.com', text);
  emitProgress('Prompt enviado. Gemini está pensando...');
  startGeminiMonitor();
}

function startGeminiMonitor() {
  let lastLen = 0;
  let stable  = 0;
  const NEEDED = 4; // 4 × 2s = 8s estable sin cambios = listo

  if (fab.monitor) clearInterval(fab.monitor);

  fab.monitor = setInterval(async () => {
    try {
      const len = await runSafariJS('gemini.google.com', `
(function() {
  var sel = ['model-response','[data-message-author-role="model"]',
             '.response-content','message-content','.model-response-text'];
  for (var i = 0; i < sel.length; i++) {
    var els = document.querySelectorAll(sel[i]);
    if (els.length > 0) return els[els.length - 1].innerText.trim().length;
  }
  return 0;
})()
      `);
      const cur = parseInt(len) || 0;
      emitProgress(`Gemini escribiendo... (${cur} caracteres)`);

      if (cur > 80 && cur === lastLen) {
        stable++;
        if (stable >= NEEDED) {
          clearInterval(fab.monitor);
          fab.monitor = null;
          await captureGeminiResult();
        }
      } else {
        stable = 0;
        lastLen = cur;
      }
    } catch(e) { /* reintentar */ }
  }, 2000);
}

let captureLock = false;

async function captureGeminiResult() {
  if (captureLock) { emitProgress('Captura en curso, espera...'); return; }
  captureLock = true;
  try {
    if (fab.monitor) { clearInterval(fab.monitor); fab.monitor = null; }
    emitProgress('Ejecutando captura en Gemini...');

    // Llevar la ventana de Gemini al frente
    await switchToTab('gemini.google.com');
    await new Promise(r => setTimeout(r, 800));

    const result = await runScript(`
tell application "Safari"
  set r to do JavaScript "(function(){var s=['message-content','model-response','.model-response-text','[data-message-author-role=model]'];for(var i=0;i<s.length;i++){var els=document.querySelectorAll(s[i]);if(els.length){var t=els[els.length-1].innerText.trim();if(t.length>100)return t.slice(0,8000);}}return document.body.innerText.slice(0,8000);})()" in current tab of window 1
  return r
end tell
    `);

    console.log(`[Motor] Gemini capturado: ${(result||'').length} chars`);

    if (!result || result.trim().length < 10) {
      emitProgress('Captura vacía. Safari → Develop → Allow JavaScript from Apple Events');
      return;
    }

    fab.geminiResult = result;
    emitState(S.GEMINI_DONE, 'Gemini terminó. Revisa la respuesta y decide el siguiente paso.', { result });
  } catch(e) {
    console.error('[Motor] Error captureGeminiResult:', e.message);
    emitProgress('Error captura: ' + e.message);
  } finally {
    captureLock = false;
  }
}

// ─────────────────────────────────────────────────────────────────
//  MANUS
// ─────────────────────────────────────────────────────────────────
async function injectManus(text) {
  // Si hay una conversación guardada, navegar directamente a ella
  if (fab.manusConvUrl) {
    console.log(`[Motor] Navigando a conv Manus: ${fab.manusConvUrl}`);
    await runScript(`tell application "Safari"\n  open location "${fab.manusConvUrl}"\n  activate\nend tell\ndelay 1.5`);
  } else {
    await switchToTab('manus.im');
    fab.manusConvUrl = await getCurrentTabUrl('manus.im');
    console.log(`[Motor] Manus conv URL: ${fab.manusConvUrl}`);
  }
  emitProgress('Manus abierto, enviando prompt...');
  await focusAndType('manus.im', text);
  emitProgress('Prompt enviado. Manus construyendo...');
  startManusMonitor();
}

// ─── Leer lista de conversaciones de Manus desde su sidebar ──────────────────
async function getManusChats() {
  await switchToTab('manus.im');
  await new Promise(r => setTimeout(r, 800));
  const jsTmp = `/tmp/fab_manus_chats_${Date.now()}.js`;
  fs.writeFileSync(jsTmp, `
(function() {
  var found = [];
  var sel = ['a[href*="/share/"]','a[href*="/task/"]','a[href*="/conversation/"]',
             '[class*="task-item"]','[class*="session-item"]','[class*="conv-item"]',
             'nav a','[class*="sidebar"] a','[class*="history"] a'];
  for (var i = 0; i < sel.length; i++) {
    var els = document.querySelectorAll(sel[i]);
    if (els.length > 0) {
      Array.from(els).forEach(function(el) {
        var a = el.tagName === 'A' ? el : (el.querySelector('a') || el.closest('a'));
        var url = a ? a.href : '';
        var title = (el.innerText || '').trim().replace(/\\s+/g,' ').slice(0, 70);
        if (title && url && url.includes('manus') && !found.find(function(f){return f.url===url;})) {
          found.push({ title: title, url: url });
        }
      });
      if (found.length >= 3) break;
    }
  }
  return JSON.stringify(found.slice(0, 20));
})()
  `, 'utf8');
  const raw = await runScript(`
set jsFile to "${jsTmp}"
set jsCode to read POSIX file jsFile
tell application "Safari"
  set r to do JavaScript jsCode in current tab of window 1
  return r
end tell
do shell script "rm -f ${jsTmp}"
  `);
  try { return JSON.parse(raw || '[]'); } catch(e) { return []; }
}

function startManusMonitor() {
  let lastContent = '';
  let stable      = 0;
  const NEEDED    = 8; // 8 × 3s = 24s estable = listo (Manus tarda más)

  if (fab.monitor) clearInterval(fab.monitor);

  fab.monitor = setInterval(async () => {
    try {
      const content = await runSafariJS('manus.im', `
(function() {
  var done = document.querySelectorAll('[class*="complete"],[class*="finished"],[class*="success"],[class*="done"]');
  if (done.length) return 'DONE:' + done[0].innerText.trim().slice(0, 150);
  var act = document.querySelectorAll('[class*="agent"],[class*="task"],[class*="step"],[class*="action"],[class*="progress"],[class*="message"]');
  if (act.length) return act[act.length - 1].innerText.trim().slice(0, 200);
  return document.title;
})()
      `);

      emitProgress(`Manus: ${content.slice(0, 60)}...`);

      if (content.startsWith('DONE:')) {
        clearInterval(fab.monitor); fab.monitor = null;
        fab.manusResult = content.replace('DONE:', '');
        emitState(S.MANUS_DONE, 'Manus completó la tarea. ¿Qué hacemos ahora?', { result: fab.manusResult });
        return;
      }

      if (content.length > 10 && content === lastContent) {
        stable++;
        if (stable >= NEEDED) {
          clearInterval(fab.monitor); fab.monitor = null;
          fab.manusResult = content;
          emitState(S.MANUS_DONE, 'Manus completó la tarea. ¿Qué hacemos ahora?', { result: content });
        }
      } else {
        stable = 0;
        lastContent = content;
      }
    } catch(e) { /* reintentar */ }
  }, 3000);
}

async function captureManusResult() {
  try {
    if (fab.monitor) { clearInterval(fab.monitor); fab.monitor = null; }
    emitProgress('Ejecutando captura en Manus...');

    await switchToTab('manus.im');
    if (!fab.manusConvUrl) fab.manusConvUrl = await getCurrentTabUrl('manus.im');
    await new Promise(r => setTimeout(r, 800));

    const result = await runScript(`
tell application "Safari"
  set r to do JavaScript "(function(){var els=document.querySelectorAll('[class*=\\"message\\"],[class*=\\"agent\\"],[class*=\\"task\\"],[class*=\\"result\\"],[class*=\\"output\\"],[class*=\\"response\\"]');if(els.length){var t=els[els.length-1].innerText.trim();if(t.length>50)return t.slice(0,8000);}return document.body.innerText.slice(0,8000);})()" in current tab of window 1
  return r
end tell
    `);

    console.log(`[Motor] Manus capturado: ${(result||'').length} chars`);

    if (!result || result.trim().length < 10) {
      emitProgress('Captura vacía — intenta de nuevo');
      return;
    }

    fab.manusResult = result;
    emitState(S.MANUS_DONE, 'Manus terminó. Revisa la respuesta.', { result });
  } catch(e) {
    console.error('[Motor] Error captureManusResult:', e.message);
    emitProgress('Error captura Manus: ' + e.message);
  }
}

// ─── Contexto del VPS para Claude ────────────────────────────────────────────
const VPS_CONTEXT = `
---
## CONTEXTO VPS (leer antes de actuar)

- **VPS:** 82.223.44.29 (Ubuntu, Ionos)
- **Deploy:** push a GitHub main → GitHub Actions → Docker en VPS
- **Nginx:** único punto de entrada. Solo puertos 80/443 expuestos al exterior.
- **Puertos internos disponibles:** 8081, 8082, 8083, 8084, 8085, 8086

### Estructura obligatoria de cada proyecto
\`\`\`
proyecto/
├── .github/workflows/deploy.yml   ← CI/CD (copiar de orquestador y adaptar)
├── frontend_vps/
│   ├── Dockerfile
│   ├── docker-compose.yml         ← puerto debe ser uno de los disponibles
│   ├── nginx/default.conf
│   └── public/                    ← archivos estáticos o build del frontend
\`\`\`

### docker-compose.yml mínimo
\`\`\`yaml
version: "3.8"
services:
  web:
    build: .
    container_name: nombre-proyecto
    restart: unless-stopped
    ports:
      - "808X:80"
\`\`\`

### deploy.yml — pasos requeridos en el VPS
1. git clone/pull del repo en el VPS
2. cd frontend_vps && docker compose down && docker compose up -d --build
3. sudo tee /etc/nginx/sites-available/bridge con server_name 82.223.44.29 → proxy al puerto del proyecto
4. sudo nginx -t && sudo systemctl reload nginx

### Secrets requeridos en GitHub del proyecto
VPS_HOST, VPS_USER, VPS_SSH_KEY, VPS_PORT (copiar de repo orquestador)
---
`;

// ─────────────────────────────────────────────────────────────────
//  CLAUDE
// ─────────────────────────────────────────────────────────────────
async function injectClaude(instructions) {
  const instrFile = `/tmp/claude_task_${Date.now()}.md`;
  const shFile    = `/tmp/claude_run_${Date.now()}.sh`;

  fs.writeFileSync(instrFile, instructions + VPS_CONTEXT, 'utf8');

  // Shell script para lanzar Claude con auto-aceptación de permisos
  fs.writeFileSync(shFile, `#!/bin/bash
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  AI Factory -> Claude Code"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cat "${instrFile}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
TASK=$(cat "${instrFile}")
claude --dangerously-skip-permissions -p "$TASK"
`, 'utf8');

  await runScript(`
tell application "Terminal"
  activate
  do script "chmod +x ${shFile} && bash ${shFile}"
  set bounds of front window to {50, 50, 1400, 900}
end tell
  `);

  emitProgress('Claude iniciado (auto-aceptando permisos)...');
  startClaudeMonitor();
}

function startClaudeMonitor() {
  let checks = 0;
  if (fab.monitor) clearInterval(fab.monitor);

  fab.monitor = setInterval(async () => {
    checks++;
    emitProgress(`Claude trabajando... (${checks * 3}s)`);

    try {
      const content = await runScript(`
tell application "Terminal"
  get contents of selected tab of front window
end tell
      `);
      const lines   = content.split('\n');
      const lastLine = (lines[lines.length - 1] || lines[lines.length - 2] || '').trim();
      const isDone   = lastLine.endsWith('%') || lastLine.endsWith('$') || lastLine.endsWith('❯');

      if (checks > 5 && isDone) {
        clearInterval(fab.monitor); fab.monitor = null;
        fab.claudeResult = content.slice(-1500);
        emitState(S.CLAUDE_DONE, 'Claude terminó. ¿Desplegamos?', { content: fab.claudeResult });
      }
    } catch(e) { /* reintentar */ }
  }, 3000);
}

// ─────────────────────────────────────────────────────────────────
//  DEPLOY
// ─────────────────────────────────────────────────────────────────
function runDeploy() {
  emitState(S.DEPLOYING, 'Iniciando deploy automático...');
  exec(
    'cd ~/orquestador && git add -A && git commit -m "fab: deploy automático desde la fábrica IA" && git push origin main',
    (err, stdout, stderr) => {
      if (err) {
        emitProgress('Error en deploy: ' + (stderr || err.message));
        emitState(S.CLAUDE_DONE, 'Deploy falló. Intenta de nuevo.', { content: fab.claudeResult });
        return;
      }
      fab.deployUrl = 'http://82.223.44.29';
      emitState(S.DONE, '🚀 Deploy completado', { url: fab.deployUrl });
    }
  );
}

// ─────────────────────────────────────────────────────────────────
//  SOCKET.IO
// ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Motor Mac] ✅ Cliente conectado: ${socket.id}`);
  fab.socket = socket;

  // Sincronizar estado actual al conectar
  socket.emit('fab:state', { state: fab.state, message: 'Motor conectado. Listo para trabajar.', data: {} });
  socket.emit('fab:projects', loadProjects());

  // ── Iniciar con Gemini ────────────────────────────────────────
  socket.on('fab:idea', async ({ text } = {}) => {
    fab.socket = socket; // Siempre responder al socket que envió
    if (!text?.trim()) return;
    fab.idea = text.trim();
    emitState(S.GEMINI_WORKING, 'Enviando idea a Gemini...');
    try { await injectGemini(fab.idea); }
    catch(e) {
      emitProgress('Error Gemini: ' + e.message);
      emitState(S.IDLE, 'Error. Intenta de nuevo.');
    }
  });

  // ── Acciones del usuario ──────────────────────────────────────
  socket.on('fab:action', async ({ action, text } = {}) => {
    fab.socket = socket; // Siempre responder al socket que envió
    console.log(`[Motor] Action: ${action}${text ? ' | texto: ' + text.slice(0, 40) : ''}`);
    try {
      switch(action) {

        // ── Desde GEMINI_DONE ────────────────────────────────────
        case 'send_manus':
          emitState(S.MANUS_WORKING, 'Enviando a Manus...');
          await injectManus(fab.geminiResult || fab.idea);
          break;

        case 'send_manus_custom':
          if (!text?.trim()) return;
          fab.geminiResult = text.trim();
          emitState(S.MANUS_WORKING, 'Enviando a Manus...');
          await injectManus(fab.geminiResult);
          break;

        case 'send_claude':
          emitState(S.CLAUDE_WORKING, 'Enviando a Claude Code...');
          await injectClaude(fab.geminiResult || fab.idea);
          break;

        case 'refine_gemini':
          emitState(S.GEMINI_WORKING, 'Refinando con Gemini...');
          await injectGemini('Refina y mejora el prompt anterior. Hazlo más específico, técnico y listo para un agente de IA como Manus. Devuelve solo el prompt mejorado.');
          break;

        case 'custom_gemini':
          if (!text?.trim()) return;
          emitState(S.GEMINI_WORKING, 'Enviando a Gemini...');
          await injectGemini(text.trim());
          break;

        // ── Desde MANUS_DONE ─────────────────────────────────────
        case 'manus_to_claude':
          emitState(S.CLAUDE_WORKING, 'Enviando a Claude Code...');
          await injectClaude(
            `# Proyecto de Manus para revisar y desplegar\n\n` +
            `Manus generó el siguiente proyecto y lo subió a GitHub.\n` +
            `Aquí está el reporte/output de Manus:\n\n${fab.manusResult}\n\n` +
            `## Tu tarea\n` +
            `1. Extrae la URL del repositorio GitHub del texto anterior\n` +
            `2. Clona el repositorio localmente\n` +
            `3. Verifica que el código esté completo y compile\n` +
            `4. Verifica/crea Dockerfile, docker-compose.yml y deploy.yml siguiendo el contexto VPS al final\n` +
            `5. Si hiciste cambios, haz commit y push al repo\n` +
            `6. Confirma con: "✅ Proyecto listo. Repo: [url]. Puerto: [puerto]. Puedo desplegar cuando autorices."\n`
          );
          break;

        case 'manus_to_claude_custom':
          if (!text?.trim()) return;
          emitState(S.CLAUDE_WORKING, 'Enviando instrucciones a Claude...');
          await injectClaude(text.trim());
          break;

        case 'retry_manus':
          emitState(S.MANUS_WORKING, 'Reintentando con Manus...');
          await injectManus(fab.geminiResult || fab.idea);
          break;

        case 'otro_manus':
          if (!text?.trim()) return;
          emitState(S.MANUS_WORKING, 'Enviando mensaje a Manus...');
          await injectManus(text.trim());
          break;

        case 'list_manus_chats':
          emitProgress('Leyendo conversaciones de Manus...');
          const chats = await getManusChats();
          console.log(`[Motor] Manus chats: ${chats.length}`);
          if (fab.socket) fab.socket.emit('fab:manus_chats', chats);
          break;

        case 'select_manus_conv':
          if (!text?.trim()) return;
          fab.manusConvUrl = text.trim();
          saveCurrentProject();
          emitProgress(`Conversación de Manus vinculada: ${fab.manusConvUrl}`);
          break;

        case 'deploy_from_manus':
          runDeploy();
          break;

        // ── Desde CLAUDE_DONE ─────────────────────────────────────
        case 'deploy':
          runDeploy();
          break;

        case 'retry_claude':
          emitState(S.CLAUDE_WORKING, 'Otra ronda con Claude...');
          await injectClaude('Revisa el trabajo anterior. Mejora la calidad del código, corrige errores y aplica buenas prácticas.');
          break;

        case 'custom_claude':
          if (!text?.trim()) return;
          emitState(S.CLAUDE_WORKING, 'Enviando instrucciones a Claude...');
          await injectClaude(text.trim());
          break;

        // ── Desde DONE ───────────────────────────────────────────
        case 'new_project':
          resetFab();
          emitState(S.IDLE, '✨ Fábrica lista para un nuevo proyecto.');
          break;

        // ── Captura manual (cuando auto-detect no funciona) ──────
        case 'capture_gemini':
          emitProgress('Capturando respuesta de Gemini...');
          await captureGeminiResult();
          break;

        case 'capture_manus':
          emitProgress('Capturando respuesta de Manus...');
          await captureManusResult();
          break;

        // ── Global ───────────────────────────────────────────────
        case 'cancel':
          if (fab.monitor) { clearInterval(fab.monitor); fab.monitor = null; }
          emitState(S.IDLE, 'Proceso cancelado.');
          break;
      }
    } catch(e) {
      emitProgress('❌ Error: ' + e.message);
      console.error('[Motor] Error:', e);
    }
  });

  // ── Cargar proyecto guardado ──────────────────────────────
  socket.on('fab:load_project', async ({ id } = {}) => {
    fab.socket = socket;
    const projects = loadProjects();
    const p = projects.find(pr => pr.id === id);
    if (!p) { socket.emit('fab:progress', { message: 'Proyecto no encontrado' }); return; }

    if (fab.monitor) { clearInterval(fab.monitor); fab.monitor = null; }
    fab.projectId    = p.id;
    fab.createdAt    = p.createdAt;
    fab.idea         = p.idea || '';
    fab.geminiResult = p.geminiResult || '';
    fab.geminiConvUrl= p.geminiConvUrl || '';
    fab.manusResult  = p.manusResult || '';
    fab.manusConvUrl = p.manusConvUrl || '';
    fab.claudeResult = p.claudeResult || '';
    fab.deployUrl    = p.deployUrl || '';

    // Navegar Safari a la conversación guardada
    if (p.geminiConvUrl) {
      try {
        await runScript(`tell application "Safari"\n  open location "${p.geminiConvUrl}"\n  activate\nend tell\ndelay 1`);
      } catch(e) {}
    }

    const restoredState = p.state || S.IDLE;
    const data = {};
    if (p.geminiResult)  data.result  = p.geminiResult;
    if (p.manusResult)   data.result  = p.manusResult;
    if (p.claudeResult)  data.content = p.claudeResult;
    if (p.deployUrl)     data.url     = p.deployUrl;

    emitState(restoredState, `Proyecto "${p.name}" restaurado.`, data);
    console.log(`[Motor] Proyecto cargado: ${p.name} (${restoredState})`);
  });

  // ── Comandos heredados ────────────────────────────────────────
  socket.on('client:send_command', (data) => {
    const command  = data?.command || '';
    const cmdLower = command.toLowerCase();
    socket.emit('server:status_update', { step: 1, totalSteps: 2, status: 'processing', message: 'Procesando: ' + command });
    let shellCmd;
    if      (cmdLower.includes('safari'))      shellCmd = 'open -a Safari';
    else if (cmdLower.includes('calculadora')) shellCmd = 'open -a Calculator';
    else { const safe = command.replace(/[`$\\;"'|&<>(){}!\n\r]/g, ''); shellCmd = `echo "${safe}"`; }
    exec(shellCmd, (err, stdout) => {
      socket.emit('server:status_update', { step: 2, totalSteps: 2, status: 'completed', message: stdout.trim() || 'OK' });
    });
  });

  socket.on('disconnect', () => {
    console.log(`[Motor Mac] ❌ Cliente desconectado: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`\n[Motor Mac] 🚀 Activo en http://localhost:${PORT}`);
  console.log(`[Motor Mac] 🔐 PIN requerido para conectar`);
  console.log(`[Motor Mac] 🤖 Esperando instrucciones desde el teléfono...\n`);
});
