package com.example;

import org.junit.jupiter.api.Test;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class OrderServiceTest {

    private final OrderService service = new OrderService();

    @Test
    void calculateTotal_normal() {
        var items = List.of(
            new OrderItem("Apple", 1.5, 4),
            new OrderItem("Bread", 2.0, 2)
        );
        assertEquals(10.0, service.calculateTotal(items), 0.001);
    }

    @Test
    void calculateTotal_emptyList() {
        assertEquals(0.0, service.calculateTotal(List.of()), 0.001);
    }

    @Test
    void calculateDiscount_nullCoupon_shouldNotThrow() {
        var items = List.of(new OrderItem("Apple", 10.0, 1));
        assertDoesNotThrow(() -> service.calculateDiscount(items, null));
    }

    @Test
    void calculateDiscount_save10() {
        var items = List.of(new OrderItem("Apple", 100.0, 1));
        assertEquals(10.0, service.calculateDiscount(items, "SAVE10"), 0.001);
    }

    @Test
    void findMostExpensive_emptyList_shouldReturnNull() {
        assertNull(service.findMostExpensive(List.of()));
    }

    @Test
    void findMostExpensive_normal() {
        var items = List.of(
            new OrderItem("Apple", 1.5, 1),
            new OrderItem("Laptop", 999.0, 1),
            new OrderItem("Pen", 0.5, 1)
        );
        assertEquals("Laptop", service.findMostExpensive(items).getName());
    }
}
