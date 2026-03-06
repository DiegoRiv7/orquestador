BRIDGE_ARCHITECTURE.md — Verdad Absoluta del AI Command Bridge

Proyecto: AI Command Bridge (Orquestador de IAs)
Rol del Sistema: Hub de automatización y control remoto.
Versión: 3.0.0 (Fase de Inteligencia y Despliegue VPS)

1. REGLAS DE LA FÁBRICA (Operación Agéntica)

Rol

Agente

Permisos y Restricciones

Director

Humano (Diego)

Aprueba y ejecuta despliegues.

Arquitecto

Gemini Pro

Diseña arquitectura y prompts. No escribe código final.

Motor

Manus AI

Escribe código base.

Inspector

Claude Code

Revisa código local, hace push a Git y corrige bugs.

2. ARQUITECTURA DESACOPLADA (Estatus: FUNCIONAL)

COMPONENTE A: El Panel de Control (Frontend en VPS Ionos)

Estado: Listo para despliegue.

Misión: Interfaz visual para el Director. Requiere CAPA DE SEGURIDAD (Login).

COMPONENTE B: El Motor de Ejecución (Backend en MacBook)

Estado: Funcional (Nativo).

Misión: Ejecutar comandos de terminal. Requiere integración con Manus y Claude.

3. PRÓXIMOS PASOS (FASE 3: INTELIGENCIA Y SEGURIDAD)

3.1 Blindaje de Acceso (Seguridad)

No podemos subir el panel al VPS sin protección. Cualquier persona con la URL podría abrir apps en tu Mac.

Implementación: Agregar una pantalla de "Código de Acceso" (PIN) en la PWA antes de conectar el Socket.

3.2 El "Modo Fábrica" (Orquestación Real)

Pasar de abrir la calculadora a poner a trabajar a los agentes. Programaremos comandos como:

/manus "idea": Abre Safari, entra a Manus y pega el prompt.

/claude "tarea": Ejecuta Claude Code en la terminal de la carpeta del CRM.

/status: Captura de pantalla de la Mac y envío al celular para ver qué está pasando.

3.3 Despliegue Final en VPS

Mover la carpeta frontend_vps a Ionos mediante Docker para que el panel sea permanente y profesional (ej. bridge.iamet.mx).

4. CONVENCIONES DE SEGURIDAD (CORS & AUTH)

El backend en la Mac solo responderá si el mensaje de Socket incluye un auth_token válido generado tras el login en el frontend.