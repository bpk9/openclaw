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

function getKeyPath(): string {
  return path.join(process.env.HOME || ".", ".openclaw", "encryption.key");
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  // Option 1: Environment variable
  const envKey = process.env.OPENCLAW_ENCRYPTION_KEY;
  if (envKey) {
    cachedKey = /^[0-9a-f]{64}$/i.test(envKey)
      ? Buffer.from(envKey, "hex")
      : crypto.pbkdf2Sync(envKey, "openclaw-salt", 100000, 32, "sha256");
    return cachedKey;
  }

  // Option 2: Key file (auto-generate if missing)
  const keyPath = getKeyPath();
  if (fs.existsSync(keyPath)) {
    cachedKey = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "hex");
    return cachedKey;
  }

  // Generate new key
  cachedKey = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, cachedKey.toString("hex"), { mode: 0o600 });
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
 */
export function loadCredentials<T = unknown>(filepath: string): T | undefined {
  if (!fs.existsSync(filepath)) return undefined;

  const raw = JSON.parse(fs.readFileSync(filepath, "utf8"));

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
 * Returns true if migration occurred.
 */
export function migrateCredentials(filepath: string): boolean {
  if (!fs.existsSync(filepath)) return false;

  const raw = JSON.parse(fs.readFileSync(filepath, "utf8"));
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
    const raw = JSON.parse(fs.readFileSync(filepath, "utf8"));
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
