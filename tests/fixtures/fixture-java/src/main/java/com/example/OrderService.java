package com.example;

import java.util.List;

public class OrderService {

    public double calculateTotal(List<OrderItem> items) {
        double total = 0;
        for (OrderItem item : items) {
            total += item.getPrice() * item.getQuantity();
        }
        return total;
    }

    public double calculateDiscount(List<OrderItem> items, String couponCode) {
        double total = calculateTotal(items);
        if (couponCode.equals("SAVE10")) {
            return total * 0.10;
        }
        if (couponCode.equals("SAVE20")) {
            return total * 0.20;
        }
        return 0;
    }

    public OrderItem findMostExpensive(List<OrderItem> items) {
        OrderItem result = null;
        for (OrderItem item : items) {
            if (result == null || item.getPrice() > result.getPrice()) {
                result = item;
            }
        }
        return result;
    }

    public List<OrderItem> getAffordableItems(List<OrderItem> items, double budget) {
        return items.stream()
                .filter(i -> i.getPrice() <= budget)
                .toList();
    }
}
