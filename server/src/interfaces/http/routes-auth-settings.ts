import {
  type SessionRole,
  type SettingsUpdateInput,
  type SetupRequestInput,
  toPublicSettings,
} from "@tesroid/shared";
import type { FastifyInstance } from "fastify";
import type { AppContainer } from "../../app/index.js";
import { createRequireBearerHook } from "./auth-middleware.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PIN_VERIFY_FAILURE_MESSAGES = {
  EMPTY_PIN: "PIN is required",
  NOT_SETUP: "Initial setup has not been completed",
  INVALID_PIN: "Invalid PIN",
  LOCKED: "Authentication locked due to too many failed attempts",
} as const;

// Spec: docs/specs/01-auth-security.md#2.1
export function registerAuthAndSettingsRoutes(app: FastifyInstance, container: AppContainer): void {
  const requireBearer = createRequireBearerHook(container.auth);

  app.get("/api/status", () => {
    return container.coordinator.getSystemStatus();
  });

  app.post("/api/setup", async (request) => {
    return container.coordinator.completeSetup(request.body as SetupRequestInput);
  });

  app.post("/api/auth/verify", async (request, reply) => {
    const body = request.body;
    const bodyRecord = isRecord(body) ? body : {};

    let role: Extract<SessionRole, "PRIMARY" | "SECONDARY_STREAMING"> = "PRIMARY";
    if (bodyRecord.role !== undefined) {
      if (bodyRecord.role !== "PRIMARY" && bodyRecord.role !== "SECONDARY_STREAMING") {
        return reply.code(400).send({
          ok: false,
          code: "INVALID_ROLE",
          error: "Invalid session role",
        });
      }
      role = bodyRecord.role;
    }

    const pin = typeof bodyRecord.pin === "string" ? bodyRecord.pin : "";
    const result = await container.auth.verifyPin(pin, role);
    if (result.ok) {
      return {
        ok: true,
        token: result.token,
        role: result.role,
      };
    }

    return reply.code(result.statusCode).send({
      ok: false,
      code: result.reason,
      error: PIN_VERIFY_FAILURE_MESSAGES[result.reason],
      remainingAttempts: result.remainingAttempts,
    });
  });

  app.get("/api/settings", { preHandler: requireBearer }, () => {
    return toPublicSettings(container.settings.getCurrent());
  });

  app.put("/api/settings", { preHandler: requireBearer }, async (request) => {
    return container.coordinator.updateSettings(request.body as SettingsUpdateInput);
  });
}
