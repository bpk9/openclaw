---
title: Credential Encryption
summary: AES-256-GCM encryption for stored credentials.
permalink: /security/credential-encryption/
---

# Credential Encryption

OpenClaw encrypts stored credentials using AES-256-GCM with per-file random IVs.

## Quick Start

```typescript
import { loadCredentials, saveCredentials, migrateCredentials, isEncrypted } from "./security/credentials.js";

// Save (always encrypts)
saveCredentials("auth.json", { apiKey: "secret" });

// Load (auto-decrypts)
const data = loadCredentials<MyType>("auth.json");

// Migrate existing plaintext file
migrateCredentials("auth.json");

// Check encryption status
isEncrypted("auth.json");
```

## Key Management

**Option 1: Environment variable (recommended for production)**

```bash
export OPENCLAW_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

**Option 2: Auto-generated (simplest)**

If no environment variable is set, a key is created automatically at `~/.openclaw/encryption.key`.

> ⚠️ Use the same key consistently. Changing keys makes previously encrypted credentials unreadable.

## Security Properties

- **AES-256-GCM** with random IV per file
- **Authentication tags** for integrity verification
- **PBKDF2 derivation** if key is not hex
- **Secure file permissions** (0600)

## Migration

Migrate existing plaintext credential files:

```typescript
migrateCredentials("oauth-tokens.json");
// Creates oauth-tokens.json.bak, encrypts original
```

The `loadCredentials` function reads both plaintext and encrypted formats transparently.
