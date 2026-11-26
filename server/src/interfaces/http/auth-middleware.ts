import type { preHandlerHookHandler } from "fastify";
import type { AuthServicePort } from "../../domains/auth/ports.js";

const BEARER_HEADER_PATTERN = /^Bearer\s+(\S+)$/i;

// Spec: docs/specs/01-auth-security.md#2.1
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (typeof remoteAddress !== "string") {
    return false;
  }
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.")
  );
}

// Spec: docs/specs/01-auth-security.md#2.1
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (typeof authorizationHeader !== "string") {
    return null;
  }
  const match = BEARER_HEADER_PATTERN.exec(authorizationHeader.trim());
  return match?.[1] ?? null;
}

// Spec: docs/specs/01-auth-security.md#2.1
export function createRequireBearerHook(auth: AuthServicePort): preHandlerHookHandler {
  return async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    if (token === null || auth.verifyToken(token) === null) {
      return reply.code(401).send({
        error: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }
  };
}

// Spec: docs/specs/08-observability.md#2.1
export function createLoopbackOrBearerHook(auth: AuthServicePort): preHandlerHookHandler {
  return async (request, reply) => {
    if (isLoopbackAddress(request.ip) || isLoopbackAddress(request.socket.remoteAddress)) {
      return;
    }
    const token = extractBearerToken(request.headers.authorization);
    if (token === null || auth.verifyToken(token) === null) {
      return reply.code(401).send({
        error: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }
  };
}
