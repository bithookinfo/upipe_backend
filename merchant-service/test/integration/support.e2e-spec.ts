import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "../../src/app.module";

describe("Support Tickets API (Integration)", () => {
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

  describe("POST /support/tickets", () => {
    it("should create support ticket", () => {
      return request(app.getHttpServer())
        .post("/support/tickets")
        .send({
          merchantId: "test-merchant",
          subject: "Test Ticket",
          message: "This is a test ticket",
          priority: "HIGH",
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.ticket).toBeDefined();
          expect(res.body.ticket.status).toBe("OPEN");
        });
    });

    it("should require message", () => {
      return request(app.getHttpServer())
        .post("/support/tickets")
        .send({
          merchantId: "test-merchant",
          subject: "Test Ticket",
        })
        .expect(400);
    });
  });

  describe("GET /support/tickets", () => {
    it("should list merchant tickets", () => {
      return request(app.getHttpServer())
        .get("/support/tickets")
        .query({ merchantId: "test-merchant" })
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body.tickets)).toBe(true);
        });
    });
  });
});
