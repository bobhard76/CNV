// Cloudflare Worker para el Buscador CNV
// ----------------------------------------------------------------------------
// Hace dos cosas:
//
//   1) Proxy CORS:   GET  /?url=<url de la CNV>
//      Trae páginas de www.cnv.gov.ar / aif2.cnv.gov.ar y les agrega los
//      encabezados CORS para que la app en GitHub Pages las pueda leer.
//
//   2) Filtro con IA: POST /ia
//      Recibe la lista de búsquedas del usuario y las descripciones de las
//      presentaciones, y devuelve cuáles corresponden a cada búsqueda.
//
//      Proveedores de IA, en orden (si uno falla o se queda sin cupo, pasa
//      al siguiente):
//        a) Cloudflare Workers AI  — gratis (10.000 "neurons" por día),
//           no necesita key: solo agregar el binding "AI" al Worker.
//        b) Groq   — opcional, si cargás el secreto GROQ_API_KEY.
//        c) Gemini — opcional, si cargás el secreto GEMINI_API_KEY.
//
// Configuración (Worker → Settings → Variables and Secrets / Bindings):
//   - Binding de Workers AI con nombre de variable:  AI        (obligatorio)
//   - Secreto GROQ_API_KEY                                     (opcional)
//   - Secreto GEMINI_API_KEY                                   (opcional)
//   - Variable CF_MODEL para cambiar el modelo de Cloudflare   (opcional)
// ----------------------------------------------------------------------------

// Sitios desde los que se permite usar el filtro con IA (para que nadie más
// consuma tu cupo gratuito desde otra página). Agregá acá tu dominio si cambia.
const ORIGENES_PERMITIDOS = [
  'https://bobhard76.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'null', // archivo abierto localmente (file://), útil para probar
];

// Dominios que el proxy acepta traer.
const HOSTS_PERMITIDOS = ['www.cnv.gov.ar', 'cnv.gov.ar', 'aif2.cnv.gov.ar', 'blob.cnv.gov.ar'];

const MODELO_CF_POR_DEFECTO = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MODELO_GROQ = 'openai/gpt-oss-120b';
const MODELO_GEMINI = 'gemini-flash-latest';

const MAX_ITEMS = 250;      // descripciones por pedido
const MAX_BUSQUEDAS = 20;   // renglones de búsqueda por pedido
const MAX_LARGO_TEXTO = 400;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

function origenPermitido(origin) {
  if (!origin) return false;
  return ORIGENES_PERMITIDOS.some(o => origin === o || origin.startsWith(o + ':'));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/ia') {
      if (request.method !== 'POST') return json({ error: 'Usar POST' }, 405, origin);
      if (!origenPermitido(origin)) return json({ error: 'Origen no permitido: ' + origin }, 403, origin);
      return manejarIA(request, env, origin);
    }

    if (url.pathname === '/estado') {
      return json({
        ok: true,
        proveedores: {
          cloudflare: !!env.AI,
          groq: !!env.GROQ_API_KEY,
          gemini: !!env.GEMINI_API_KEY,
        },
      }, 200, origin);
    }

    return manejarProxy(url, origin);
  },
};

// ---------------------------------------------------------------------------
// 1) Proxy CORS
// ---------------------------------------------------------------------------
async function manejarProxy(url, origin) {
  const destino = url.searchParams.get('url');
  if (!destino) return json({ error: 'Falta el parámetro ?url=' }, 400, origin);

  let destinoUrl;
  try { destinoUrl = new URL(destino); } catch { return json({ error: 'URL inválida' }, 400, origin); }
  if (!HOSTS_PERMITIDOS.includes(destinoUrl.hostname)) {
    return json({ error: 'Host no permitido: ' + destinoUrl.hostname }, 403, origin);
  }

  const resp = await fetch(destinoUrl.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-AR,es;q=0.9',
    },
  });

  const headers = new Headers(corsHeaders(origin));
  const ct = resp.headers.get('Content-Type');
  if (ct) headers.set('Content-Type', ct);
  return new Response(resp.body, { status: resp.status, headers });
}

// ---------------------------------------------------------------------------
// 2) Filtro con IA
// ---------------------------------------------------------------------------
async function manejarIA(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400, origin); }

  const busquedas = (Array.isArray(body.busquedas) ? body.busquedas : [])
    .map(b => String(b).trim().slice(0, 200)).filter(Boolean).slice(0, MAX_BUSQUEDAS);
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter(it => it && Number.isInteger(it.id) && it.texto)
    .map(it => ({ id: it.id, texto: String(it.texto).replace(/\s+/g, ' ').trim().slice(0, MAX_LARGO_TEXTO) }))
    .slice(0, MAX_ITEMS);

  if (!busquedas.length) return json({ error: 'No hay búsquedas' }, 400, origin);
  if (!items.length) return json({ coincidencias: [], proveedor: null }, 200, origin);

  const mensajes = armarMensajes(busquedas, items);
  const idsValidos = new Set(items.map(i => i.id));
  const errores = [];

  const proveedores = [];
  if (env.AI) proveedores.push(['cloudflare', () => llamarCloudflare(env, mensajes)]);
  if (env.GROQ_API_KEY) proveedores.push(['groq', () => llamarOpenAICompat(
    'https://api.groq.com/openai/v1/chat/completions', env.GROQ_API_KEY, MODELO_GROQ, mensajes)]);
  if (env.GEMINI_API_KEY) proveedores.push(['gemini', () => llamarOpenAICompat(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', env.GEMINI_API_KEY,
    env.GEMINI_MODEL || MODELO_GEMINI, mensajes)]);

  if (!proveedores.length) {
    return json({ error: 'El Worker no tiene ningún proveedor de IA configurado (falta el binding "AI").' }, 500, origin);
  }

  for (const [nombre, llamar] of proveedores) {
    try {
      const crudo = await llamar();
      const coincidencias = normalizarRespuesta(crudo, idsValidos, busquedas.length);
      return json({ coincidencias, proveedor: nombre }, 200, origin);
    } catch (e) {
      errores.push(`${nombre}: ${e.message || e}`);
    }
  }
  return json({ error: 'Ningún proveedor de IA respondió. ' + errores.join(' | ') }, 502, origin);
}

function armarMensajes(busquedas, items) {
  const sistema = `Sos un analista financiero argentino que clasifica presentaciones regulatorias hechas ante la CNV (Comisión Nacional de Valores). Recibís una lista numerada de BÚSQUEDAS del usuario y una lista de PRESENTACIONES (id y descripción). Para cada presentación, decidí si corresponde a alguna búsqueda.

Criterios:
- Interpretá la intención de la búsqueda, no solo palabras exactas: sinónimos, siglas y términos técnicos equivalentes (por ejemplo "balance" = "estados contables" / "estados financieros"; "ON" = "obligaciones negociables"; "directorio" = "órgano de administración"; "memoria" puede venir junto a los estados contables).
- Incluí una presentación solo si la descripción razonablemente corresponde a la búsqueda. Ante la duda razonable, incluila; si claramente no tiene relación, no.
- Una presentación puede corresponder a más de una búsqueda: en ese caso agregá una entrada por cada búsqueda.
- Usá solo los ids que aparecen en la lista.

Respondé ÚNICAMENTE con JSON válido, sin texto adicional, con esta forma exacta:
{"coincidencias":[{"id":<id de la presentación>,"busqueda":<número de búsqueda>,"motivo":"<máximo 8 palabras>"}]}
Si ninguna corresponde: {"coincidencias":[]}`;

  const usuario = `BÚSQUEDAS:
${busquedas.map((b, i) => `${i + 1}. ${b}`).join('\n')}

PRESENTACIONES (id | descripción):
${items.map(it => `${it.id} | ${it.texto}`).join('\n')}`;

  return [
    { role: 'system', content: sistema },
    { role: 'user', content: usuario },
  ];
}

const ESQUEMA = {
  type: 'object',
  properties: {
    coincidencias: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          busqueda: { type: 'integer' },
          motivo: { type: 'string' },
        },
        required: ['id', 'busqueda'],
      },
    },
  },
  required: ['coincidencias'],
};

async function llamarCloudflare(env, mensajes) {
  const modelo = env.CF_MODEL || MODELO_CF_POR_DEFECTO;
  const base = { messages: mensajes, max_tokens: 3000, temperature: 0 };
  let r;
  try {
    r = await env.AI.run(modelo, { ...base, response_format: { type: 'json_schema', json_schema: ESQUEMA } });
  } catch (e) {
    // Si el cupo diario se agotó, no tiene sentido reintentar con el mismo proveedor.
    if (/allocation|neurons|quota|4006/i.test(String(e.message || e))) throw e;
    // Algunos modelos no soportan JSON mode: reintentar sin él.
    r = await env.AI.run(modelo, base);
  }
  const salida = r && (r.response !== undefined ? r.response : r);
  return salida;
}

async function llamarOpenAICompat(endpoint, key, modelo, mensajes) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: modelo,
      messages: mensajes,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Acepta un objeto ya parseado o un texto con JSON adentro, y lo limpia.
function normalizarRespuesta(crudo, idsValidos, cantBusquedas) {
  let obj = crudo;
  if (typeof crudo === 'string') {
    const texto = crudo.replace(/```(?:json)?/gi, '').trim();
    const ini = texto.indexOf('{');
    const fin = texto.lastIndexOf('}');
    if (ini === -1 || fin === -1) throw new Error('La IA no devolvió JSON: ' + texto.slice(0, 120));
    obj = JSON.parse(texto.slice(ini, fin + 1));
  }
  const lista = Array.isArray(obj?.coincidencias) ? obj.coincidencias : Array.isArray(obj) ? obj : null;
  if (!lista) throw new Error('Formato de respuesta inesperado');

  const vistos = new Set();
  const salida = [];
  for (const c of lista) {
    const id = Number(c.id);
    const busqueda = Number(c.busqueda);
    if (!idsValidos.has(id)) continue;
    if (!Number.isInteger(busqueda) || busqueda < 1 || busqueda > cantBusquedas) continue;
    const clave = id + ':' + busqueda;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push({ id, busqueda, motivo: String(c.motivo || '').slice(0, 120) });
  }
  return salida;
}
