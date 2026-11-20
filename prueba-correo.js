require('dotenv').config();
const nodemailer = require('nodemailer');

const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

transporte
    .sendMail({ from: process.env.MAIL_FROM, to: 'decano@test.com', subject: 'Prueba', text: 'Si ves esto, el correo funciona.' })
    .then(() => console.log('Enviado: mirá la bandeja de Mailtrap'))
    .catch((e) => console.error('Falló:', e.message));