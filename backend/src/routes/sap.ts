import express, { Router, Request, Response } from "express";
import https from "https";
import http from "http";
import { SAP_TIMEOUT_MS, SAP_MAX_BYTES } from "../config.js";

const router = Router();

const userAgent =
  "Configurator/2.17 (Macintosh; OS X 15.2; 24C5089c) AppleWebKit/0620.1.16.11.6";

// SAP 签名 setup 请求只有两个合法端点（白名单），其余一律拒绝。
// 代理走 Node 原生 HTTPS：fpinit.itunes.apple.com 要求 TLS 1.3，
// 浏览器侧 wasm TLS（node-forge）不支持，因此无法像其他 Apple 请求那样
// 从前端直连（curl 错误码 35: SSL connect error）。
const CERTIFICATE_URL = "https://s.mzstatic.com/sap/setupCert.plist";
const SETUP_URL = "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy";

function resolveTarget(req: Request): string {
  const raw = req.query.url as string | undefined;
  if (!raw) {
    throw new Error("url is not an allowed SAP endpoint");
  }
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("url is not an allowed SAP endpoint");
  }
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new Error("url is not an allowed SAP endpoint");
  }
  if (req.method === "GET" && target.href === CERTIFICATE_URL) {
    return target.href;
  }
  if (req.method === "POST" && target.href === SETUP_URL) {
    return target.href;
  }
  throw new Error("url is not an allowed SAP endpoint");
}

function forward(req: Request, target: string): Promise<{ status: number | undefined; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const isPost = req.method === "POST";
    const headers: Record<string, string> = { "User-Agent": userAgent };
    if (isPost) {
      headers["Content-Type"] = "application/x-plist";
    }
    const request = (target.startsWith("https://") ? https : http).request(
      target,
      {
        method: req.method,
        headers,
        timeout: SAP_TIMEOUT_MS,
      },
      (resp) => {
        const chunks: Buffer[] = [];
        let total = 0;
        resp.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > SAP_MAX_BYTES) {
            request.destroy();
            reject(new Error("SAP response too large"));
            return;
          }
          chunks.push(chunk);
        });
        resp.on("end", () => {
          resolve({
            status: resp.statusCode,
            contentType: resp.headers["content-type"] ?? "",
            body: Buffer.concat(chunks),
          });
        });
        resp.on("error", reject);
      },
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("SAP request timed out"));
    });
    if (isPost) {
      request.end(req.body as Buffer);
    } else {
      request.end();
    }
  });
}

router.get(
  "/sap",
  async (req: Request, res: Response) => {
    try {
      const target = resolveTarget(req);
      const upstream = await forward(req, target);
      if (upstream.contentType) {
        res.set("Content-Type", upstream.contentType);
      }
      res.status(upstream.status ?? 502).send(upstream.body);
    } catch (err) {
      console.error("SAP proxy error:", err instanceof Error ? err.message : err);
      res.status(502).json({ error: "SAP request failed" });
    }
  },
);

// application/x-plist 原始字节：必须用 raw 中间件（全局 json 解析器不处理该类型）
router.post(
  "/sap",
  express.raw({ type: "application/x-plist", limit: "1mb" }),
  async (req: Request, res: Response) => {
    try {
      const target = resolveTarget(req);
      if (!req.body || !(req.body instanceof Buffer) || req.body.length === 0) {
        res.status(400).json({ error: "Missing request body" });
        return;
      }
      const upstream = await forward(req, target);
      if (upstream.contentType) {
        res.set("Content-Type", upstream.contentType);
      }
      res.status(upstream.status ?? 502).send(upstream.body);
    } catch (err) {
      console.error("SAP proxy error:", err instanceof Error ? err.message : err);
      res.status(502).json({ error: "SAP request failed" });
    }
  },
);

export default router;
