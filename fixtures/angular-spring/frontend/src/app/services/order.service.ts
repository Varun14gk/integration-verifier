// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";

export interface Order {
  id: number;
  productId: number;
  quantity: number;
  status: string;
}

export interface NewOrder {
  productId: number;
  quantity: number;
  customerEmail: string;
}

@Injectable({ providedIn: "root" })
export class OrderService {
  constructor(private http: HttpClient) {}

  listOrders(page: number, size: number): Observable<Order[]> {
    return this.http.get<Order[]>("/api/orders", { params: { page, size } });
  }

  getOrder(id: number): Observable<Order> {
    return this.http.get<Order>(`/api/orders/${id}`);
  }

  createOrder(order: NewOrder): Observable<Order> {
    return this.http.post<Order>("/api/orders", order);
  }

  removeItem(orderId: number): Observable<void> {
    return this.http.delete<void>(`/api/orders/${orderId}/items`);
  }
}
