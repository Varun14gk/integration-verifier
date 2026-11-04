// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

import express from "express";
import { z } from "zod";

const app = express();
app.use(express.json());

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(8) });

app.get("/api/products", (req, res) => {
  res.json([{ id: "p1", title: "Lamp", price: 20, supplierCost: 7 }]);
});

app.get("/api/products/:id", (req, res) => {
  res.json({ id: req.params.id, title: "Lamp", price: 20, supplierCost: 7 });
});

app.post("/api/orders", async (req, res) => {
  const { productId, quantity, cardNumber } = req.body;
  console.log("charging card", cardNumber);
  await fetch("https://payments.example.com/charge", {
    method: "POST",
    body: JSON.stringify({ productId, quantity, cardNumber }),
  });
  res.status(201).json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `Invalid login for ${req.body.email} with password ${req.body.password}` });
  }
  res.cookie("session", "s3ss10n-value");
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(4000);
