import { app, safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";

// The refresh token is long-lived and grants full account access, so it is
// encrypted at rest with the OS keychain (Keychain / libsecret / DPAPI) via
// safeStorage. Where no keychain backend is available we fall back to a
// 0600 plaintext file and say so.

const storeFile = () => path.join(app.getPath("userData"), "session.bin");

export function saveRefreshToken(token: string): void {
  const encrypted = safeStorage.isEncryptionAvailable();
  const buf = encrypted
    ? safeStorage.encryptString(token)
    : Buffer.from(`plain:${token}`, "utf8");
  fs.writeFileSync(storeFile(), buf, { mode: 0o600 });
  if (!encrypted) {
    console.warn(
      "[session-store] no OS keychain available; refresh token stored unencrypted (0600)"
    );
  }
}

export function loadRefreshToken(): string | undefined {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(storeFile());
  } catch {
    return undefined;
  }
  const asText = buf.toString("utf8");
  if (asText.startsWith("plain:")) return asText.slice("plain:".length);
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(buf);
  } catch {
    return undefined;
  }
}

export function clearRefreshToken(): void {
  try {
    fs.unlinkSync(storeFile());
  } catch {
    // already gone
  }
}
