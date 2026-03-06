const express  = require('express');
const http     = require('http');
const path     = require('path');
const { exec } = require('child_process');

// ─── Inicialización ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// CORS abierto: el frontend vive en un VPS distinto
const io = require('socket.io')(server, {
  cors: {
    origin:  '*',
    methods: ['GET', 'POST']
  }
});

const PORT       = 3000;
const MASTER_PIN = "1234"; // TODO: mover a variable de entorno (.env)

// ─── Middleware de autenticación por PIN ─────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token === MASTER_PIN) {
    return next();
  }
  console.warn(`[Motor Mac] Acceso denegado para ${socket.handshake.address} — PIN incorrecto`);
  return next(new Error("Acceso denegado: PIN incorrecto"));
});

// ─── Servir el Panel (frontend_vps/public) ────────────────────────
app.use(express.static(path.join(__dirname, '..', 'frontend_vps', 'public')));

// ─── Lógica de WebSockets ────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Motor Mac] Cliente conectado: ${socket.id}`);

  socket.on('client:send_command', (data) => {
    const command  = data?.command || '';
    const cmdLower = command.toLowerCase();

    console.log(`[Motor Mac] Comando de ${socket.id}: "${command}"`);

    // Paso 1: acuse de recibo inmediato
    socket.emit('server:status_update', {
      step:       1,
      totalSteps: 2,
      status:     'processing',
      message:    'Procesando comando: ' + command
    });

    // Decidir qué ejecutar en el Mac
    let shellCmd;
    if (cmdLower.includes('safari')) {
      shellCmd = 'open -a Safari';
    } else if (cmdLower.includes('calculadora')) {
      shellCmd = 'open -a Calculator';
    } else {
      // Sanitizar: eliminar metacaracteres de shell para evitar inyección
      const safe = command.replace(/[`$\\;"'|&<>(){}!\n\r]/g, '');
      shellCmd = `echo "Comando recibido: ${safe}"`;
    }

    // Ejecutar y devolver resultado
    exec(shellCmd, (error, stdout, stderr) => {
      const output = stdout || stderr || (error ? error.message : 'OK');
      socket.emit('server:status_update', {
        step:       2,
        totalSteps: 2,
        status:     'completed',
        message:    `Tarea finalizada. Output: ${output.trim() || 'OK'}`
      });
      console.log(`[Motor Mac] [${socket.id}] Completado — ${output.trim() || 'OK'}`);
    });
  });

  socket.on('disconnect', () => {
    console.log(`[Motor Mac] Cliente desconectado: ${socket.id}`);
  });
});

// ─── Arrancar el motor ───────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Motor Mac] Activo en http://localhost:${PORT}`);
});
