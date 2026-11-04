// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test app: a dependency-free stand-in for the parts of Express the runtime test needs.

const http = require("node:http");
const fs = require("node:fs");

function express() {
  const routes = [];
  const app = {
    use() {},
    get: (path, handler) => routes.push({ method: "GET", path, handler }),
    post: (path, handler) => routes.push({ method: "POST", path, handler }),
    listen(port, host) {
      return http
        .createServer((req, res) => {
          let raw = "";
          req.on("data", (c) => (raw += c));
          req.on("end", () => {
            const url = new URL(req.url, "http://x");
            const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
            req.query = Object.fromEntries(url.searchParams);
            try {
              req.body = raw ? JSON.parse(raw) : {};
            } catch {
              req.body = {};
            }
            res.status = (code) => ((res.statusCode = code), res);
            res.json = (v) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(v)));
            res.send = (v) => res.end(String(v));
            res.cookie = (name, value) => res.setHeader("set-cookie", `${name}=${value}; Path=/`);
            res.sendFile = (p) => {
              res.setHeader("content-type", p.endsWith(".js") ? "text/javascript" : "text/html");
              res.end(fs.readFileSync(p));
            };
            if (!route) return res.status(404).json({ error: "not found" });
            route.handler(req, res);
          });
        })
        .listen(port, host);
    },
  };
  return app;
}
express.json = () => (req, res, next) => next();

module.exports = express;
