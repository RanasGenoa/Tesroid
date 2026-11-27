import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

// Spec: docs/specs/01-auth-security.md#2（静的フロントエンド配信は Bearer 認証不要の公開境界）
export function registerStaticFrontend(app: FastifyInstance, rootDir: string): void {
  app.register(fastifyStatic, {
    root: rootDir,
    prefix: "/",
    index: ["index.html"],
    // プラグ既定の Cache-Control を無効化し、setHeaders を単一の書き込み元にしておく。
    cacheControl: false,
    setHeaders: (res, filePath) => {
      // Vite のハッシュ付き assets は内容アドレス指定のため不変キャッシュ、index.html は每次都座検定で新バンドルハッシュを反映する。
      if (filePath.startsWith(path.join(rootDir, "assets"))) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  });
}
