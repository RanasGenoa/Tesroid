import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { PasswordHasher, TokenGenerator } from "./ports.js";

export class BcryptPasswordHasher implements PasswordHasher {
  hash(pin: string, cost: number): Promise<string> {
    return bcrypt.hash(pin, cost);
  }

  verify(pin: string, hash: string): Promise<boolean> {
    return bcrypt.compare(pin, hash);
  }
}

export class CryptoTokenGenerator implements TokenGenerator {
  generateHexToken(byteLength: number): string {
    return randomBytes(byteLength).toString("hex");
  }
}
