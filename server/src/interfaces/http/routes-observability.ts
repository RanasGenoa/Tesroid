import type { FastifyInstance } from "fastify";
import type { AppContainer } from "../../app/index.js";
import { sanitizeTelemetrySessionId } from "../../domains/observability/index.js";
import { createLoopbackOrBearerHook } from "./auth-middleware.js";

function parseOptionalLimit(rawLimit: unknown): number | undefined {
  if (typeof rawLimit !== "string" || rawLimit.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(rawLimit);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Spec: docs/specs/08-observability.md#2.1
export function registerObservabilityRoutes(app: FastifyInstance, container: AppContainer): void {
  const requireLoopbackOrBearer = createLoopbackOrBearerHook(container.auth);

  app.get("/api/health", () => {
    return container.coordinator.getHealthStatus();
  });

  app.get("/api/metrics/summary", { preHandler: requireLoopbackOrBearer }, () => {
    return container.metrics.getSummary();
  });

  app.get<{ Querystring: { readonly limit?: string } }>(
    "/api/metrics/history",
    { preHandler: requireLoopbackOrBearer },
    (request) => {
      const limit = parseOptionalLimit(request.query?.limit);
      return container.metrics.getHistory(limit);
    },
  );

  app.get("/api/telemetry/sessions", { preHandler: requireLoopbackOrBearer }, async () => {
    return container.telemetry.listSessions();
  });

  app.get(
    "/api/telemetry/sessions/latest/download",
    { preHandler: requireLoopbackOrBearer },
    async (_request, reply) => {
      const latest = await container.telemetry.readLatestSessionNdjson();
      if (latest === null) {
        return reply.code(404).send({
          error: "Telemetry session not found",
          code: "NOT_FOUND",
        });
      }
      return reply
        .header("content-type", "application/x-ndjson; charset=utf-8")
        .header("content-disposition", `attachment; filename="${latest.sessionId}.jsonl"`)
        .send(latest.content);
    },
  );

  app.get<{ Params: { readonly sessionId: string } }>(
    "/api/telemetry/sessions/:sessionId/download",
    { preHandler: requireLoopbackOrBearer },
    async (request, reply) => {
      const safeId = sanitizeTelemetrySessionId(request.params.sessionId);
      if (safeId === null) {
        return reply.code(404).send({
          error: "Telemetry session not found",
          code: "NOT_FOUND",
        });
      }
      const content = await container.telemetry.readSessionNdjson(safeId);
      if (content === null) {
        return reply.code(404).send({
          error: "Telemetry session not found",
          code: "NOT_FOUND",
        });
      }
      return reply
        .header("content-type", "application/x-ndjson; charset=utf-8")
        .header("content-disposition", `attachment; filename="${safeId}.jsonl"`)
        .send(content);
    },
  );

  app.delete("/api/telemetry/sessions", { preHandler: requireLoopbackOrBearer }, async () => {
    await container.telemetry.deleteAllSessions();
    return { ok: true };
  });
}
