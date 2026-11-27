import { SharedValidationError } from "@tesroid/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { type AppContainer, createAppContainer } from "../../app/index.js";
import { AuthDomainError } from "../../domains/auth/errors.js";
import { SettingsDomainError } from "../../domains/settings/errors.js";
import { ProcessEnvReader, type ServerEnvConfig } from "../../infra/index.js";
import { registerWebSocketGateway } from "../ws/ws-gateway.js";
import { registerAuthAndSettingsRoutes } from "./routes-auth-settings.js";
import { registerObservabilityRoutes } from "./routes-observability.js";
import { registerPowerAndStreamRoutes } from "./routes-power-stream.js";
import { registerStaticFrontend } from "./static.js";

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
  registerPowerAndStreamRoutes(app, container);
  registerObservabilityRoutes(app, container);
  registerWebSocketGateway(app, container);
  registerStaticFrontend(app, container.env.clientDistPath);
  return app;
}

// Spec: docs/architecture.md#1.3
export async function startServer(env?: ServerEnvConfig): Promise<{
  readonly app: FastifyInstance;
  readonly container: AppContainer;
}> {
  const config = env ?? new ProcessEnvReader().read();
  const container = createAppContainer(config);

  try {
    await container.coordinator.initialize();
  } catch (error) {
    await container.dispose();
    throw error;
  }

  const app = createHttpServer(container);
  let disposed = false;
  const disposeOnce = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await container.dispose();
  };

  let closing = false;
  const onSignal = () => {
    if (closing) {
      return;
    }
    closing = true;
    void app.close().finally(() => {
      void disposeOnce();
    });
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  app.addHook("onClose", async () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await disposeOnce();
  });

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (error) {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await disposeOnce();
    throw error;
  }

  return { app, container };
}
