const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// ─── Inicialización ───────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// ─── Archivos estáticos ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Lógica de WebSockets ────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[AI Command Bridge] Cliente conectado: ${socket.id}`);

  // Escuchar el evento de comando enviado por el cliente
  socket.on('client:send_command', (data) => {
    const command = data?.command || 'comando desconocido';
    console.log(`[AI Command Bridge] Comando recibido de ${socket.id}: "${command}"`);

    // Paso 1: Analizando con Gemini...
    setTimeout(() => {
      socket.emit('server:status_update', {
        step: 1,
        totalSteps: 3,
        status: 'processing',
        message: 'Analizando con Gemini...'
      });
      console.log(`[AI Command Bridge] [${socket.id}] Paso 1/3: Analizando con Gemini...`);
    }, 1000);

    // Paso 2: Inyectando en Manus...
    setTimeout(() => {
      socket.emit('server:status_update', {
        step: 2,
        totalSteps: 3,
        status: 'processing',
        message: 'Inyectando en Manus...'
      });
      console.log(`[AI Command Bridge] [${socket.id}] Paso 2/3: Inyectando en Manus...`);
    }, 3000);

    // Paso 3: Desplegando...
    setTimeout(() => {
      socket.emit('server:status_update', {
        step: 3,
        totalSteps: 3,
        status: 'completed',
        message: 'Desplegando...'
      });
      console.log(`[AI Command Bridge] [${socket.id}] Paso 3/3: Desplegando...`);
    }, 5000);
  });

  // Evento de desconexión
  socket.on('disconnect', () => {
    console.log(`[AI Command Bridge] Cliente desconectado: ${socket.id}`);
  });
});

// ─── Arrancar el servidor ────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[AI Command Bridge] Servidor activo en http://localhost:${PORT}`);
});
