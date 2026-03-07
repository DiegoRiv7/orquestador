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
  state:        S.IDLE,
  idea:         '',
  geminiResult: '',
  manusResult:  '',
  claudeResult: '',
  deployUrl:    '',
  monitor:      null,
  socket:       null,
  customAction: null   // acción pendiente cuando usuario edita texto
};

function resetFab() {
  if (fab.monitor) clearInterval(fab.monitor);
  const sock = fab.socket;
  fab = { state: S.IDLE, idea: '', geminiResult: '', manusResult: '',
          claudeResult: '', deployUrl: '', monitor: null, socket: sock, customAction: null };
}

// ─── Helpers de emisión ───────────────────────────────────────────
function emitState(state, message, data = {}) {
  fab.state = state;
  if (fab.socket) fab.socket.emit('fab:state', { state, message, data });
  console.log(`[Motor] ▶ ${state} — ${message}`);
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

// ─── Inyectar texto: pbcopy → clic físico en input → Cmd+V → Enter ───────────
async function focusAndType(urlFragment, text) {
  console.log(`[Motor] focusAndType → "${text.slice(0, 80)}"`);

  // 1. Copiar texto al portapapeles del Mac
  await new Promise((resolve, reject) => {
    const proc = exec('pbcopy', (err) => err ? reject(err) : resolve());
    proc.stdin.write(text, 'utf8');
    proc.stdin.end();
  });
  console.log('[Motor] ✅ Texto en portapapeles');

  // 2. Traer Safari al frente y asegurarse que la ventana esté activa
  await runScript(`
tell application "Safari"
  activate
end tell
delay 0.6
  `);

  // 3. Calcular posición del input (parte inferior central de la ventana Safari)
  //    y hacer clic físico ahí para enfocar el campo
  const clickResult = await runScript(`
tell application "System Events"
  tell process "Safari"
    set winPos  to position of front window
    set winSize to size of front window
    set clickX to (item 1 of winPos) + (item 1 of winSize) / 2
    set clickY to (item 2 of winPos) + (item 2 of winSize) - 100
    click at {clickX, clickY}
    return (clickX as string) & "," & (clickY as string)
  end tell
end tell
  `);
  console.log(`[Motor] ✅ Clic en input: ${clickResult}`);

  await new Promise(r => setTimeout(r, 600));

  // 4. Seleccionar todo el texto previo y pegar el nuevo
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
  console.log('[Motor] ✅ Texto pegado');

  // 5. Enviar con Enter
  await runScript(`
tell application "System Events"
  tell process "Safari"
    key code 36
  end tell
end tell
  `);
  console.log('[Motor] ✅ Enter enviado');
}

// ─────────────────────────────────────────────────────────────────
//  GEMINI
// ─────────────────────────────────────────────────────────────────
async function injectGemini(text) {
  await switchToTab('gemini.google.com');
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
  set r to do JavaScript "(function(){var s=['message-content','model-response','.model-response-text','[data-message-author-role=model]'];for(var i=0;i<s.length;i++){var els=document.querySelectorAll(s[i]);if(els.length){var t=els[els.length-1].innerText.trim();if(t.length>100)return t.slice(0,4000);}}return document.body.innerText.slice(0,4000);})()" in current tab of window 1
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
  await switchToTab('manus.im');
  emitProgress('Manus abierto, enviando prompt...');
  await focusAndType('manus.im', text);
  emitProgress('Prompt enviado. Manus construyendo...');
  startManusMonitor();
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
    const result = await runSafariJS('manus.im', `
(function() {
  var els = document.querySelectorAll('[class*="message"],[class*="agent"],[class*="task"],[class*="result"],[class*="output"]');
  if (els.length) return els[els.length - 1].innerText.trim().slice(0, 3000);
  return document.body.innerText.slice(0, 3000);
})()
    `);
    fab.manusResult = result;
    emitState(S.MANUS_DONE, 'Manus completó la tarea. ¿Qué hacemos ahora?', { result });
  } catch(e) {
    emitProgress('Error capturando Manus: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
//  CLAUDE
// ─────────────────────────────────────────────────────────────────
async function injectClaude(instructions) {
  const instrFile = `/tmp/claude_task_${Date.now()}.md`;
  fs.writeFileSync(instrFile, instructions, 'utf8');

  // Abrir nueva ventana de Terminal con claude
  await runScript(`
tell application "Terminal"
  activate
  set newWin to do script "echo '\\n━━━ INSTRUCCIONES PARA CLAUDE ━━━' && cat \\"${instrFile}\\" && echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' && claude"
  set bounds of front window to {50, 50, 1200, 800}
end tell
  `);

  emitProgress('Claude abierto. Procesando instrucciones...');
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
          emitState(S.CLAUDE_WORKING, 'Pasando a Claude Code...');
          await injectClaude(`Revisa y mejora el siguiente proyecto generado por Manus:\n\n${fab.manusResult}`);
          break;

        case 'retry_manus':
          emitState(S.MANUS_WORKING, 'Reintentando con Manus...');
          await injectManus(fab.geminiResult || fab.idea);
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
