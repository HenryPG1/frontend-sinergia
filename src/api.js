/* ------------------------------------------------------------------
   api.js
   Comunicación con el backend (FastAPI).
   La dirección se configura en el archivo .env.local con VITE_API_URL.
------------------------------------------------------------------- */

export const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/$/, "");

const TIEMPO_MAXIMO_MS = 60000; // una red de campo lenta puede tardar

async function peticionConTiempo(url, opciones) {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), TIEMPO_MAXIMO_MS);
  try {
    return await fetch(url, { ...opciones, signal: control.signal });
  } finally {
    clearTimeout(temporizador);
  }
}

function opcionesPost(carga) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Evita la página de advertencia de los túneles de VS Code, que rompe las llamadas desde el teléfono
      "X-Tunnel-Skip-AntiPhishing-Page": "true",
    },
    body: JSON.stringify(carga),
  };
}

/* Envía el reporte. Devuelve un objeto con `tipo`:
   enviado        el servidor generó el PDF y lo envió (o lo guardó en modo prueba)
   rechazado      los datos no pasaron la validación (422); reintentar no sirve
   error_correo   el PDF se generó pero el correo falló; conviene reintentar
   error_servidor el servidor respondió con otro error; conviene reintentar
   sin_conexion   no se pudo llegar al servidor; conviene reintentar          */
export async function enviarReporte(carga) {
  let respuesta;
  try {
    respuesta = await peticionConTiempo(`${API_URL}/reportes/enviar`, opcionesPost(carga));
  } catch {
    return { tipo: "sin_conexion", mensaje: "Sin conexión con el servidor." };
  }

  if (respuesta.status === 422) {
    const cuerpo = await respuesta.json().catch(() => ({}));
    return { tipo: "rechazado", errores: cuerpo.errores || ["Los datos enviados no son válidos."] };
  }

  if (!respuesta.ok) {
    return { tipo: "error_servidor", mensaje: `El servidor respondió con error ${respuesta.status}.` };
  }

  const cuerpo = await respuesta.json();
  const envio = cuerpo.resultado_envio || {};

  if (envio.modo === "error") {
    return { tipo: "error_correo", mensaje: "El correo no se pudo enviar. Se reintentará." };
  }

  return { tipo: "enviado", correlativo: cuerpo.correlativo, modo: envio.modo };
}

/* Pide el PDF sin enviarlo por correo. Devuelve { url } o { mensaje }. */
export async function previsualizar(carga) {
  try {
    const respuesta = await peticionConTiempo(`${API_URL}/reportes/preview`, opcionesPost(carga));
    if (respuesta.status === 422) {
      const cuerpo = await respuesta.json().catch(() => ({}));
      return { mensaje: "El servidor rechazó los datos: " + (cuerpo.errores || []).join("; ") };
    }
    if (!respuesta.ok) return { mensaje: `El servidor respondió con error ${respuesta.status}.` };
    const pdf = await respuesta.blob();
    return { url: URL.createObjectURL(pdf) };
  } catch {
    return {
      mensaje:
        "La vista previa necesita conexión con el servidor. Puedes enviar el reporte igual: queda guardado y sale cuando vuelva la señal.",
    };
  }
}
