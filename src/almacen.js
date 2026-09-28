/* ------------------------------------------------------------------
   almacen.js
   Almacenamiento local en el teléfono mediante IndexedDB.

   Dos espacios:
   - borrador: el reporte que el técnico está llenando. Sobrevive a
     recargar la página, cerrar el navegador o quedarse sin batería.
   - cola: reportes terminados que esperan ser enviados al servidor.
     Un reporte sale de la cola solo cuando el servidor confirma el envío.
------------------------------------------------------------------- */

const NOMBRE_BD = "sinergia-reportes";
const VERSION = 1;

function abrir() {
  return new Promise((resolver, rechazar) => {
    const peticion = indexedDB.open(NOMBRE_BD, VERSION);
    peticion.onupgradeneeded = () => {
      const bd = peticion.result;
      if (!bd.objectStoreNames.contains("borrador")) bd.createObjectStore("borrador");
      if (!bd.objectStoreNames.contains("cola")) bd.createObjectStore("cola", { keyPath: "id" });
    };
    peticion.onsuccess = () => resolver(peticion.result);
    peticion.onerror = () => rechazar(peticion.error);
  });
}

async function transaccion(espacio, modo, operacion) {
  const bd = await abrir();
  return new Promise((resolver, rechazar) => {
    const tx = bd.transaction(espacio, modo);
    const peticion = operacion(tx.objectStore(espacio));
    let resultado;
    if (peticion) peticion.onsuccess = () => (resultado = peticion.result);
    tx.oncomplete = () => {
      bd.close();
      resolver(resultado);
    };
    tx.onerror = () => {
      bd.close();
      rechazar(tx.error);
    };
    tx.onabort = () => {
      bd.close();
      rechazar(tx.error);
    };
  });
}

/* Borrador */
export const guardarBorrador = (b) => transaccion("borrador", "readwrite", (s) => s.put(b, "actual"));
export const leerBorrador = () => transaccion("borrador", "readonly", (s) => s.get("actual"));
export const borrarBorrador = () => transaccion("borrador", "readwrite", (s) => s.delete("actual"));

/* Cola de envío */
export const encolar = (item) => transaccion("cola", "readwrite", (s) => s.put(item));
export const leerCola = async () =>
  ((await transaccion("cola", "readonly", (s) => s.getAll())) || []).sort((a, b) => a.creado - b.creado);
export const quitarDeCola = (id) => transaccion("cola", "readwrite", (s) => s.delete(id));

/* Pide al navegador que no borre estos datos cuando le falte espacio. */
export async function pedirAlmacenamientoPersistente() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    /* Si el navegador no lo soporta, los datos igual se guardan. */
  }
}
