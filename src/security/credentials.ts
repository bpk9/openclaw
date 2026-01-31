/**
 * Credential encryption - simplified to essential functions only.
 *
 * Usage:
 *   import { loadCredentials, saveCredentials } from "./security/credentials.js";
 *
 *   const data = await loadCredentials("auth.json");
 *   await saveCredentials("auth.json", { apiKey: "secret" });
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EncryptedData {
  version: 2;
  iv: string;
  authTag: string;
  data: string;
}

// Legacy format (v1 of this PR) - nested encryption object
interface LegacyEncryptedData {
  version: 2;
  encryption: { algorithm: string; iv: string; authTag: string };
  data: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Key Management (internal)
// ─────────────────────────────────────────────────────────────────────────────

let cachedKey: Buffer | null = null;

// PBKDF2 iterations: OWASP recommends 600,000+ for SHA-256 (as of 2023)
const PBKDF2_ITERATIONS = 600000;

function getKeyPath(): string {
  return path.join(process.env.HOME || ".", ".openclaw", "encryption.key");
}

function getSaltPath(): string {
  return path.join(process.env.HOME || ".", ".openclaw", "encryption.salt");
}

function getOrCreateSalt(): Buffer {
  const saltPath = getSaltPath();
  if (fs.existsSync(saltPath)) {
    const stats = fs.lstatSync(saltPath);
    if (stats.isSymbolicLink()) {
      throw new Error("Salt file cannot be a symbolic link");
    }
    return Buffer.from(fs.readFileSync(saltPath, "utf8").trim(), "hex");
  }

  // Generate random salt
  const salt = crypto.randomBytes(32);
  const dir = path.dirname(saltPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(saltPath, salt.toString("hex"), { mode: 0o600 });
  return salt;
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  // Option 1: Environment variable
  const envKey = process.env.OPENCLAW_ENCRYPTION_KEY;
  if (envKey) {
    if (/^[0-9a-f]{64}$/i.test(envKey)) {
      // Direct hex key - no derivation needed
      cachedKey = Buffer.from(envKey, "hex");
    } else {
      // Password - derive with random salt
      const salt = getOrCreateSalt();
      cachedKey = crypto.pbkdf2Sync(envKey, salt, PBKDF2_ITERATIONS, 32, "sha256");
    }
    return cachedKey;
  }

  // Option 2: Key file (auto-generate if missing)
  const keyPath = getKeyPath();
  if (fs.existsSync(keyPath)) {
    // Check for symlink attack
    const stats = fs.lstatSync(keyPath);
    if (stats.isSymbolicLink()) {
      throw new Error("Key file cannot be a symbolic link");
    }
    cachedKey = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "hex");
    return cachedKey;
  }

  // Generate new key with exclusive file creation to prevent race conditions
  cachedKey = crypto.randomBytes(32);
  const dir = path.dirname(keyPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Use O_EXCL to fail if file already exists (race condition protection)
  const fd = fs.openSync(
    keyPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeSync(fd, cachedKey.toString("hex"));
  } finally {
    fs.closeSync(fd);
  }
  return cachedKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core encrypt/decrypt
// ─────────────────────────────────────────────────────────────────────────────

function encrypt(data: unknown): EncryptedData {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(JSON.stringify(data), "utf8", "base64");
  encrypted += cipher.final("base64");

  return {
    version: 2,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    data: encrypted,
  };
}

function decrypt(blob: EncryptedData | LegacyEncryptedData): unknown {
  if (blob.version !== 2) {
    throw new Error(`Unsupported version: ${blob.version}`);
  }

  const normalized = normalizeBlob(blob);
  const key = getKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(normalized.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(normalized.authTag, "base64"));

  let decrypted = decipher.update(normalized.data, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return JSON.parse(decrypted);
}

function isEncryptedBlob(data: unknown): data is EncryptedData | LegacyEncryptedData {
  const obj = data as Record<string, unknown>;
  if (obj?.version !== 2 || typeof obj?.data !== "string") return false;

  // New flat format
  if (typeof obj?.iv === "string" && typeof obj?.authTag === "string") {
    return true;
  }

  // Legacy nested format
  const enc = obj?.encryption as Record<string, unknown> | undefined;
  return typeof enc?.iv === "string" && typeof enc?.authTag === "string";
}

function normalizeBlob(blob: EncryptedData | LegacyEncryptedData): EncryptedData {
  if ("iv" in blob && typeof blob.iv === "string") {
    return blob as EncryptedData;
  }
  // Legacy format - flatten it
  const legacy = blob as LegacyEncryptedData;
  return {
    version: 2,
    iv: legacy.encryption.iv,
    authTag: legacy.encryption.authTag,
    data: legacy.data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a JSON file, decrypting if encrypted.
 * Returns undefined for missing files or empty/invalid JSON.
 */
export function loadCredentials<T = unknown>(filepath: string): T | undefined {
  if (!fs.existsSync(filepath)) return undefined;

  const content = fs.readFileSync(filepath, "utf8").trim();
  if (!content) return undefined; // Empty file

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    // Invalid JSON - return undefined rather than crashing
    return undefined;
  }

  if (isEncryptedBlob(raw)) {
    return decrypt(raw) as T;
  }
  return raw as T;
}

/**
 * Save data to a JSON file, encrypting it.
 */
export function saveCredentials(filepath: string, data: unknown): void {
  const encrypted = encrypt(data);
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filepath, JSON.stringify(encrypted, null, 2) + "\n", "utf8");
  fs.chmodSync(filepath, 0o600);
}

/**
 * Migrate a plaintext file to encrypted (no-op if already encrypted).
 * Returns true if migration occurred, false if already encrypted or invalid.
 */
export function migrateCredentials(filepath: string): boolean {
  if (!fs.existsSync(filepath)) return false;

  const content = fs.readFileSync(filepath, "utf8").trim();
  if (!content) return false; // Empty file

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return false; // Invalid JSON
  }

  if (isEncryptedBlob(raw)) return false; // Already encrypted

  // Backup, then encrypt
  fs.copyFileSync(filepath, `${filepath}.bak`);
  saveCredentials(filepath, raw);
  return true;
}

/**
 * Check if a file is encrypted.
 */
export function isEncrypted(filepath: string): boolean {
  if (!fs.existsSync(filepath)) return false;
  try {
    const content = fs.readFileSync(filepath, "utf8").trim();
    if (!content) return false;
    const raw = JSON.parse(content);
    return isEncryptedBlob(raw);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Testing utilities
// ─────────────────────────────────────────────────────────────────────────────

/** @internal Clear cached key (for tests only) */
export function _resetKeyCache(): void {
  cachedKey = null;
}
