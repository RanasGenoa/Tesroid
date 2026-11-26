import { SharedValidationError } from "@tesroid/shared";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppContainer } from "../../app/index.js";
import { AuthDomainError } from "../../domains/auth/errors.js";
import { SettingsDomainError } from "../../domains/settings/errors.js";
import type { ServerEnvConfig } from "../../infra/index.js";
import { registerAuthAndSettingsRoutes } from "./routes-auth-settings.js";

// Spec: docs/architecture.md#1.3
export function createHttpServer(container: AppContainer): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SettingsDomainError || error instanceof AuthDomainError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof SharedValidationError) {
      return reply.code(400).send({
        error: error.message,
        code: error.code,
      });
    }
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { readonly statusCode?: unknown }).statusCode
        : undefined;
    if (statusCode === 400) {
      return reply.code(400).send({
        error: "Bad request",
        code: "BAD_REQUEST",
      });
    }
    return reply.code(500).send({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  });

  registerAuthAndSettingsRoutes(app, container);
  return app;
}

// Spec: docs/architecture.md#1.3
export function startServer(env?: ServerEnvConfig): Promise<{
  readonly app: FastifyInstance;
  readonly container: AppContainer;
}> {
  throw new Error("NOT_IMPLEMENTED");
}
