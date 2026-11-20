require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');

const PUERTO = process.env.PORT || 3001;
const LARAVEL_URL = process.env.LARAVEL_URL || 'http://127.0.0.1:8000/api';
const VENCE_MS = 10 * 60 * 1000; // el código dura 10 minutos
const MAX_INTENTOS = 5;
const ESPERA_REENVIO_MS = 45 * 1000;

const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: false,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
});

// Verificaciones pendientes, en memoria: id -> { correo, token, codigoHash, venceEn, intentos, ultimoEnvio }
const desafios = new Map();

const hash = (codigo) => crypto.createHash('sha256').update(codigo).digest('hex');
const generarCodigo = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

function enmascarar(correo) {
    const [usuario, dominio] = correo.split('@');
    return `${usuario.slice(0, 2)}***@${dominio}`;
}

async function enviarCodigo(correo, codigo) {
    await transporte.sendMail({
        from: process.env.MAIL_FROM || 'Sistema de Convenios <no-responder@convenios.test>',
        to: correo,
        subject: 'Tu código de verificación',
        text: `Tu código de verificación es ${codigo}.\nVence en 10 minutos. Si no fuiste vos, ignorá este mensaje.`,
    });
}

// Cierra en Laravel un token que nunca llegó a usarse.
function invalidarToken(token) {
    fetch(`${LARAVEL_URL}/logout`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    }).catch(() => {});
}

const buscar = (id) => (typeof id === 'string' ? desafios.get(id) : undefined);

const app = express();
app.use(express.json());

app.get('/salud', (req, res) => res.json({ ok: true }));

// Paso 1: correo y contraseña. Se validan contra Laravel, pero el token NO se entrega todavía.
app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return res.status(422).json({ mensaje: 'Ingresá tu correo y tu contraseña.' });
    }

    let respuesta;
    try {
        respuesta = await fetch(`${LARAVEL_URL}/login`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        });
    } catch {
        return res.status(502).json({ mensaje: 'No se pudo conectar con la API.' });
    }

    if (respuesta.status === 401 || respuesta.status === 422) {
        return res.status(401).json({ mensaje: 'Correo o contraseña incorrectos.' });
        
    }
    if (!respuesta.ok) return res.status(502).json({ mensaje: 'La API tuvo un problema. Intentá de nuevo.' });

    const datos = await respuesta.json().catch(() => null);
    if (!datos || !datos.token) return res.status(502).json({ mensaje: 'La API no devolvió un token.' });
      // La API ahora devuelve también los datos del usuario junto con el token.
    const usuario = datos.user ?? datos.usuario ?? (datos.data ? datos.data.user : null) ?? null;
    const desafioId = crypto.randomUUID();
    const codigo = generarCodigo();
    desafios.set(desafioId, {
        correo: email,
        token: datos.token,
        usuario,
        codigoHash: hash(codigo),
        venceEn: Date.now() + VENCE_MS,
        intentos: 0,
        ultimoEnvio: Date.now(),
    });

    try {
        await enviarCodigo(email, codigo);
    } catch (e) {
        console.error(e);
        invalidarToken(datos.token);
        desafios.delete(desafioId);
        return res.status(502).json({ mensaje: 'No se pudo enviar el correo con el código.' });
    }

    res.json({ requiereCodigo: true, desafioId, correo: enmascarar(email), venceEnSegundos: VENCE_MS / 1000 });
});

// Paso 2: el código. Recién si es correcto se entrega el token.
app.post('/auth/verificar', (req, res) => {
    const { desafioId, codigo } = req.body || {};
    const d = buscar(desafioId);
    if (!d) return res.status(404).json({ mensaje: 'La verificación no existe o ya venció. Ingresá de nuevo.' });

    if (Date.now() > d.venceEn) {
        return res.status(410).json({ mensaje: 'El código venció. Pedí uno nuevo.', puedeReenviar: true });
    }
    if (d.intentos >= MAX_INTENTOS) {
        return res.status(429).json({ mensaje: 'Superaste los intentos. Pedí un código nuevo.', puedeReenviar: true });
    }

    if (typeof codigo !== 'string' || hash(codigo.trim()) !== d.codigoHash) {
        d.intentos += 1;
        const restantes = Math.max(MAX_INTENTOS - d.intentos, 0);
        return res.status(401).json({
        mensaje: restantes > 0 ? 'Código incorrecto.' : 'Código incorrecto. Superaste los intentos: pedí un código nuevo.',
        intentosRestantes: restantes,
        });
    }

    desafios.delete(desafioId); // un solo uso
    res.json({ token: d.token, usuario: d.usuario });
});

// Reenviar: genera un código nuevo e invalida el anterior.
app.post('/auth/reenviar', async (req, res) => {
    const d = buscar((req.body || {}).desafioId);
    if (!d) return res.status(404).json({ mensaje: 'La verificación no existe o ya venció. Ingresá de nuevo.' });

    const espera = ESPERA_REENVIO_MS - (Date.now() - d.ultimoEnvio);
    if (espera > 0) {
        const segundos = Math.ceil(espera / 1000);
        return res.status(429).json({ mensaje: `Esperá ${segundos} segundos para pedir otro código.`, esperarSegundos: segundos });
    }

    const codigo = generarCodigo();
    d.codigoHash = hash(codigo);
    d.venceEn = Date.now() + VENCE_MS;
    d.intentos = 0;
    d.ultimoEnvio = Date.now();

    try {
        await enviarCodigo(d.correo, codigo);
    } catch (e) {
        console.error(e);
        return res.status(502).json({ mensaje: 'No se pudo enviar el correo con el código.' });
    }
    res.json({ ok: true, venceEnSegundos: VENCE_MS / 1000 });
});

// Limpieza: las verificaciones abandonadas se borran y su token se cierra en Laravel.
setInterval(() => {
    const limite = Date.now() - 30 * 60 * 1000;
    for (const [id, d] of desafios) {
        if (d.venceEn < limite) {
        invalidarToken(d.token);
        desafios.delete(id);
        }
    }
}, 60 * 1000);

app.listen(PUERTO, () => console.log(`Servicio de verificación en el puerto ${PUERTO}`));