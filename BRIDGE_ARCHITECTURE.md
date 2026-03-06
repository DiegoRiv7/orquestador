# Arquitectura del Proyecto: AI Command Bridge

## 1. Resumen General

**AI Command Bridge** es una aplicación web diseñada para orquestar comandos a través de una interfaz en tiempo real. Utiliza una arquitectura de microservicios contenerizada con Docker, donde un servidor backend de Node.js gestiona la lógica de negocio y la comunicación WebSocket, mientras que un servidor Nginx actúa como un Reverse Proxy para enrutar el tráfico y habilitar las conexiones WebSocket de forma segura.

## 2. Componentes Principales

La arquitectura se divide en tres componentes clave:

| Componente          | Tecnología         | Responsabilidad                                                                                             |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Frontend**        | HTML5, JS, CSS     | Proporcionar la interfaz de usuario para enviar comandos y visualizar las actualizaciones de estado en tiempo real. |
| **Backend (App)**   | Node.js, Express   | Servir la aplicación frontend y gestionar la lógica de negocio principal.                                   |
| **WebSockets**      | Socket.io          | Facilitar la comunicación bidireccional y en tiempo real entre el cliente y el servidor.                      |
| **Reverse Proxy**   | Nginx              | Enrutar el tráfico del puerto 80 al servicio de Node.js y gestionar las conexiones WebSocket.               |
| **Contenerización** | Docker             | Empaquetar y aislar la aplicación y sus dependencias para un despliegue consistente.                        |

## 3. Flujo de Comunicación WebSocket

El núcleo de la aplicación es la comunicación en tiempo real, que sigue este flujo:

1.  **Conexión Inicial**: El cliente (navegador) establece una conexión WebSocket con el servidor a través de Nginx.
2.  **Envío de Comando**: El usuario escribe un comando en el frontend y lo envía. El cliente emite un evento `client:send_command` al servidor con los datos del comando.
3.  **Procesamiento en Backend**: El servidor `server.js` recibe el evento y comienza un proceso simulado de 3 pasos:
    *   Paso 1: "Analizando con Gemini..."
    *   Paso 2: "Inyectando en Manus..."
    *   Paso 3: "Desplegando..."
4.  **Actualizaciones de Estado**: En cada paso del proceso, el servidor emite un evento `server:status_update` al cliente. Este evento contiene el estado actual, el número de paso y un mensaje descriptivo.
5.  **Visualización en Frontend**: El cliente recibe los eventos `server:status_update` y actualiza dinámicamente la interfaz para mostrar el progreso al usuario.

## 4. Infraestructura Docker

La aplicación está completamente contenerizada para garantizar la portabilidad y la facilidad de despliegue.

### `Dockerfile`

El servicio de la aplicación Node.js se construye a partir de una imagen ligera (`node:20-alpine`) para optimizar el tamaño y la seguridad. El proceso de construcción está optimizado para aprovechar la caché de Docker, copiando primero `package.json` e instalando las dependencias antes de añadir el resto del código fuente.

### `nginx/default.conf`

Nginx está configurado como un Reverse Proxy. Escucha en el puerto 80 y redirige todo el tráfico al contenedor de la aplicación Node.js (`app:3000`).

La configuración incluye directivas **críticas** para asegurar el correcto funcionamiento de los WebSockets a través del proxy:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### `docker-compose.yml`

Este archivo orquesta el levantamiento de toda la pila de servicios:

*   **Servicio `app`**: Construye y ejecuta la aplicación Node.js.
*   **Servicio `nginx`**: Ejecuta el contenedor de Nginx, mapeando el puerto 80 del host al puerto 80 del contenedor y montando el archivo de configuración de Nginx.

Ambos servicios se comunican a través de una red interna de Docker (`bridge-network`), asegurando que el backend solo sea accesible a través del Reverse Proxy de Nginx.
