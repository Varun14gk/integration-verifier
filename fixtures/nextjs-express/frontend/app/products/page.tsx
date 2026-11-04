// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

"use client";

import { useEffect, useState } from "react";
import { listProducts, type Product } from "../../lib/api";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    listProducts().then(setProducts);
  }, []);

  return (
    <ul>
      {products.map((p) => (
        <li key={p.id}>
          {p.title}: {p.price}
        </li>
      ))}
    </ul>
  );
}
