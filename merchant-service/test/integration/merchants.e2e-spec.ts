import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "../../src/app.module";

describe("Merchants API (Integration)", () => {
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

  describe("POST /merchants", () => {
    it("should create merchant", () => {
      return request(app.getHttpServer())
        .post("/merchants")
        .send({
          name: "Test Merchant",
          businessName: "Test Business",
          phone: "9876543210",
          organizationId: "test-org-id",
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.merchant).toBeDefined();
          expect(res.body.merchant.id).toBeDefined();
        });
    });
  });

  describe("GET /merchants/:id", () => {
    let merchantId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer()).post("/merchants").send({
        name: "Get Test Merchant",
        phone: "9876543211",
        organizationId: "test-org",
      });
      merchantId = res.body.merchant.id;
    });

    it("should get merchant by id", () => {
      return request(app.getHttpServer())
        .get(`/merchants/${merchantId}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.merchant.id).toBe(merchantId);
        });
    });
  });

  describe("POST /merchants/:id/sync", () => {
    it("should sync merchant transactions", () => {
      return request(app.getHttpServer())
        .post("/merchants/test-merchant/sync")
        .send({
          provider: "PAYTM",
          fromDate: "2024-01-01",
          toDate: "2024-01-31",
        })
        .expect(200);
    });
  });
});
