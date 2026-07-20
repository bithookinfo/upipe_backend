import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

describe('Subscriptions API (Integration)', () => {
    let app: INestApplication;


    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe());
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    describe('Subscription Flow', () => {
        let planId: string;

        it('should list subscription plans', async () => {
            const res = await request(app.getHttpServer())
                .get('/real-subscriptions/plans')
                .expect(200);

            expect(Array.isArray(res.body.plans)).toBe(true);
            // If plans exist, grab one
            if (res.body.plans.length > 0) {
                planId = res.body.plans[0].id;
            }
        });

        const uniqueOrgId = `test-org-sub-${Date.now()}`;

        it('should create subscription', async () => {
            // Only run if we found a plan, or skip
            if (!planId) {
                console.warn('No plans found, skipping create test');
                return;
            }

            return request(app.getHttpServer())
                .post(`/real-subscriptions/organizations/${uniqueOrgId}/subscribe`)
                .send({
                    planId: planId,
                })
                .expect(201);
        });

        it('should get organization subscription', () => {
            return request(app.getHttpServer())
                .get(`/real-subscriptions/organizations/${uniqueOrgId}`)
                .expect(200);
        });
    });
});
