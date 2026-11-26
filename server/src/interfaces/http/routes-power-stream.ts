import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { AppContainer } from "../../app/index.js";
import { extractBearerToken } from "./auth-middleware.js";

function createRequirePrimaryAuthorityHook(container: AppContainer): preHandlerHookHandler {
  return async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const tokenRecord = token === null ? null : container.auth.verifyToken(token);
    if (token === null || tokenRecord === null) {
      return reply.code(401).send({
        error: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const authority = container.session.getPrimaryAuthority();
    const isPrimaryOrActing =
      tokenRecord.role === "PRIMARY" || (authority !== null && authority.token === token);
    if (!isPrimaryOrActing) {
      return reply.code(403).send({
        ok: false,
        error: "Primary or acting primary role required",
        code: "FORBIDDEN_SECONDARY",
      });
    }
  };
}

// Spec: docs/specs/10-power-lifecycle.md#2.2
export function registerPowerAndStreamRoutes(app: FastifyInstance, container: AppContainer): void {
  const requirePrimaryAuthority = createRequirePrimaryAuthorityHook(container);

  app.get("/api/power/status", () => {
    return container.power.getStatus();
  });

  app.post("/api/power/sleep", { preHandler: requirePrimaryAuthority }, async () => {
    return container.power.sleep();
  });

  app.post("/api/power/resume", { preHandler: requirePrimaryAuthority }, async () => {
    return container.power.resume();
  });

  app.post("/api/power/restart-browser", { preHandler: requirePrimaryAuthority }, async () => {
    return container.power.restartBrowser();
  });

  app.post("/api/stream/reset", { preHandler: requirePrimaryAuthority }, async () => {
    return container.coordinator.resetStream();
  });
}
