import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { ValidationPipe } from '@nestjs/common';

describe('Organizations API (Integration)', () => {
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

    describe('POST /organizations', () => {
        it('should create organization', () => {
            const orgName = `Test Org ${Date.now()}`;
            return request(app.getHttpServer())
                .post('/organizations')
                .send({
                    name: orgName,
                    slug: `test-org-${Date.now()}`,
                    ownerUserId: 'test-owner-id', // Required field
                })
                .expect((res) => {
                    if (res.status !== 201) {
                        const errorMsg = 'CREATE ORG FAILED: ' + JSON.stringify(res.body, null, 2);
                        console.error(errorMsg);
                        throw new Error(errorMsg);
                    }
                })
                .expect(201)
                .expect((res) => {
                    expect(res.body.id).toBeDefined();
                    expect(res.body.name).toBe(orgName);
                });
        });

        it('should require name', () => {
            return request(app.getHttpServer())
                .post('/organizations')
                .send({
                    slug: 'test-slug',
                })
                .expect(400);
        });
    });

    describe('GET /organizations/:id/roles', () => {
        let orgId: string;

        beforeAll(async () => {
            // Create org first (if subsequent tests need it, or assume one exists)
            // We can use the org created in previous test if we store it
        });

        it('should list roles for organization', async () => {
            // Create org
            const orgName = `Role Test Org ${Date.now()}`;
            const res = await request(app.getHttpServer())
                .post('/organizations')
                .send({ name: orgName })
                .expect(201);

            const orgId = res.body.data.id; // Controller returns { success: true, data: org }

            return request(app.getHttpServer())
                .get(`/organizations/${orgId}/roles`)
                .expect(200)
                .expect((res) => {
                    expect(Array.isArray(res.body)).toBe(true);
                });
        });
    });

    describe('POST /organizations/:id/users', () => {
        let orgId: string;

        beforeAll(async () => {
            const res = await request(app.getHttpServer())
                .post('/organizations')
                .send({ name: 'User Test Org', slug: `user-org-${Date.now()}` });
            orgId = res.body.id;
        });

        it('should add user to organization', async () => {
            // 1. Get roles for the org
            const rolesRes = await request(app.getHttpServer())
                .get(`/organizations/${orgId}/roles`)
                .expect(200);

            const roles = rolesRes.body;
            expect(roles.length).toBeGreaterThan(0);
            const roleId = roles[0].id;

            return request(app.getHttpServer())
                .post(`/organizations/${orgId}/users`)
                .send({
                    userId: 'test-user-id',
                    roleId: roleId,
                })
                .expect(201);
        });
    });
});
