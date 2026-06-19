import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY not set');
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const loadConfig  = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
const saveConfig  = (data) => writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');

// ── Database ──────────────────────────────────────────────────────────────────

const pool = mysql.createPool({
  host:            process.env.DB_HOST     || 'localhost',
  port:            Number(process.env.DB_PORT) || 3306,
  user:            process.env.DB_USER     || 'root',
  password:        process.env.DB_PASSWORD || '',
  database:        process.env.DB_NAME     || 'receptionist',
  waitForConnections: true,
  connectionLimit: 10,
});

async function initDB() {
  for (let i = 0; i < 15; i++) {
    try {
      const conn = await pool.getConnection();
      conn.release();
      break;
    } catch {
      if (i === 14) throw new Error('Cannot connect to MySQL after 15 attempts');
      console.log(`MySQL not ready, retrying in 3s... (${i + 1}/15)`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS appointments (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      client_name      VARCHAR(255) NOT NULL,
      phone            VARCHAR(50)  NOT NULL,
      date             VARCHAR(10)  NOT NULL,
      time             VARCHAR(5)   NOT NULL,
      duration_minutes INT          NOT NULL,
      notes            TEXT,
      created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_date (date)
    )
  `);

  console.log('Database ready');
}

// ── Slot helpers ──────────────────────────────────────────────────────────────

function generateSlots(config, durationMinutes) {
  const startMin = config.businessHours.start * 60;
  const endMin   = config.businessHours.end   * 60;
  const lunchS   = config.lunchHour * 60;
  const lunchE   = lunchS + 60;

  const slots = [];
  let t = startMin;
  while (t + durationMinutes <= endMin) {
    const end = t + durationMinutes;
    if (t < lunchE && end > lunchS) { t = lunchE; continue; }
    slots.push(`${String(Math.floor(t / 60)).padStart(2,'0')}:${String(t % 60).padStart(2,'0')}`);
    t += durationMinutes;
  }
  return slots;
}

const timeToMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

async function getAvailableSlots(date, durationMinutes) {
  const config = loadConfig();
  const all    = generateSlots(config, durationMinutes);
  const [booked] = await pool.execute(
    'SELECT time, duration_minutes FROM appointments WHERE date = ?', [date]
  );
  return all.filter(slot => {
    const s = timeToMin(slot), e = s + durationMinutes;
    return !booked.some(b => {
      const bs = timeToMin(b.time), be = bs + b.duration_minutes;
      return s < be && e > bs;
    });
  });
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Token
app.post('/api/token', async (req, res) => {
  try {
    const now    = new Date();
    const expire = new Date(now.getTime() + 30 * 60 * 1000);
    const newSes = new Date(now.getTime() +  5 * 60 * 1000);

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uses: 1, expireTime: expire.toISOString(), newSessionExpireTime: newSes.toISOString() }),
      }
    );
    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: `${r.status}: ${body}` });
    }
    const token = await r.json();
    res.json({ token: token.name, expires_at: expire.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Config
app.get('/api/config', (req, res) => res.json(loadConfig()));
app.put('/api/config', (req, res) => {
  try {
    const updated = { ...loadConfig(), ...req.body };
    saveConfig(updated);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Appointments
app.get('/api/appointments', async (req, res) => {
  try {
    const { month } = req.query;
    const [rows] = month
      ? await pool.execute('SELECT * FROM appointments WHERE date LIKE ? ORDER BY date, time', [`${month}%`])
      : await pool.execute('SELECT * FROM appointments ORDER BY date, time');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const cfg = loadConfig();
    const { client_name, phone, date, time, notes = '' } = req.body;
    const duration_minutes = req.body.duration_minutes || cfg.slotDurationMinutes;
    if (!client_name || !phone || !date || !time)
      return res.status(400).json({ error: 'Faltan campos requeridos: client_name, phone, date, time' });

    const available = await getAvailableSlots(date, duration_minutes);
    if (!available.includes(time))
      return res.status(409).json({ error: `Horario ${time} no disponible para el ${date}` });

    const [result] = await pool.execute(
      'INSERT INTO appointments (client_name, phone, date, time, duration_minutes, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [client_name, phone, date, time, duration_minutes, notes]
    );
    const [rows] = await pool.execute('SELECT * FROM appointments WHERE id = ?', [result.insertId]);
    console.log('Appointment created:', rows[0]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/appointments/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM appointments WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Cita no encontrada' });

    const current = rows[0];
    const updated = { ...current, ...req.body };

    // If date/time/duration changed, validate availability excluding this appointment
    const scheduleChanged =
      updated.date !== current.date ||
      updated.time !== current.time ||
      updated.duration_minutes !== current.duration_minutes;

    if (scheduleChanged) {
      const cfg = loadConfig();
      const all = generateSlots(cfg, updated.duration_minutes);
      if (!all.includes(updated.time))
        return res.status(409).json({ error: `Horario ${updated.time} no es un slot válido` });

      const [booked] = await pool.execute(
        'SELECT time, duration_minutes FROM appointments WHERE date = ? AND id != ?',
        [updated.date, req.params.id]
      );
      const s = timeToMin(updated.time), e = s + updated.duration_minutes;
      const conflict = booked.some(b => {
        const bs = timeToMin(b.time), be = bs + b.duration_minutes;
        return s < be && e > bs;
      });
      if (conflict)
        return res.status(409).json({ error: `Horario ${updated.time} del ${updated.date} ya está ocupado` });
    }

    await pool.execute(
      'UPDATE appointments SET client_name=?, phone=?, date=?, time=?, duration_minutes=?, notes=? WHERE id=?',
      [updated.client_name, updated.phone, updated.date, updated.time, updated.duration_minutes, updated.notes ?? '', req.params.id]
    );
    const [fresh] = await pool.execute('SELECT * FROM appointments WHERE id = ?', [req.params.id]);
    res.json(fresh[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/appointments/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM appointments WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Cita no encontrada' });
    await pool.execute('DELETE FROM appointments WHERE id = ?', [req.params.id]);
    res.json({ ok: true, deleted: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Availability
app.get('/api/availability', async (req, res) => {
  try {
    const { date, duration } = req.query;
    if (!date || !duration) return res.status(400).json({ error: 'date y duration requeridos' });
    const slots = await getAvailableSlots(date, Number(duration));
    res.json({ date, duration_minutes: Number(duration), slots });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SPA fallback
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ── Start ─────────────────────────────────────────────────────────────────────

initDB()
  .then(() => app.listen(PORT, () => console.log(`Receptionist → http://localhost:${PORT}`)))
  .catch(err => { console.error(err); process.exit(1); });
