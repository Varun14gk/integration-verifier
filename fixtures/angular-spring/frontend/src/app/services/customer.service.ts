// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";

export interface Customer {
  id: number;
  name: string;
}

@Injectable({ providedIn: "root" })
export class CustomerService {
  constructor(private http: HttpClient) {}

  getCustomer(id: number): Observable<Customer> {
    return this.http.get<Customer>(`/api/customers/${id}`);
  }

  rememberCustomer(customer: Customer, email: string): void {
    sessionStorage.setItem("customer_email", email);
    document.cookie = `customer_id=${customer.id}; path=/`;
  }
}
