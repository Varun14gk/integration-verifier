// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

export interface Product {
  id: string;
  title: string;
  price: number;
}

export async function listProducts(): Promise<Product[]> {
  const res = await fetch("/api/products");
  return res.json();
}

export async function getProduct(id: string): Promise<Product> {
  const res = await fetch(`/api/products/${id}`);
  return res.json();
}

export async function getResource(resource: string, id: string): Promise<unknown> {
  const res = await fetch(`/api/${resource}/${id}`);
  return res.json();
}

export async function placeOrder(productId: string, quantity: number, cardNumber: string): Promise<void> {
  await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, quantity, cardNumber }),
  });
}

export async function login(email: string, password: string): Promise<void> {
  await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}
