// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

package com.example.shop;

public class CreateOrderRequest {
    private Long productId;
    private int quantity;
    private String customerEmail;

    public Long getProductId() { return productId; }
    public int getQuantity() { return quantity; }
    public String getCustomerEmail() { return customerEmail; }
}
