// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

package com.example.shop;

import org.springframework.web.bind.annotation.*;

@RestController
public class CustomerController {

    @GetMapping("/api/customers/{id}")
    public Customer getCustomer(@PathVariable Long id) {
        return new Customer();
    }
}
