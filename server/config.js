'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const DATA_DIR = path.join(ROOT, 'data');

// Muat .env lalu pastikan kunci penting tersedia.
fs.mkdirSync(DATA_DIR, { recursive: true });

if (fs.existsSync(ENV_FILE)) dotenv.config({ path: ENV_FILE });

const DEFAULTS = {
  PORT: 3000,
  HOST: '0.0.0.0',
  ADMIN_USER: 'admin',
  ADMIN_PASS: '',
  SESSION_SECRET: '',
  SESSION_TTL_MINUTES: 480,
  SSH_TTL_MINUTES: 30,
  MAX_SESSIONS_PER_USER: 5,
  CONNECT_TIMEOUT_MS: 20000,
  TRUST_HOST_KEY: 'tofu',
};

const env = { ...DEFAULTS, ...process.env };

// --- Password admin: generate sekali lalu simpan ke .env --------------------
if (!env.ADMIN_PASS || !env.SESSION_SECRET) {
  const generated = [];
  if (!env.ADMIN_PASS) {
    env.ADMIN_PASS = crypto.randomBytes(9).toString('base64url');
    generated.push(['ADMIN_PASS', env.ADMIN_PASS]);
  }
  if (!env.SESSION_SECRET) {
    env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    generated.push(['SESSION_SECRET', env.SESSION_SECRET]);
  }
  persistEnv(generated);
}

function persistEnv(pairs) {
  let body = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  for (const [key, value] of pairs) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    body = re.test(body) ? body.replace(re, line) : `${body.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(ENV_FILE, body.trimStart());
  console.log('  .env diperbarui otomatis.');
}

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

module.exports = {
  ROOT,
  DATA_DIR,
  KNOWN_HOSTS_FILE: path.join(DATA_DIR, 'known_hosts.json'),
  PORT: toInt(env.PORT, 3000),
  HOST: env.HOST,
  ADMIN_USER: env.ADMIN_USER,
  ADMIN_PASS: env.ADMIN_PASS,
  SESSION_SECRET: env.SESSION_SECRET,
  SESSION_TTL_MINUTES: toInt(env.SESSION_TTL_MINUTES, 480),
  SSH_TTL_MINUTES: toInt(env.SSH_TTL_MINUTES, 30),
  MAX_SESSIONS_PER_USER: toInt(env.MAX_SESSIONS_PER_USER, 5),
  CONNECT_TIMEOUT_MS: toInt(env.CONNECT_TIMEOUT_MS, 20000),
  TRUST_HOST_KEY: env.TRUST_HOST_KEY,
  PUBLIC_DIR: path.join(ROOT, 'public'),
};