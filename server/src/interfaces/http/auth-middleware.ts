import type { preHandlerHookHandler } from "fastify";
import type { AuthServicePort } from "../../domains/auth/ports.js";

// Spec: docs/specs/01-auth-security.md#2.1
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/01-auth-security.md#2.1
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/01-auth-security.md#2.1
export function createRequireBearerHook(auth: AuthServicePort): preHandlerHookHandler {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/08-observability.md#2.1
export function createLoopbackOrBearerHook(auth: AuthServicePort): preHandlerHookHandler {
  throw new Error("NOT_IMPLEMENTED");
}
