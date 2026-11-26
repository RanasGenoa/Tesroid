import type { FastifyInstance } from "fastify";
import type { AppContainer } from "../../app/index.js";
import type { ServerEnvConfig } from "../../infra/index.js";

// Spec: docs/architecture.md#1.3
export function createHttpServer(container: AppContainer): FastifyInstance {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/architecture.md#1.3
export function startServer(env?: ServerEnvConfig): Promise<{
  readonly app: FastifyInstance;
  readonly container: AppContainer;
}> {
  throw new Error("NOT_IMPLEMENTED");
}
