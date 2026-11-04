// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test app with planted runtime problems. Do not use as a reference.

const path = require("node:path");
const express = require("./mini-express");

const app = express();
app.use(express.json());
const WEB = path.join(__dirname, "..", "web");

app.get("/", (req, res) => res.sendFile(path.join(WEB, "index.html")));
app.get("/about", (req, res) => res.sendFile(path.join(WEB, "about.html")));
app.get("/app.js", (req, res) => res.sendFile(path.join(WEB, "app.js")));

app.get("/api/users", (req, res) => {
  res.json([{ id: 1, name: "Ada", email: "ada@example.com", password_hash: "$2b$12$abcdefghijklmnopqrstuv" }]);
});

app.post("/api/login", (req, res) => {
  console.log("login attempt", req.body.email, req.body.password);
  res.cookie("session", "s-" + Date.now());
  res.json({ token: "tok-" + Date.now() });
});

app.listen(Number(process.env.PORT || 47123), "127.0.0.1");
