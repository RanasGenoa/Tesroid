import type { preHandlerHookHandler } from "fastify";
import type { AuthServicePort } from "../../domains/auth/ports.js";

const BEARER_HEADER_PATTERN = /^Bearer\s+(\S+)$/i;
const IPV4_LOOPBACK_OCTETS = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PROXY_CLIENT_HEADERS = [
  "x-forwarded-for",
  "cf-connecting-ip",
  "x-real-ip",
  "forwarded",
] as const;

function isValidIpv4Loopback(candidate: string): boolean {
  const match = IPV4_LOOPBACK_OCTETS.exec(candidate);
  if (match === null) {
    return false;
  }
  return [match[1], match[2], match[3]].every((part) => {
    const octet = Number(part);
    return Number.isInteger(octet) && octet >= 0 && octet <= 255;
  });
}

function hasForwardingHeaders(headers: Record<string, unknown>): boolean {
  for (const name of PROXY_CLIENT_HEADERS) {
    const value = headers[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return true;
    }
    if (
      Array.isArray(value) &&
      value.some((item) => typeof item === "string" && item.trim().length > 0)
    ) {
      return true;
    }
  }
  return false;
}

// Spec: docs/specs/01-auth-security.md#2.1
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (typeof remoteAddress !== "string") {
    return false;
  }
  const normalized = remoteAddress.trim().toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isValidIpv4Loopback(normalized.slice("::ffff:".length));
  }
  return isValidIpv4Loopback(normalized);
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
    const socketRemote = request.socket?.remoteAddress;
    const isDirectLoopback =
      !hasForwardingHeaders(request.headers) &&
      isLoopbackAddress(request.ip) &&
      (socketRemote === undefined || isLoopbackAddress(socketRemote));

    if (isDirectLoopback) {
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
