// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

import { Component, Input, OnInit } from "@angular/core";
import { Customer, CustomerService } from "../services/customer.service";

@Component({
  selector: "app-customer-card",
  standalone: true,
  template: `<h2>{{ customer?.name }}</h2>`,
})
export class CustomerCardComponent implements OnInit {
  @Input() customerId!: number;
  customer?: Customer;

  constructor(private customers: CustomerService) {}

  ngOnInit(): void {
    this.customers.getCustomer(this.customerId).subscribe((c) => (this.customer = c));
  }
}
