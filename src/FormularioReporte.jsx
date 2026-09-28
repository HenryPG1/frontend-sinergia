import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import {
  Camera, Trash2, ChevronUp, ChevronDown, Plus, AlertTriangle, Check, Send, Eye,
  CloudOff, RefreshCw, Clock, X, Download,
} from "lucide-react";
import {
  guardarBorrador, leerBorrador, borrarBorrador,
  encolar, leerCola, quitarDeCola, pedirAlmacenamientoPersistente,
} from "./almacen";
import { enviarReporte, previsualizar } from "./api";

/* Componentes del reporte institucional, en el orden de la plantilla (RF-16). */
const COMPONENTES_BASE = [
  "Flota", "Antena GPS", "Antena GPRS", "Antena Zigbee", "Pantalla S7", "MAG 100",
  "Positivo", "Negativo", "Fusible", "CAN Crocodille", "Salida de antenas",
];

const LIMITE_MB = 10; // RNF-03
const INTERVALO_REINTENTO_MS = 30000;

/* Campos que se conservan al terminar un reporte: el técnico suele
   instalar varias unidades del mismo cliente en la misma jornada. */
const CAMPOS_QUE_SE_CONSERVAN = [
  "correo_supervisor", "cliente", "direccion", "ciudad", "pais", "tercero", "proyecto", "tecnico",
];

const datosIniciales = () => ({
  correo_supervisor: "", cliente: "", direccion: "", ciudad: "", pais: "Guatemala",
  tercero: "", proyecto: "", actividad: "Instalación", tipo_equipo: "", modelo_equipo: "",
  unidad: "", placa: "", tecnico: "",
});

const modulosIniciales = () =>
  COMPONENTES_BASE.map((nombre, i) => ({
    id: `m${i}`, componente: nombre, observacion: "", imagen: null, error: null,
  }));

const nuevoId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function comprimirImagen(archivo, ladoMaximo = 1600, calidad = 0.82) {
  return new Promise((resolver, rechazar) => {
    const lector = new FileReader();
    lector.onerror = () => rechazar(new Error("No se pudo leer el archivo."));
    lector.onload = () => {
      const img = new Image();
      img.onerror = () => rechazar(new Error("El archivo no es una imagen válida."));
      img.onload = () => {
        const escala = Math.min(1, ladoMaximo / Math.max(img.width, img.height));
        const lienzo = document.createElement("canvas");
        lienzo.width = Math.round(img.width * escala);
        lienzo.height = Math.round(img.height * escala);
        lienzo.getContext("2d").drawImage(img, 0, 0, lienzo.width, lienzo.height);
        resolver(lienzo.toDataURL("image/jpeg", calidad));
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(archivo);
  });
}

function pesoBase64MB(dataUrl) {
  const solo = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  return (solo.length * 3) / 4 / (1024 * 1024);
}

const horaCorta = (ms) =>
  new Date(ms).toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit" });

const CAMPOS_GENERALES = [
  { clave: "cliente", etiqueta: "Cliente", ejemplo: "Magdalena" },
  { clave: "direccion", etiqueta: "Dirección", ejemplo: "KM 99.5 carretera a Sipacate" },
  { clave: "ciudad", etiqueta: "Ciudad", ejemplo: "La Democracia, Escuintla" },
  { clave: "pais", etiqueta: "País", ejemplo: "Guatemala" },
  { clave: "tercero", etiqueta: "Nombre del tercero", ejemplo: "Noe Mijangos (Sinergia)" },
  { clave: "proyecto", etiqueta: "Número de proyecto", ejemplo: "PROY-2026-018" },
  { clave: "tipo_equipo", etiqueta: "Tipo de equipo", ejemplo: "TPL" },
  { clave: "modelo_equipo", etiqueta: "Modelo de equipo", ejemplo: "John Deere" },
  { clave: "placa", etiqueta: "Placa", ejemplo: "No aplica" },
  { clave: "tecnico", etiqueta: "Técnico", ejemplo: "Noe Mijangos" },
];

export default function FormularioReporte() {
  const [datos, setDatos] = useState(datosIniciales);
  const [modulos, setModulos] = useState(modulosIniciales);
  const [cargado, setCargado] = useState(false);
  const [vista, setVista] = useState("datos");
  const [intentado, setIntentado] = useState(false);
  const [cola, setCola] = useState([]);
  const [enLinea, setEnLinea] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [aviso, setAviso] = useState(null);
  const [generandoVista, setGenerandoVista] = useState(false);
  const [pdf, setPdf] = useState(null); // vista previa lista para abrir
  const entradas = useRef({});
  const procesando = useRef(false);

  /* ---------- Cola de envío ---------- */

  const refrescarCola = useCallback(async () => {
    try {
      setCola(await leerCola());
    } catch (e) {
      console.error("No se pudo leer la cola", e);
    }
  }, []);

  const procesarCola = useCallback(async () => {
    if (procesando.current) return;
    procesando.current = true;
    try {
      const pendientes = (await leerCola()).filter((i) => i.estado === "pendiente");
      for (const item of pendientes) {
        const r = await enviarReporte(item.carga);

        if (r.tipo === "enviado") {
          await quitarDeCola(item.id); // solo sale de la cola con confirmación
          setAviso({
            tipo: "ok",
            texto:
              `Reporte de la flota ${item.unidad} enviado (${r.correlativo}).` +
              (r.modo === "prueba" ? " Modo de prueba: el PDF quedó en el servidor, no salió correo." : ""),
          });
        } else if (r.tipo === "rechazado") {
          await encolar({ ...item, estado: "rechazado", errores: r.errores });
        } else {
          await encolar({ ...item, ultimoError: r.mensaje, intentos: (item.intentos || 0) + 1 });
          break; // sin conexión o servidor caído: no tiene sentido seguir con los demás
        }
      }
    } catch (e) {
      console.error("Error procesando la cola", e);
    } finally {
      procesando.current = false;
      await refrescarCola();
    }
  }, [refrescarCola]);

  /* ---------- Arranque: recuperar borrador y cola ---------- */

  useEffect(() => {
    (async () => {
      pedirAlmacenamientoPersistente();
      try {
        const b = await leerBorrador();
        if (b) {
          setDatos({ ...datosIniciales(), ...b.datos });
          if (Array.isArray(b.modulos) && b.modulos.length) setModulos(b.modulos);
        }
      } catch (e) {
        console.error("No se pudo recuperar el borrador", e);
      }
      setCargado(true);
      await refrescarCola();
      procesarCola();
    })();
  }, [refrescarCola, procesarCola]);

  /* ---------- Guardado automático del borrador ---------- */

  useEffect(() => {
    if (!cargado) return; // evita pisar el borrador guardado con el formulario vacío
    const t = setTimeout(() => {
      guardarBorrador({ datos, modulos: modulos.map(({ error, ...m }) => m) }).catch((e) =>
        console.error("No se pudo guardar el borrador", e)
      );
    }, 500);
    return () => clearTimeout(t);
  }, [datos, modulos, cargado]);

  /* ---------- Reintento al recuperar conexión ---------- */

  useEffect(() => {
    const alConectar = () => {
      setEnLinea(true);
      procesarCola();
    };
    const alDesconectar = () => setEnLinea(false);
    window.addEventListener("online", alConectar);
    window.addEventListener("offline", alDesconectar);
    // navigator.onLine puede decir "conectado" sin internet real; por eso también se reintenta periódicamente
    const intervalo = setInterval(procesarCola, INTERVALO_REINTENTO_MS);
    return () => {
      window.removeEventListener("online", alConectar);
      window.removeEventListener("offline", alDesconectar);
      clearInterval(intervalo);
    };
  }, [procesarCola]);

  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(null), 8000);
    return () => clearTimeout(t);
  }, [aviso]);

  /* ---------- Edición del formulario ---------- */

  const actualizar = (clave, valor) => setDatos((d) => ({ ...d, [clave]: valor }));

  const cambiarModulo = (id, campo, valor) =>
    setModulos((ms) => ms.map((m) => (m.id === id ? { ...m, [campo]: valor } : m)));

  const tomarFoto = async (id, archivo) => {
    if (!archivo) return;
    cambiarModulo(id, "error", null);
    try {
      const dataUrl = await comprimirImagen(archivo);
      const mb = pesoBase64MB(dataUrl);
      if (mb > LIMITE_MB) {
        cambiarModulo(id, "error", `La foto pesa ${mb.toFixed(1)} MB y el máximo es ${LIMITE_MB} MB.`);
        return;
      }
      cambiarModulo(id, "imagen", dataUrl);
    } catch (e) {
      cambiarModulo(id, "error", e.message);
    }
  };

  const mover = (indice, direccion) => {
    const destino = indice + direccion;
    if (destino < 0 || destino >= modulos.length) return;
    setModulos((ms) => {
      const copia = [...ms];
      [copia[indice], copia[destino]] = [copia[destino], copia[indice]];
      return copia;
    });
  };

  const agregarModulo = () =>
    setModulos((ms) => [
      ...ms,
      { id: `m${Date.now()}`, componente: "", observacion: "", imagen: null, error: null, extra: true },
    ]);

  const quitarModulo = (id) => setModulos((ms) => ms.filter((m) => m.id !== id));

  const conFoto = modulos.filter((m) => m.imagen);

  const errores = useMemo(() => {
    const lista = [];
    if (!datos.unidad.trim()) lista.push("Falta el número de flota.");
    if (!datos.correo_supervisor.trim()) lista.push("Falta el correo del supervisor.");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(datos.correo_supervisor))
      lista.push("El correo del supervisor no tiene un formato válido.");
    if (conFoto.length === 0) lista.push("El reporte necesita al menos una fotografía.");
    if (conFoto.some((m) => !m.componente.trim())) lista.push("Hay una fotografía sin nombre de componente.");
    return lista;
  }, [datos, conFoto]);

  const construirCarga = () => ({
    ...Object.fromEntries(Object.entries(datos).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])),
    fotografias: conFoto.map((m, i) => ({
      componente: m.componente.trim(),
      observacion: m.observacion.trim() || null,
      imagen_base64: m.imagen,
      orden: i,
    })),
  });

  /* ---------- Acciones principales ---------- */

  const verificar = () => {
    setIntentado(true);
    if (errores.length > 0) {
      setVista("datos");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return false;
    }
    return true;
  };

  /* En el teléfono, el navegador no deja abrir una pestaña después de esperar
     al servidor, y Chrome para Android no muestra PDF dentro de la página.
     Por eso el PDF se prepara primero y el técnico lo abre con un segundo toque,
     que el teléfono entrega a su visor de PDF. */
  const verVistaPrevia = async () => {
    if (!verificar()) return;
    setGenerandoVista(true);
    const r = await previsualizar(construirCarga());
    setGenerandoVista(false);
    if (r.url) {
      if (pdf) URL.revokeObjectURL(pdf.url);
      setPdf({ url: r.url, nombre: `vista-previa-${datos.unidad.trim() || "reporte"}.pdf` });
    } else {
      setAviso({ tipo: "error", texto: r.mensaje });
    }
  };

  const cerrarPdf = () => {
    if (pdf) URL.revokeObjectURL(pdf.url);
    setPdf(null);
  };

  const esTactil = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  const enviar = async () => {
    if (!verificar()) return;
    const item = {
      id: nuevoId(),
      creado: Date.now(),
      unidad: datos.unidad.trim(),
      estado: "pendiente",
      carga: construirCarga(),
    };
    try {
      await encolar(item);
    } catch (e) {
      console.error(e);
      setAviso({
        tipo: "error",
        texto: "No se pudo guardar el reporte en el teléfono. No cierres la página e intenta de nuevo.",
      });
      return;
    }

    // Ya está a salvo en la cola: se limpia el formulario para la siguiente unidad
    await borrarBorrador().catch(() => {});
    const conservados = Object.fromEntries(CAMPOS_QUE_SE_CONSERVAN.map((k) => [k, datos[k]]));
    setDatos({ ...datosIniciales(), ...conservados });
    setModulos(modulosIniciales());
    setIntentado(false);
    setVista("datos");
    window.scrollTo({ top: 0, behavior: "smooth" });
    setAviso({ tipo: "info", texto: `Reporte de la flota ${item.unidad} guardado. Se envía en cuanto haya conexión.` });

    await refrescarCola();
    procesarCola();
  };

  const descartar = async (id) => {
    await quitarDeCola(id);
    refrescarCola();
  };

  const peso = conFoto.reduce((t, m) => t + pesoBase64MB(m.imagen), 0);
  const enEspera = cola.filter((i) => i.estado === "pendiente").length;

  const campoBase =
    "w-full bg-white border border-stone-300 px-3 py-3 text-base text-stone-900 focus:outline-none focus:border-stone-900 focus:ring-1 focus:ring-stone-900";

  if (!cargado) {
    return <div className="min-h-screen bg-stone-100 p-6 text-stone-600">Recuperando reporte…</div>;
  }

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 pb-36">
      <header className="bg-stone-900 text-stone-50 px-4 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-lg font-semibold leading-tight">Reporte de instalación</p>
            <p className="text-sm text-stone-400 leading-tight">Sinergia Soluciones</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-stone-400 leading-tight">Flota</p>
            <p className="text-xl font-bold leading-tight">{datos.unidad || "—"}</p>
          </div>
        </div>
        {!enLinea && (
          <p className="mt-3 flex items-center gap-2 text-sm text-orange-300">
            <CloudOff size={16} /> Sin señal. Puedes seguir trabajando; todo queda guardado en el teléfono.
          </p>
        )}
      </header>

      <nav className="flex border-b border-stone-300 bg-stone-50">
        {[
          ["datos", "Datos de la unidad"],
          ["fotos", `Componentes (${conFoto.length}/${modulos.length})`],
        ].map(([id, texto]) => (
          <button
            key={id}
            onClick={() => setVista(id)}
            className={
              "flex-1 py-4 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-inset focus:ring-stone-900 " +
              (vista === id ? "bg-stone-50 text-stone-900 border-b-2 border-orange-600" : "bg-stone-200 text-stone-500")
            }
          >
            {texto}
          </button>
        ))}
      </nav>

      {/* ---------- Reportes en espera ---------- */}
      {cola.length > 0 && (
        <section className="mx-4 mt-4 border border-stone-900 bg-white">
          <div className="flex items-center justify-between border-b border-stone-200 px-3 py-2">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Clock size={16} />
              {enEspera === 1 ? "1 reporte en espera de envío" : `${enEspera} reportes en espera de envío`}
            </p>
            {enEspera > 0 && (
              <button
                onClick={procesarCola}
                className="flex items-center gap-1 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-stone-900"
              >
                <RefreshCw size={14} /> Reintentar
              </button>
            )}
          </div>
          <ul>
            {cola.map((item) => (
              <li key={item.id} className="border-b border-stone-200 px-3 py-2 text-sm last:border-b-0">
                <div className="flex justify-between">
                  <span className="font-semibold">Flota {item.unidad}</span>
                  <span className="text-stone-500">{horaCorta(item.creado)}</span>
                </div>
                {item.estado === "rechazado" ? (
                  <div className="mt-1">
                    <p className="text-red-800">El servidor rechazó este reporte:</p>
                    <ul className="text-red-800">
                      {item.errores?.map((e) => <li key={e}>{e}</li>)}
                    </ul>
                    <button
                      onClick={() => descartar(item.id)}
                      className="mt-1 text-sm text-stone-600 underline focus:outline-none focus:ring-2 focus:ring-stone-900"
                    >
                      Descartar
                    </button>
                  </div>
                ) : (
                  item.ultimoError && (
                    <p className="text-stone-500">
                      {item.ultimoError} Intentos: {item.intentos || 0}.
                    </p>
                  )
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {intentado && errores.length > 0 && (
        <div className="mx-4 mt-4 border-l-4 border-red-700 bg-red-50 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-800">
            <AlertTriangle size={16} /> El reporte no se puede enviar todavía
          </p>
          <ul className="mt-2 space-y-1 text-sm text-red-800">
            {errores.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      )}

      {/* ---------- Datos generales ---------- */}
      {vista === "datos" && (
        <section className="px-4 py-5 space-y-5">
          <div>
            <label className="block text-sm font-semibold mb-1" htmlFor="unidad">Número de flota</label>
            <input
              id="unidad"
              value={datos.unidad}
              onChange={(e) => actualizar("unidad", e.target.value)}
              placeholder="07-234"
              className={campoBase + (intentado && !datos.unidad.trim() ? " border-red-700" : "")}
            />
            <p className="mt-1 text-sm text-stone-500">Identifica el vehículo en todo el reporte.</p>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1" htmlFor="correo">Correo del supervisor</label>
            <input
              id="correo"
              type="email"
              inputMode="email"
              value={datos.correo_supervisor}
              onChange={(e) => actualizar("correo_supervisor", e.target.value)}
              placeholder="supervisor@sinergia.com.gt"
              className={campoBase}
            />
          </div>

          <div>
            <p className="block text-sm font-semibold mb-2">Actividad</p>
            <div className="flex gap-2">
              {["Instalación", "Desinstalación"].map((op) => (
                <button
                  key={op}
                  onClick={() => actualizar("actividad", op)}
                  className={
                    "flex-1 border py-3 text-base focus:outline-none focus:ring-2 focus:ring-stone-900 " +
                    (datos.actividad === op
                      ? "border-stone-900 bg-stone-900 text-stone-50"
                      : "border-stone-300 bg-white text-stone-700")
                  }
                >
                  {op}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-2 border-t border-stone-300 space-y-4">
            {CAMPOS_GENERALES.map((c) => (
              <div key={c.clave}>
                <label className="block text-sm font-semibold mb-1" htmlFor={c.clave}>{c.etiqueta}</label>
                <input
                  id={c.clave}
                  value={datos[c.clave]}
                  onChange={(e) => actualizar(c.clave, e.target.value)}
                  placeholder={c.ejemplo}
                  className={campoBase}
                />
              </div>
            ))}
            <p className="text-sm text-stone-500">Los campos que dejes en blanco aparecen con un guion en el reporte.</p>
          </div>
        </section>
      )}

      {/* ---------- Componentes ---------- */}
      {vista === "fotos" && (
        <section className="px-4 py-5 space-y-4">
          <p className="text-sm text-stone-600">
            Toma una foto por cada componente instalado. Los módulos sin foto no se incluyen en el reporte.
          </p>

          {modulos.map((m, i) => (
            <article key={m.id} className={"border bg-white " + (m.imagen ? "border-stone-900" : "border-stone-300")}>
              <div className="flex items-center gap-2 border-b border-stone-200 px-3 py-2">
                <span
                  className={
                    "flex h-6 w-6 shrink-0 items-center justify-center text-sm font-bold " +
                    (m.imagen ? "bg-stone-900 text-stone-50" : "bg-stone-200 text-stone-500")
                  }
                >
                  {m.imagen ? <Check size={14} /> : i + 1}
                </span>
                <input
                  value={m.componente}
                  onChange={(e) => cambiarModulo(m.id, "componente", e.target.value)}
                  placeholder="Nombre del componente"
                  aria-label={`Nombre del componente ${i + 1}`}
                  className="min-w-0 flex-1 bg-transparent text-base font-semibold focus:outline-none"
                />
                <button onClick={() => mover(i, -1)} aria-label="Subir componente"
                  className="p-1 text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900">
                  <ChevronUp size={18} />
                </button>
                <button onClick={() => mover(i, 1)} aria-label="Bajar componente"
                  className="p-1 text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900">
                  <ChevronDown size={18} />
                </button>
              </div>

              <div className="p-3 space-y-3">
                {m.imagen ? (
                  <div>
                    <img src={m.imagen} alt={`Fotografía de ${m.componente || "componente"}`}
                      className="w-full border border-stone-300 object-cover" />
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-sm text-stone-500">{pesoBase64MB(m.imagen).toFixed(2)} MB</span>
                      <button
                        onClick={() => cambiarModulo(m.id, "imagen", null)}
                        className="flex items-center gap-1 text-sm text-red-700 focus:outline-none focus:ring-2 focus:ring-stone-900"
                      >
                        <Trash2 size={14} /> Quitar foto
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => entradas.current[m.id]?.click()}
                    className="flex w-full items-center justify-center gap-2 border border-dashed border-stone-400 bg-stone-50 py-8 text-base font-medium text-stone-700 focus:outline-none focus:ring-2 focus:ring-stone-900"
                  >
                    <Camera size={20} /> Tomar foto
                  </button>
                )}

                <input
                  ref={(el) => (entradas.current[m.id] = el)}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    tomarFoto(m.id, e.target.files?.[0]);
                    e.target.value = ""; // permite volver a elegir el mismo archivo
                  }}
                />

                {m.error && (
                  <p className="border-l-4 border-red-700 bg-red-50 px-3 py-2 text-sm text-red-800">{m.error}</p>
                )}

                <input
                  value={m.observacion}
                  onChange={(e) => cambiarModulo(m.id, "observacion", e.target.value)}
                  placeholder="Observación (opcional)"
                  aria-label={`Observación de ${m.componente || `componente ${i + 1}`}`}
                  className={campoBase}
                />

                {m.extra && (
                  <button onClick={() => quitarModulo(m.id)}
                    className="text-sm text-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-900">
                    Eliminar este módulo
                  </button>
                )}
              </div>
            </article>
          ))}

          <button
            onClick={agregarModulo}
            className="flex w-full items-center justify-center gap-2 border border-stone-400 bg-white py-4 text-base font-medium focus:outline-none focus:ring-2 focus:ring-stone-900"
          >
            <Plus size={18} /> Agregar otro componente
          </button>
        </section>
      )}

      {/* ---------- Vista previa lista ---------- */}
      {pdf && (
        <div className="fixed left-4 right-4 bottom-36 z-30 border border-stone-900 bg-white px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-semibold">La vista previa está lista.</p>
            <button onClick={cerrarPdf} aria-label="Cerrar vista previa"
              className="focus:outline-none focus:ring-2 focus:ring-stone-900">
              <X size={16} />
            </button>
          </div>
          <a
            href={pdf.url}
            {...(esTactil ? { download: pdf.nombre } : { target: "_blank", rel: "noopener" })}
            className="mt-3 flex items-center justify-center gap-2 bg-stone-900 py-3 text-base font-semibold text-stone-50 focus:outline-none focus:ring-2 focus:ring-orange-600"
          >
            <Download size={18} /> Abrir PDF
          </a>
          {esTactil && (
            <p className="mt-2 text-sm text-stone-500">
              Se abre con el visor de PDF del teléfono. Al terminar, vuelve a esta pestaña: el reporte sigue aquí.
            </p>
          )}
        </div>
      )}

      {/* ---------- Aviso ---------- */}
      {aviso && (
        <div
          role="status"
          className={
            "fixed left-4 right-4 bottom-36 z-20 flex items-start gap-3 border px-4 py-3 text-sm " +
            (aviso.tipo === "error"
              ? "border-red-700 bg-red-50 text-red-900"
              : aviso.tipo === "ok"
              ? "border-stone-900 bg-stone-900 text-stone-50"
              : "border-stone-900 bg-white text-stone-900")
          }
        >
          <p className="flex-1">{aviso.texto}</p>
          <button onClick={() => setAviso(null)} aria-label="Cerrar aviso"
            className="focus:outline-none focus:ring-2 focus:ring-stone-500">
            <X size={16} />
          </button>
        </div>
      )}

      {/* ---------- Barra de acciones ---------- */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-stone-300 bg-stone-50 px-4 py-3">
        <div className="mb-2 flex items-center justify-between text-sm text-stone-600">
          <span>{conFoto.length} {conFoto.length === 1 ? "fotografía" : "fotografías"}</span>
          <span>{peso.toFixed(2)} MB por enviar</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={verVistaPrevia}
            disabled={generandoVista}
            className="flex flex-1 items-center justify-center gap-2 border border-stone-900 bg-white py-4 text-base font-semibold disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-stone-900"
          >
            <Eye size={18} /> {generandoVista ? "Generando…" : "Vista previa"}
          </button>
          <button
            onClick={enviar}
            className="flex flex-1 items-center justify-center gap-2 bg-orange-600 py-4 text-base font-semibold text-white focus:outline-none focus:ring-2 focus:ring-stone-900"
          >
            <Send size={18} /> Enviar reporte
          </button>
        </div>
      </div>
    </div>
  );
}
