import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadCredentials,
  saveCredentials,
  migrateCredentials,
  isEncrypted,
  _resetKeyCache,
} from "./credentials.js";

describe("credentials", () => {
  let tempDir: string;
  let testFile: string;
  const originalEnv = process.env.OPENCLAW_ENCRYPTION_KEY;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
    testFile = path.join(tempDir, "test.json");

    // Use a test key via environment
    process.env.OPENCLAW_ENCRYPTION_KEY = "a".repeat(64);
    _resetKeyCache();
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.OPENCLAW_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.OPENCLAW_ENCRYPTION_KEY;
    }
    _resetKeyCache();

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("saveCredentials + loadCredentials", () => {
    it("encrypts and decrypts data", () => {
      const data = { username: "test", apiKey: "secret-123" };

      saveCredentials(testFile, data);
      expect(fs.existsSync(testFile)).toBe(true);

      const loaded = loadCredentials(testFile);
      expect(loaded).toEqual(data);
    });

    it("handles complex nested objects", () => {
      const data = {
        profiles: {
          "openai:default": { type: "api_key", key: "sk-1234" },
          "anthropic:work": { type: "oauth", access: "token" },
        },
        order: { openai: ["default"] },
      };

      saveCredentials(testFile, data);
      expect(loadCredentials(testFile)).toEqual(data);
    });

    it("returns undefined for missing files", () => {
      expect(loadCredentials("/nonexistent/path.json")).toBeUndefined();
    });

    it("produces different ciphertext for same input (random IV)", () => {
      saveCredentials(testFile, { test: "data" });
      const cipher1 = JSON.parse(fs.readFileSync(testFile, "utf8"));

      saveCredentials(testFile, { test: "data" });
      const cipher2 = JSON.parse(fs.readFileSync(testFile, "utf8"));

      expect(cipher1.iv).not.toBe(cipher2.iv);
      expect(cipher1.data).not.toBe(cipher2.data);
    });

    it("sets secure file permissions", () => {
      saveCredentials(testFile, { secret: "value" });
      const stats = fs.statSync(testFile);
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe("isEncrypted", () => {
    it("detects encrypted files", () => {
      saveCredentials(testFile, { secret: "value" });
      expect(isEncrypted(testFile)).toBe(true);
    });

    it("detects plaintext files", () => {
      fs.writeFileSync(testFile, JSON.stringify({ plain: "text" }));
      expect(isEncrypted(testFile)).toBe(false);
    });

    it("returns false for missing files", () => {
      expect(isEncrypted("/nonexistent.json")).toBe(false);
    });
  });

  describe("migrateCredentials", () => {
    it("encrypts plaintext file", () => {
      const data = { username: "test", password: "secret" };
      fs.writeFileSync(testFile, JSON.stringify(data));

      const migrated = migrateCredentials(testFile);

      expect(migrated).toBe(true);
      expect(isEncrypted(testFile)).toBe(true);
      expect(loadCredentials(testFile)).toEqual(data);
    });

    it("creates backup file", () => {
      fs.writeFileSync(testFile, JSON.stringify({ test: "data" }));

      migrateCredentials(testFile);

      expect(fs.existsSync(`${testFile}.bak`)).toBe(true);
    });

    it("skips already-encrypted files", () => {
      saveCredentials(testFile, { already: "encrypted" });

      const migrated = migrateCredentials(testFile);

      expect(migrated).toBe(false);
    });

    it("returns false for missing files", () => {
      expect(migrateCredentials("/nonexistent.json")).toBe(false);
    });
  });

  describe("loadCredentials with plaintext", () => {
    it("loads plaintext files transparently", () => {
      const data = { plain: "text", nested: { value: 123 } };
      fs.writeFileSync(testFile, JSON.stringify(data));

      expect(loadCredentials(testFile)).toEqual(data);
    });
  });

  describe("backward compatibility", () => {
    it("reads legacy nested encryption format", () => {
      // Legacy format from v1 of the PR
      const legacyEncrypted = {
        version: 2,
        encryption: {
          algorithm: "aes-256-gcm",
          iv: "dGVzdGl2MTIzNDU2Nzg=", // "testiv12345678" in base64
          authTag: "", // Will fail decryption but should parse
        },
        data: "encrypted-data",
      };

      fs.writeFileSync(testFile, JSON.stringify(legacyEncrypted));

      // Should detect as encrypted
      expect(isEncrypted(testFile)).toBe(true);
    });
  });

  describe("key derivation", () => {
    it("derives key from password when not hex", () => {
      process.env.OPENCLAW_ENCRYPTION_KEY = "my-secret-password";
      _resetKeyCache();

      // Should work without error
      saveCredentials(testFile, { test: "data" });
      expect(loadCredentials(testFile)).toEqual({ test: "data" });
    });

    it("uses hex key directly when valid", () => {
      process.env.OPENCLAW_ENCRYPTION_KEY = "b".repeat(64);
      _resetKeyCache();

      saveCredentials(testFile, { test: "data" });
      expect(loadCredentials(testFile)).toEqual({ test: "data" });
    });
  });
});
