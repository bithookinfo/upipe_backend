import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { createHmac } from 'crypto';

describe('Orders API (Integration)', () => {
    let app: INestApplication;
    let authToken: string;
    let merchantId: string;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        await app.init();

        // Setup: Get auth token (you'll need identity service integration or mock)
        // For now, we'll assume a test token or skip auth in test mode
    });

    afterAll(async () => {
        await app.close();
    });

    describe('POST /orders', () => {
        it('should create order with valid data', () => {
            return request(app.getHttpServer())
                .post('/orders')
                .send({
                    amount: 1000,
                    currency: 'INR',
                    customerName: 'John Doe',
                    customerMobile: '9876543210',
                    merchantId: 'test-merchant-id',
                })
                .expect(201)
                .expect((res) => {
                    expect(res.body.code).toBe(2000);
                    expect(res.body.status).toBe(true);
                    expect(res.body.msg).toBeDefined();
                    expect(res.body.data).toBeDefined();
                    expect(res.body.data.payment_url).toBeDefined();
                    expect(res.body.data.order_id).toBeDefined();
                    expect(res.body.data.upi_intent).toBeDefined();
                });
        });

        it('should require amount field', () => {
            return request(app.getHttpServer())
                .post('/orders')
                .send({
                    customerName: 'John Doe',
                })
                .expect(400);
        });

        it('should validate amount is positive', () => {
            return request(app.getHttpServer())
                .post('/orders')
                .send({
                    amount: -100,
                    merchantId: 'test-merchant',
                })
                .expect(400);
        });

        it('should require either merchantId or connectorId', () => {
            return request(app.getHttpServer())
                .post('/orders')
                .send({
                    amount: 1000,
                })
                .expect(400);
        });
    });

    describe('GET /orders/:id', () => {
        let createdOrderId: string;

        beforeAll(async () => {
            // Create an order for testing
            const res = await request(app.getHttpServer())
                .post('/orders')
                .send({
                    amount: 500,
                    merchantId: 'test-merchant',
                    customerName: 'Test Customer',
                });

            createdOrderId = res.body.order.id;
        });

        it('should get order by id', () => {
            return request(app.getHttpServer())
                .get(`/orders/${createdOrderId}`)
                .expect(200)
                .expect((res) => {
                    expect(res.body.order.id).toBe(createdOrderId);
                    expect(res.body.order.amount).toBe(500);
                });
        });

        it('should return 404 for non-existent order', () => {
            return request(app.getHttpServer())
                .get('/orders/non-existent-order-id')
                .expect(404);
        });
    });

    describe('GET /orders', () => {
        it('should list orders with pagination', () => {
            return request(app.getHttpServer())
                .get('/orders')
                .query({ page: 1, limit: 10 })
                .expect(200)
                .expect((res) => {
                    expect(res.body.orders).toBeDefined();
                    expect(Array.isArray(res.body.orders)).toBe(true);
                    expect(res.body.pagination).toBeDefined();
                });
        });

        it('should filter orders by status', () => {
            return request(app.getHttpServer())
                .get('/orders')
                .query({ status: 'PENDING' })
                .expect(200)
                .expect((res) => {
                    expect(res.body.orders).toBeDefined();
                });
        });

        it('should filter orders by merchant', () => {
            return request(app.getHttpServer())
                .get('/orders')
                .query({ merchantId: 'test-merchant' })
                .expect(200);
        });
    });

    describe('DELETE /orders/:id', () => {
        let pendingOrderId: string;

        beforeEach(async () => {
            const res = await request(app.getHttpServer())
                .post('/orders')
                .send({
                    amount: 750,
                    merchantId: 'test-merchant',
                });

            pendingOrderId = res.body.order.id;
        });

        it('should delete pending order', () => {
            return request(app.getHttpServer())
                .delete(`/orders/${pendingOrderId}`)
                .expect(200);
        });

        it('should not delete completed order', async () => {
            // First complete the order (via webhook or status update)
            // Then try to delete
            // This test depends on your business logic
        });

        it('should return 404 for non-existent order', () => {
            return request(app.getHttpServer())
                .delete('/orders/non-existent-id')
                .expect(404);
        });
    });
});
