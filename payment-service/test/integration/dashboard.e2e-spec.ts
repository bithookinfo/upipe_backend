import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

describe('Dashboard API (Integration)', () => {
    let app: INestApplication;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    describe('GET /dashboard/stats', () => {
        it('should return dashboard statistics', () => {
            return request(app.getHttpServer())
                .get('/dashboard/stats')
                .expect(200)
                .expect((res) => {
                    expect(res.body.totalOrders).toBeDefined();
                    expect(res.body.revenue).toBeDefined();
                    expect(res.body.successRate).toBeDefined();
                });
        });

        it('should filter stats by date range', () => {
            const startDate = '2024-01-01';
            const endDate = '2024-12-31';

            return request(app.getHttpServer())
                .get('/dashboard/stats')
                .query({ startDate, endDate })
                .expect(200)
                .expect((res) => {
                    expect(res.body.totalOrders).toBeGreaterThanOrEqual(0);
                });
        });

        it('should filter stats by merchant', () => {
            return request(app.getHttpServer())
                .get('/dashboard/stats')
                .query({ merchantId: 'test-merchant' })
                .expect(200);
        });
    });

    describe('GET /dashboard/recent-orders', () => {
        it('should return recent orders', () => {
            return request(app.getHttpServer())
                .get('/dashboard/recent-orders')
                .query({ limit: 10 })
                .expect(200)
                .expect((res) => {
                    expect(Array.isArray(res.body.orders)).toBe(true);
                });
        });
    });
});
