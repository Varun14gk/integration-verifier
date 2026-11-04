// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

package com.example.shop;

import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
    private static final Logger log = LoggerFactory.getLogger(OrderController.class);

    @GetMapping
    public List<Order> listOrders(@RequestParam int pageNumber, @RequestParam int pageSize) {
        return List.of();
    }

    @GetMapping("/{id}")
    public Order getOrder(@PathVariable Long id) {
        return new Order();
    }

    @PostMapping
    public Order createOrder(@RequestBody CreateOrderRequest request) {
        log.info("Order placed by {}", request.getCustomerEmail());
        return new Order();
    }

    @DeleteMapping("/{orderId}/items/{itemId}")
    public void removeItem(@PathVariable Long orderId, @PathVariable Long itemId) {
    }

    @GetMapping("/export")
    public List<Order> exportOrders() {
        return List.of();
    }
}
